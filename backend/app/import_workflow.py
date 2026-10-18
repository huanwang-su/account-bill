"""Archive -> normalize -> classify offline -> explicitly publish, with atomic deduplication."""

import hashlib
import json
from pathlib import Path
from pydantic import ValidationError
from .bills import BillDocument, BillNormalizer, BillService, BillClassification
from .domain import Clock, DomainError
from .bill_posting import BillPostingService
from .bill_status import BillStatusService
from .importers import ImportService
from .models import (
    Bill,
    ImportBatch,
    ImportRow,
    BillImportRun,
    BillImportArtifact,
    BillLedger,
    BillDisposition,
    Transaction,
)


class ImportArtifactStore:
    def add(self, s, run_id, stage, filename, content):
        artifact = BillImportArtifact(
            run_id=run_id,
            stage=stage,
            filename=Path(filename).name,
            content=content,
            digest=hashlib.sha256(content).hexdigest(),
            created_at=Clock.now(),
        )
        s.add(artifact)
        s.flush()
        return artifact

    def latest(self, s, run_id, stage):
        return (
            s.query(BillImportArtifact)
            .filter_by(run_id=run_id, stage=stage)
            .order_by(BillImportArtifact.id.desc())
            .first()
        )

    def document(self, s, run_id, stage):
        artifact = self.latest(s, run_id, stage)
        if artifact is None:
            raise DomainError("该阶段尚无文件")
        if not artifact.content:
            raise DomainError("历史文件未包含在账本备份中，请重新上传原账单后处理")
        return BillDocument.read(artifact.content)


class BillImportWorkflow:
    def __init__(self, database):
        self.db = database
        self.imports = ImportService(database)
        self.bills = BillService(database)
        self.artifacts = ImportArtifactStore()
        self.normalizer = BillNormalizer()
        self.posting = BillPostingService(database)

    @staticmethod
    def _run(s, run_id):
        run = s.get(BillImportRun, run_id)
        if run is None:
            raise DomainError("导入批次不存在")
        return run

    def stage(self, content, filename, provider="auto", start_at=None):
        """Keep failed originals too. No staged record becomes a visible bill."""
        start_at = Clock.normalize(start_at) if start_at is not None else None
        batch_id = None
        existing = False
        doc = None
        error = ""
        summary = {}
        try:
            provider = (
                self.imports.registry.detect(content, filename)
                if provider == "auto"
                else provider
            )
            parsed = self.imports.registry.get(provider).parse(content, filename)
            summary = {
                "source_count": len(parsed.rows),
                "provider": provider,
                "provider_label": parsed.metadata.get("provider_label", "支付宝"),
                "identity_basis": parsed.metadata.get(
                    "identity_basis", "支付宝交易订单号"
                ),
                "warnings": parsed.metadata.get("warnings", []),
            }
            selected = [
                row
                for row in parsed.rows
                if not start_at or row["occurred_at"] >= start_at or row.get("error")
            ]
            if start_at:
                summary.update(
                    start_at=start_at,
                    excluded_before_start=len(parsed.rows) - len(selected),
                )
                summary["warnings"] = [
                    *summary["warnings"],
                    f"仅导入 {start_at} 起的记录（含）；原文件完整保留，此前 {len(parsed.rows)-len(selected)} 条不转交易明细",
                ]
            doc = self.normalizer.normalize(provider, selected)
            errors = [
                {"line": r["line"], "error": r["error"]}
                for r in selected
                if r.get("error")
            ]
            summary.update(
                normalized_count=len(doc.bills),
                ignored_bill_count=sum(r.bill_status == "IGNORED" for r in doc.bills),
                conversion_errors=errors,
                repeated_in_file=len(selected) - len(errors) - len(doc.bills),
                missing_transaction_ids=sum(not r.get("order_id") for r in parsed.rows),
            )
            # Source registration is separate from publishing unified bills.
            batch = self.imports.upload(content, filename, provider, start_at=start_at)
            batch_id, existing = batch["id"], batch["existing"]
            if errors:
                error = f"{len(errors)} 行解析失败，请核对原文件后重新导入"
        except DomainError as exc:
            error = str(exc)
        except ValidationError:
            error = "转换后的记录超出统一账单格式限制，请拆分或核对原文件"
        with self.db.write() as s:
            if doc is not None:
                from .classification_policy import ClassificationPolicyService
                from .source_observations import SourceObservationReconciler

                doc.ai_reference = ClassificationPolicyService.reference_in(s)
                observations = SourceObservationReconciler.reconcile(s, provider, doc)
                if observations:
                    summary["source_observation_count"] = len(observations)
                    summary["warnings"].append(
                        f"{len(observations)} 条已存在流水有后续状态、退款标记或亲属卡视角补充，保留原交易事实及新增来源说明，不重复入账"
                    )
                for record in doc.bills:
                    if BillStatusService.excluded(s, record.id):
                        previous = s.get(Bill, record.id)
                        if (
                            previous
                            and json.loads(previous.facts) != record.facts.model_dump()
                        ):
                            error = "已忽略记录的原始事实发生冲突，请核对原账单"
                        record.bill_status = BillStatusService.routing(s, record.id)
                summary["ignored_bill_count"] = sum(
                    r.bill_status == "IGNORED" for r in doc.bills
                )
            run = BillImportRun(
                batch_id=batch_id,
                filename=Path(filename).name,
                created_at=Clock.now(),
                status="ERROR" if error else "NORMALIZED",
                error=error,
                summary=json.dumps(summary, ensure_ascii=False),
            )
            s.add(run)
            s.flush()
            self.artifacts.add(s, run.id, "ORIGINAL", filename, content)
            if doc is not None and observations:
                self.artifacts.add(
                    s,
                    run.id,
                    "SOURCE_OBSERVATIONS",
                    "来源补充说明.json",
                    json.dumps(observations, ensure_ascii=False, indent=2).encode(),
                )
            if doc is not None:
                self.artifacts.add(
                    s,
                    run.id,
                    "NORMALIZED",
                    "统一账单.json",
                    doc.model_dump_json(indent=2).encode(),
                )
            result = {
                "id": batch_id,
                "run_id": run.id,
                "existing": existing,
                "status": run.status,
                "error": error,
                "conversion_errors": len(summary.get("conversion_errors", [])),
            }
        return result

    def classify(self, run_id, content, filename="AI分类账单.json"):
        doc = BillDocument.read(content)
        with self.db.write() as s:
            run = self._run(s, run_id)
            if run.status not in ("NORMALIZED", "CLASSIFIED"):
                raise DomainError("该批次不能保存分类文件，请选择尚未导入的有效批次")
            baseline = self.artifacts.document(s, run_id, "NORMALIZED")
            expected = {r.id: r for r in baseline.bills}
            if set(expected) != {r.id for r in doc.bills}:
                raise DomainError(
                    "分类文件的流水编号与本批次不一致，不能增加或遗漏记录"
                )
            for record in doc.bills:
                original = expected[record.id]
                if record.facts != original.facts or (
                    record.revision != original.revision
                    and s.get(Bill, record.id) is None
                ):
                    raise DomainError("分类文件修改了原账单事实或版本：" + record.id)
                effective_status = (
                    BillStatusService.routing(s, record.id)
                    if BillStatusService.excluded(s, record.id)
                    else original.bill_status
                )
                if (
                    "bill_status" in record.model_fields_set
                    and record.bill_status != effective_status
                ):
                    raise DomainError("分类文件不能改变账单状态")
                if effective_status == "NORMAL" and record.classification is None:
                    raise DomainError("仍有未分类记录；无法确定的记录请标为需复核")
            previous = self.artifacts.latest(s, run_id, "CLASSIFIED")
            digest = hashlib.sha256(content).hexdigest()
            if previous is None or previous.digest != digest:
                previous = self.artifacts.add(
                    s, run_id, "CLASSIFIED", filename, content
                )
            run.status = "CLASSIFIED"
            run.error = ""
            return {
                "run_id": run_id,
                "artifact_id": previous.id,
                "count": len(doc.bills),
            }

    def commit(self, run_id):
        # SQLite write transaction serializes overlapping imports and the unique Bill.id
        # is the final guard. Re-import never overwrites manual classifications.
        try:
            with self.db.write() as s:
                run = self._run(s, run_id)
                if run.status == "IMPORTED":
                    return {**json.loads(run.result), "already_imported": True}
                if run.status not in ("NORMALIZED", "CLASSIFIED"):
                    raise DomainError("请先保存本批次分类后的账单文件")
                stage = "CLASSIFIED" if run.status == "CLASSIFIED" else "NORMALIZED"
                doc = self.artifacts.document(s, run_id, stage)
                active = [
                    r
                    for r in doc.bills
                    if not BillStatusService.excluded(s, r.id)
                    and r.bill_status == "NORMAL"
                ]
                if stage == "NORMALIZED" and active:
                    raise DomainError("请先保存本批次分类后的账单文件")
                fresh_ids = {r.id for r in active if s.get(Bill, r.id) is None}
                result = self.bills.save_in_session(
                    s, BillDocument(bills=active), allow_new=True, skip_existing=True
                )
                counts = {"posted": 0, "pending": 0, "ignored": 0, "existing": 0}
                outcomes = {}
                for record in active:
                    outcome = self.posting.post_auto(s, record.id, run_id)
                    outcomes[record.id] = outcome
                from .transfer_matching import TransferMatchService

                transfer_result = TransferMatchService(self.db).auto_in(s)
                for record in active:
                    if BillStatusService.excluded(s, record.id):
                        continue
                    outcome = outcomes[record.id]
                    if outcome != "existing":
                        outcome = s.get(BillLedger, record.id).status.lower()
                    counts[outcome] += 1
                result = {
                    **counts,
                    "created": sum(
                        not BillStatusService.excluded(s, key) for key in fresh_ids
                    ),
                    "duplicates": result["unchanged"],
                    "total": len(doc.bills),
                    "ignored_bills": sum(
                        r.bill_status == "IGNORED" or BillStatusService.ignored(s, r.id)
                        for r in doc.bills
                    ),
                    "linked_bills": sum(
                        BillStatusService.routing(s, r.id) == "LINKED"
                        for r in doc.bills
                    ),
                    "already_imported": False,
                    "internal_transfers": transfer_result["matched"],
                }
                run.status = "IMPORTED"
                run.committed_at = Clock.now()
                run.result = json.dumps(result)
                run.error = ""
                return result
        except DomainError as exc:
            with self.db.write() as s:
                run = self._run(s, run_id)
                if run.status == "CLASSIFIED":
                    run.error = str(exc)
            raise

    def cancel(self, run_id):
        with self.db.write() as s:
            run = self._run(s, run_id)
            if run.status == "CANCELLED":
                return {
                    "already_cancelled": True,
                    **json.loads(run.result).get("cancellation", {}),
                }
            owned = s.query(BillLedger).filter_by(owner_run_id=run_id).all()
            # Refunds first; an external dependent refund aborts the whole cancellation.
            owned.sort(
                key=lambda link: (
                    0
                    if link.transaction_id
                    and s.get(Transaction, link.transaction_id).kind == "REFUND"
                    else 1
                )
            )
            count = 0
            for link in owned:
                from .models import BillAssociation

                association = s.get(BillAssociation, link.bill_id)
                if association and association.kind == "PAYMENT":
                    # A supporting voucher does not own the canonical bank journal.
                    continue
                count += self.posting.reverse_in(s, link.bill_id)
            result = {"reversed_details": count, "cancelled_at": Clock.now()}
            run.result = json.dumps({**json.loads(run.result), "cancellation": result})
            run.status = "CANCELLED"
            return result

    def download(self, artifact_id):
        with self.db.read() as s:
            artifact = s.get(BillImportArtifact, artifact_id)
            if artifact is None:
                raise DomainError("文件不存在")
            if not artifact.content:
                raise DomainError("历史文件未包含在账本备份中，无法下载")
            return artifact.filename, artifact.content

    def list(self):
        with self.db.read() as s:
            result = []
            for run in s.query(BillImportRun).order_by(BillImportRun.id.desc()):
                result.append(self._serialize(s, run))
            return result

    def _serialize(self, s, run):
        return {
            "id": run.id,
            "batch_id": run.batch_id,
            "filename": run.filename,
            "created_at": run.created_at,
            "status": run.status,
            "error": run.error,
            "summary": json.loads(run.summary),
            "committed_at": run.committed_at,
            "result": json.loads(run.result),
            "owned_count": s.query(BillLedger).filter_by(owner_run_id=run.id).count(),
            "artifacts": [
                {
                    "id": a.id,
                    "stage": a.stage,
                    "filename": a.filename,
                    "size": len(a.content),
                    "available": bool(a.content),
                    "digest": a.digest,
                    "created_at": a.created_at,
                }
                for a in s.query(BillImportArtifact)
                .filter_by(run_id=run.id)
                .order_by(BillImportArtifact.id)
            ],
        }

    def detail(self, run_id):
        with self.db.read() as s:
            run = self._run(s, run_id)
            result = self._serialize(s, run)
            result["files_omitted"] = any(
                not item["available"] for item in result["artifacts"]
            )
            artifact = (
                self.artifacts.latest(s, run_id, "CLASSIFICATION_UPDATE")
                or self.artifacts.latest(s, run_id, "CLASSIFIED")
                or self.artifacts.latest(s, run_id, "REFUND_PROCESSED")
                or self.artifacts.latest(s, run_id, "NORMALIZED")
            )
            sources = {}
            ignored_keys = set()
            ignored_reasons = {}
            if run.batch_id:
                for row in s.query(ImportRow).filter_by(batch_id=run.batch_id):
                    sources.setdefault(
                        row.source_key, json.loads(row.data).get("order_id", "")
                    )
                    if BillStatusService.excluded(s, row.source_key):
                        ignored_keys.add(row.source_key)
                        ignored_reasons[row.source_key] = s.get(
                            BillDisposition, row.source_key
                        ).reason
            from .refund_matching import RefundMatchService

            result["refund_matches"] = (
                RefundMatchService(self.db).candidates_in(s, run_id)["refunds"]
                if run.batch_id
                and run.status not in ("ERROR", "CANCELLED")
                and not result["files_omitted"]
                else []
            )
            from .models import RefundMatch

            result["matched_refund_pairs"] = (
                [
                    dict(
                        refund_id=m.refund_id,
                        payment_id=m.payment_id,
                        note=m.note,
                        matched_by=m.matched_by,
                    )
                    for m in s.query(RefundMatch).filter_by(batch_id=run.batch_id)
                ]
                if run.batch_id
                else []
            )
            from .models import BillAssociation

            related_ids = {a.source_id: a.target_id for a in s.query(BillAssociation)}
            result["rows"] = []
            from .models import BillNetting

            records = []
            if artifact and artifact.content:
                records = BillDocument.read(artifact.content).bills
            elif run.batch_id:
                # Current business rows remain inspectable without archived files.
                from .bills import BillFacts

                batch = s.get(ImportBatch, run.batch_id)
                provider = json.loads(batch.metadata_json).get("parser", "alipay")
                records = self.normalizer.normalize(
                    provider,
                    [
                        json.loads(source.data)
                        for source in s.query(ImportRow)
                        .filter_by(batch_id=run.batch_id)
                        .order_by(ImportRow.id)
                    ],
                ).bills
                for record in records:
                    saved = s.get(Bill, record.id)
                    if saved:
                        record.revision = saved.revision
                        record.facts = BillFacts.model_validate_json(saved.facts)
                        record.classification = (
                            BillClassification.model_validate_json(saved.classification)
                            if saved.classification != "null"
                            else None
                        )
            if records:
                for record in records:
                    if record.facts.settlement == "REFUNDED" and record.classification:
                        record.classification.category_path = ["退款"]
                    saved = s.get(Bill, record.id)
                    ledger = s.get(BillLedger, record.id)
                    netting = s.get(BillNetting, record.id)
                    result["rows"].append(
                        {
                            **record.model_dump(),
                            "effective_amount_minor": (
                                netting.net_minor
                                if netting
                                else record.facts.amount_minor
                            ),
                            "refund_amount_minor": (
                                netting.refund_minor if netting else 0
                            ),
                            "bill_status": (
                                BillStatusService.routing(s, record.id)
                                if record.id in ignored_keys
                                else record.bill_status
                            ),
                            "bill_status_reason": (ignored_reasons.get(record.id, "")),
                            "source_transaction_id": sources.get(record.id, ""),
                            "associated_bill_id": related_ids.get(record.id),
                            "ledger_status": ledger.status if ledger else "PENDING",
                            "ledger_reason": ledger.reason if ledger else "",
                            "duplicate": saved is not None,
                            "conflict": saved is not None
                            and json.loads(saved.facts) != record.facts.model_dump(),
                        }
                    )
            result["ignored_bill_count"] = sum(
                r["bill_status"] == "IGNORED" for r in result["rows"]
            )
            result["linked_bill_count"] = sum(
                r["bill_status"] == "LINKED" for r in result["rows"]
            )
            result["active_bill_count"] = (
                len(result["rows"])
                - result["ignored_bill_count"]
                - result["linked_bill_count"]
            )
            result["summary"]["ignored_bill_count"] = result["ignored_bill_count"]
            return result

    def recover_legacy(self):
        """Reconstruct labelled snapshots only for previously visible records.

        Never fabricate original bytes, and never publish a pending upload on restart.
        """
        with self.db.write() as s:
            for batch in s.query(ImportBatch):
                if s.query(BillImportRun).filter_by(batch_id=batch.id).first():
                    continue
                rows = s.query(ImportRow).filter_by(batch_id=batch.id).all()
                known = [s.get(Bill, r.source_key) for r in rows]
                if not known or not all(known):
                    continue
                provider = json.loads(batch.metadata_json).get("parser", "alipay")
                doc = self.normalizer.normalize(
                    provider, [json.loads(r.data) for r in rows]
                )
                run = BillImportRun(
                    batch_id=batch.id,
                    filename=batch.filename,
                    created_at=batch.created_at,
                    status="IMPORTED",
                    committed_at=None,
                    summary=json.dumps(
                        {
                            "source_count": len(rows),
                            "normalized_count": len(doc.bills),
                            "legacy": True,
                            "warnings": [
                                "历史批次补建：标注“历史恢复”的文件由已有数据生成，原文件校验一致后补存；原明细导入时间未单独记录。"
                            ],
                        },
                        ensure_ascii=False,
                    ),
                    result=json.dumps({"total": len(doc.bills), "legacy": True}),
                )
                s.add(run)
                s.flush()
                self.artifacts.add(
                    s,
                    run.id,
                    "NORMALIZED",
                    "统一账单-历史恢复.json",
                    doc.model_dump_json(indent=2).encode(),
                )
                for record in doc.bills:
                    bill = s.get(Bill, record.id)
                    record.classification = (
                        BillClassification.model_validate_json(bill.classification)
                        if bill.classification != "null"
                        else None
                    )
                # Re-validate recovered data rather than assuming all legacy rows classified.
                doc = BillDocument.read(doc.model_dump_json())
                if all(r.classification for r in doc.bills):
                    self.artifacts.add(
                        s,
                        run.id,
                        "CLASSIFIED",
                        "分类账单-历史恢复.json",
                        doc.model_dump_json(indent=2).encode(),
                    )

    def attach_legacy_original(self, run_id, content, filename):
        with self.db.write() as s:
            run = self._run(s, run_id)
            if not json.loads(run.summary).get("legacy"):
                raise DomainError("仅历史批次支持补存原文件")
            batch = s.get(ImportBatch, run.batch_id)
            if hashlib.sha256(content).hexdigest() != batch.digest:
                raise DomainError("文件校验值与原导入记录不一致")
            if not self.artifacts.latest(s, run_id, "ORIGINAL"):
                self.artifacts.add(s, run_id, "ORIGINAL", filename, content)
            return {"run_id": run_id}

    def attach_legacy_classified(self, run_id, content, filename):
        """Archive a real pre-upgrade classification file after verifying current facts/labels."""
        doc = BillDocument.read(content)
        with self.db.write() as s:
            run = self._run(s, run_id)
            if not json.loads(run.summary).get("legacy"):
                raise DomainError("仅历史批次支持补存分类文件")
            baseline = self.artifacts.document(s, run_id, "NORMALIZED")
            if {r.id for r in baseline.bills} != {r.id for r in doc.bills}:
                raise DomainError("分类文件编号不属于该历史批次")
            for record in doc.bills:
                saved = s.get(Bill, record.id)
                if (
                    not record.classification
                    or json.loads(saved.facts) != record.facts.model_dump()
                    or json.loads(saved.classification)
                    != record.classification.model_dump()
                ):
                    raise DomainError("分类文件与已保存的历史明细不一致")
            digest = hashlib.sha256(content).hexdigest()
            existing = (
                s.query(BillImportArtifact)
                .filter_by(run_id=run_id, stage="CLASSIFIED", digest=digest)
                .first()
            )
            if not existing:
                self.artifacts.add(s, run_id, "CLASSIFIED", filename, content)
            return {"run_id": run_id}
