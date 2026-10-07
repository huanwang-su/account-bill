"""Exact-amount candidate selection, offline AI decisions and audited neutralization."""

import hashlib
import json
from collections import defaultdict
from typing import Literal, Optional
from pydantic import BaseModel, ConfigDict, Field, ValidationError
from .bills import BillDocument, BillClassification
from .domain import Clock, DomainError
from .models import (
    Bill,
    BillClassificationHistory,
    BillDisposition,
    BillImportRun,
    BillLedger,
    ImportRow,
    RefundMatch,
    BillNetting,
    Transaction,
)
from .bill_posting import BillPostingService
from .bill_status import BillStatusService
from .classification_policy import ClassificationPolicyService


class RefundDecision(BaseModel):
    model_config = ConfigDict(extra="forbid")
    refund_id: str
    payment_id: Optional[str] = None
    decision: Literal["MATCHED", "UNMATCHED"]
    note: str = Field(min_length=1, max_length=1000)
    matched_by: str = Field(min_length=1, max_length=80)


class RefundReviewDocument(BaseModel):
    model_config = ConfigDict(extra="forbid")
    schema_version: Literal["local-ledger.refund-matches.v1"] = (
        "local-ledger.refund-matches.v1"
    )
    run_id: int
    candidates_digest: str
    decisions: list[RefundDecision] = Field(max_length=20000)


class RefundMatchService:
    def __init__(self, database):
        self.db = database

    @staticmethod
    def canonical_bytes(value):
        return json.dumps(
            value, ensure_ascii=False, sort_keys=True, separators=(",", ":")
        ).encode()

    @staticmethod
    def normalize_label(labels, facts):
        if labels and facts["settlement"] == "REFUNDED":
            return {**labels, "category_path": ["退款"]}
        return labels

    def _source(self, session, run_id):
        from .import_workflow import ImportArtifactStore

        run = session.get(BillImportRun, run_id)
        if not run or not run.batch_id or run.status in ("ERROR", "CANCELLED"):
            raise DomainError("请选择有效且未撤销的账单批次")
        doc = ImportArtifactStore().document(session, run_id, "NORMALIZED")
        sources = {
            r.source_key: json.loads(r.data)
            for r in session.query(ImportRow).filter_by(batch_id=run.batch_id)
        }
        return run, doc, sources

    def candidates_in(self, session, run_id):
        run, doc, sources = self._source(session, run_id)
        payments = defaultdict(list)
        refunds = []

        def brief(record):
            raw = sources.get(record.id, {})
            return dict(
                id=record.id,
                facts=record.facts.model_dump(),
                source_transaction_id=raw.get("order_id", ""),
                source_description=raw.get("note", ""),
                operator=raw.get("operator", ""),
                counterparty_account=raw.get("counterparty_account", ""),
                source_line=raw.get("line"),
                balance_minor=raw.get("balance"),
                original_fields=raw.get("raw", {}),
            )

        for record in doc.bills:
            facts = record.facts
            if (
                facts.settlement == "REFUNDED"
                and facts.flow == "IN"
                and facts.amount_minor > 0
            ):
                refunds.append(record)
            elif (
                facts.flow == "OUT"
                and facts.settlement not in ("CLOSED", "REFUNDED")
                and facts.amount_minor > 0
            ):
                payments[facts.currency].append(record)
        result = []
        for refund in refunds:
            matches = [
                brief(p)
                for p in payments[refund.facts.currency]
                if p.facts.occurred_at <= refund.facts.occurred_at
                and p.facts.amount_minor >= refund.facts.amount_minor
            ]
            result.append(dict(refund=brief(refund), payments=matches))
        payload = dict(
            schema_version="local-ledger.refund-candidates.v1",
            run_id=run.id,
            filename=run.filename,
            rule="同一原始文件、同币种；付款金额不小于单笔退款且不晚于退款；由 Codex 根据订单、商户、商品等证据匹配。支持一笔付款多次退款，累计退款不得超过付款；全额双方忽略，部分退款保留一笔净支出并忽略退款",
            ai_reference=ClassificationPolicyService.read_in(session),
            refunds=result,
        )
        payload["candidates_digest"] = hashlib.sha256(
            self.canonical_bytes(payload)
        ).hexdigest()
        return payload

    def candidates(self, run_id):
        with self.db.read() as session:
            return self.candidates_in(session, run_id)

    @staticmethod
    def normalize_existing_labels(session, doc):
        count = 0
        for record in doc.bills:
            bill = session.get(Bill, record.id)
            if not bill or record.facts.settlement != "REFUNDED":
                continue
            labels = json.loads(bill.classification)
            normalized = RefundMatchService.normalize_label(
                labels, record.facts.model_dump()
            )
            if normalized != labels:
                BillPostingService(None).update_classification(
                    session, bill, normalized
                )
                bill.classification = json.dumps(
                    normalized, ensure_ascii=False, sort_keys=True
                )
                bill.revision += 1
                bill.saved_at = Clock.now()
                session.add(
                    BillClassificationHistory(
                        bill_id=bill.id,
                        revision=bill.revision,
                        classification=bill.classification,
                        saved_at=bill.saved_at,
                    )
                )
                count += 1
        return count

    def apply(self, run_id, content, filename="AI退款匹配结果.json"):
        from .import_workflow import ImportArtifactStore

        try:
            review = RefundReviewDocument.model_validate_json(content)
        except (ValidationError, ValueError):
            raise DomainError("退款匹配文件格式错误") from None
        if review.run_id != run_id:
            raise DomainError("退款匹配文件的批次编号不一致")
        with self.db.write() as session:
            run, doc, _ = self._source(session, run_id)
            candidates = self.candidates_in(session, run_id)
            if review.candidates_digest != candidates["candidates_digest"]:
                raise DomainError("候选文件校验值不一致，请重新下载本批次候选")
            allowed = {
                row["refund"]["id"]: {p["id"] for p in row["payments"]}
                for row in candidates["refunds"]
            }
            if len({d.refund_id for d in review.decisions}) != len(
                review.decisions
            ) or set(allowed) != {d.refund_id for d in review.decisions}:
                raise DomainError("必须为每条退款返回唯一匹配决定，不能增加或遗漏退款")
            matched = []
            already = 0
            for decision in review.decisions:
                if decision.decision == "UNMATCHED":
                    if decision.payment_id is not None:
                        raise DomainError("未匹配退款不能指定付款")
                    continue
                if (
                    not decision.payment_id
                    or decision.payment_id not in allowed[decision.refund_id]
                ):
                    raise DomainError("付款不属于本文件的候选，或付款金额小于退款")
                old = (
                    session.query(RefundMatch)
                    .filter_by(refund_id=decision.refund_id)
                    .first()
                )
                if old:
                    if old.payment_id != decision.payment_id:
                        raise DomainError("该退款已有不同匹配，不能覆盖")
                    already += 1
                    continue
                matched.append(decision)
            by_id = {r.id: r for r in doc.bills}
            totals = defaultdict(int)
            for old in session.query(RefundMatch).filter_by(batch_id=run.batch_id):
                totals[old.payment_id] += by_id[old.refund_id].facts.amount_minor
            for decision in matched:
                refund_link = session.get(BillLedger, decision.refund_id)
                if refund_link and refund_link.status == "REVERSED":
                    raise DomainError("已撤销退款不能通过匹配重新处理")
                totals[decision.payment_id] += by_id[
                    decision.refund_id
                ].facts.amount_minor
            affected = {d.payment_id for d in matched}
            if any(
                BillStatusService.routing(session, key) == "LINKED" for key in affected
            ):
                raise DomainError("凭证已关联交易，请在关联的主交易处理退款")
            from .account_config import AccountGraph

            graph = AccountGraph(session)

            def funding(key):
                row = (
                    session.query(ImportRow)
                    .filter_by(batch_id=run.batch_id, source_key=key)
                    .first()
                )
                key = json.loads(row.decision).get("account_id") if row else None
                return graph.canonical(key).id if key else None

            def confirmed_account(key):
                link = session.get(BillLedger, key)
                if not link or link.status != "POSTED" or not link.transaction_id:
                    return funding(key)
                from .models import Entry

                ids = {
                    graph.canonical(e.account_id).id
                    for e in session.query(Entry).filter_by(
                        transaction_id=link.transaction_id
                    )
                    if graph.canonical(e.account_id).role != "SYSTEM"
                }
                return next(iter(ids)) if len(ids) == 1 else None

            for payment_id in affected:
                if totals[payment_id] > by_id[payment_id].facts.amount_minor:
                    raise DomainError("累计退款不能超过原付款金额")
                link = session.get(BillLedger, payment_id)
                if link and link.status == "REVERSED":
                    raise DomainError("已撤销付款不能通过退款匹配重新入账")
                if (
                    link
                    and link.transaction_id
                    and link.status == "POSTED"
                    and session.get(Transaction, link.transaction_id).kind != "EXPENSE"
                ):
                    raise DomainError("已入账付款不是支出，不能合并退款")
                if link and link.transaction_id and link.status == "POSTED":
                    from .models import Entry

                    expense_amount = sum(
                        e.amount
                        for e in session.query(Entry).filter_by(
                            transaction_id=link.transaction_id
                        )
                        if e.category_id and e.amount > 0
                    )
                    prior = session.get(BillNetting, payment_id)
                    expected = (
                        prior.net_minor
                        if prior
                        else by_id[payment_id].facts.amount_minor
                    )
                    if expense_amount != expected:
                        raise DomainError(
                            "实际入账金额与付款金额不一致，请先核对再匹配退款"
                        )
                for d in matched:
                    if d.payment_id == payment_id and (
                        funding(payment_id) is None
                        or funding(payment_id) != funding(d.refund_id)
                        or confirmed_account(payment_id) != funding(payment_id)
                        or confirmed_account(d.refund_id) != funding(d.refund_id)
                    ):
                        raise DomainError(
                            "退款与付款账户不一致或未确认，不能合并为净支出"
                        )
            # Reverse refunds first; their dependent journals must not block payment reversal.
            posting = BillPostingService(self.db)
            keys = [d.refund_id for d in matched]
            reason = "退款已匹配原付款，经 AI 确认；由原付款按累计退款计算净支出"
            reversed_count = 0
            for key in keys:
                if session.get(Bill, key):
                    link = session.get(BillLedger, key)
                    if link and link.transaction_id and link.status == "POSTED":
                        reversed_count += 1
                    posting.reverse_in(session, key)
                state = session.get(BillDisposition, key)
                if not state:
                    state = BillDisposition(source_key=key)
                    session.add(state)
                state.status, state.reason, state.changed_at = (
                    "IGNORED",
                    reason,
                    Clock.now(),
                )
                for raw in session.query(ImportRow).filter_by(source_key=key):
                    raw.status, raw.warning = "IGNORED", reason
                session.flush()
            for payment_id in affected:
                record = by_id[payment_id]
                original, refunded = record.facts.amount_minor, totals[payment_id]
                net = original - refunded
                adjustment = session.get(BillNetting, payment_id)
                if not adjustment:
                    adjustment = BillNetting(payment_id=payment_id)
                    session.add(adjustment)
                (
                    adjustment.original_minor,
                    adjustment.refund_minor,
                    adjustment.net_minor,
                    adjustment.updated_at,
                ) = (original, refunded, net, Clock.now())
                saved = session.get(Bill, payment_id)
                link = session.get(BillLedger, payment_id)
                was_posted = link and link.status == "POSTED"
                previous_transaction_id = link.transaction_id if was_posted else None
                if was_posted:
                    posting.reverse_in(session, payment_id)
                    reversed_count += 1
                if net == 0:
                    if saved and not was_posted:
                        posting.reverse_in(session, payment_id)
                    state = session.get(BillDisposition, payment_id)
                    if not state:
                        state = BillDisposition(source_key=payment_id)
                        session.add(state)
                    state.status, state.reason, state.changed_at = (
                        "IGNORED",
                        "同一账单内累计退款等于付款，经 AI 确认，全额退款双方忽略",
                        Clock.now(),
                    )
                    posting.source_state(session, payment_id, "IGNORED", state.reason)
                    keys.append(payment_id)
                elif saved:
                    if link and was_posted:
                        link.status, link.transaction_id, link.revoked_at = (
                            "PENDING",
                            None,
                            None,
                        )
                    session.flush()
                    outcome = posting.post_auto(
                        session, payment_id, link.owner_run_id if link else run_id
                    )
                    if was_posted and outcome != "posted":
                        # Retain manually confirmed expense category when its AI label is broad.
                        old_tx = session.get(Transaction, previous_transaction_id)
                        from .models import Entry

                        category = (
                            session.query(Entry)
                            .filter(
                                Entry.transaction_id == old_tx.id,
                                Entry.category_id != None,
                            )
                            .first()
                            if old_tx
                            else None
                        )
                        if category:
                            posting.post_resolved(
                                session,
                                saved,
                                link,
                                dict(
                                    kind="EXPENSE",
                                    account_id=funding(payment_id),
                                    category_id=category.category_id,
                                ),
                            )
                        else:
                            raise DomainError("原支出缺少入账分类，不能自动调整净额")
            for decision in matched:
                session.add(
                    RefundMatch(
                        run_id=run_id,
                        batch_id=run.batch_id,
                        refund_id=decision.refund_id,
                        payment_id=decision.payment_id,
                        note=decision.note,
                        matched_by=decision.matched_by,
                        created_at=Clock.now(),
                    )
                )
            self.normalize_existing_labels(session, doc)
            # Original and previous classification bytes remain immutable.
            by_id = {r.id: r for r in doc.bills}
            for record in by_id.values():
                saved = session.get(Bill, record.id)
                if saved:
                    record.revision = saved.revision
                    labels = json.loads(saved.classification)
                    record.classification = (
                        BillClassification(**labels) if labels else None
                    )
                record.bill_status = (
                    BillStatusService.routing(session, record.id)
                    if BillStatusService.excluded(session, record.id)
                    else record.bill_status
                )
                if record.facts.settlement == "REFUNDED" and record.classification:
                    record.classification.category_path = ["退款"]
            store = ImportArtifactStore()

            def archive(stage, name, data):
                digest = hashlib.sha256(data).hexdigest()
                latest = store.latest(session, run_id, stage)
                return (
                    latest
                    if latest and latest.digest == digest
                    else store.add(session, run_id, stage, name, data)
                )

            archive(
                "REFUND_CANDIDATES",
                "退款金额候选.json",
                json.dumps(candidates, ensure_ascii=False, indent=2).encode(),
            )
            result_artifact = archive("REFUND_MATCHES", filename, content)
            archive(
                "REFUND_NETTING",
                "退款净额计算.json",
                json.dumps(
                    [
                        dict(
                            payment_id=p,
                            original_minor=by_id[p].facts.amount_minor,
                            refund_minor=total,
                            net_minor=by_id[p].facts.amount_minor - total,
                        )
                        for p, total in totals.items()
                    ],
                    ensure_ascii=False,
                    indent=2,
                ).encode(),
            )
            working = archive(
                "REFUND_PROCESSED",
                "退款处理后统一账单.json",
                doc.model_dump_json(indent=2).encode(),
            )
            run.error = ""
            return dict(
                run_id=run_id,
                matched_pairs=len(matched),
                already_matched_pairs=already,
                ignored_bills=len(keys),
                reversed_transactions=reversed_count,
                unmatched_refunds=sum(
                    d.decision == "UNMATCHED" for d in review.decisions
                ),
                artifact_id=result_artifact.id,
                working_artifact_id=working.id,
                partial_payments=sum(
                    totals[p] < by_id[p].facts.amount_minor for p in affected
                ),
            )

    def matches(self, run_id):
        with self.db.read() as session:
            run, _, _ = self._source(session, run_id)
            return [
                dict(
                    refund_id=m.refund_id,
                    payment_id=m.payment_id,
                    note=m.note,
                    matched_by=m.matched_by,
                    created_at=m.created_at,
                )
                for m in session.query(RefundMatch).filter_by(batch_id=run.batch_id)
            ]
