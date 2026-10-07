"""Offline pipeline: source adapter -> immutable unified facts -> classification file.

There is deliberately no model SDK, prompt execution, credential or network client.
Codex edits only `classification`; this service validates and persists the result.
"""

from abc import ABC, abstractmethod
from typing import Literal, Optional
import json
from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StrictInt,
    ValidationError,
    field_validator,
)
from .domain import Clock, DomainError, Money
from .account_config import AccountGraph, AccountGroupService
from .models import (
    Bill,
    BillClassificationHistory,
    ImportRow,
    ImportBatch,
    Account,
    BillLedger,
    BillDisposition,
    Transaction,
    Entry,
    BillNetting,
    BillAssociation,
    TransferMatch,
)


class BillFacts(BaseModel):
    model_config = ConfigDict(extra="forbid")
    occurred_at: str = Field(max_length=32)
    amount_minor: StrictInt = Field(ge=0, le=Money.MAX)
    currency: Literal["CNY"] = "CNY"
    flow: Literal["IN", "OUT", "UNSPECIFIED"]
    settlement: Literal[
        "COMPLETED", "AWAITING_RECEIPT", "REFUNDED", "CLOSED", "UNKNOWN"
    ]
    counterparty: str = Field(max_length=2000)
    description: str = Field(max_length=10000)
    payment_hint: str = Field(max_length=2000)

    @field_validator("occurred_at")
    @classmethod
    def valid_time(cls, value):
        return Clock.normalize(value)


class BillClassification(BaseModel):
    model_config = ConfigDict(extra="forbid")
    category_path: list[str] = Field(min_length=1, max_length=5)
    tags: list[str] = Field(default_factory=list, max_length=12)
    status: Literal["CLASSIFIED", "NEEDS_REVIEW"]
    review_scope: Literal[
        "CATEGORY", "TRANSACTION", "ACCOUNT", "AMOUNT", "DUPLICATE", "UNSPECIFIED"
    ] = "UNSPECIFIED"
    note: str = Field(default="", max_length=1000)
    classified_by: str = Field(min_length=1, max_length=80)

    @field_validator("category_path", "tags")
    @classmethod
    def clean_labels(cls, values, info):
        if any(not v.strip() or len(v) > 40 for v in values):
            raise ValueError("分类和标签名称需为 1–40 字")
        clean = [v.strip() for v in values]
        return list(dict.fromkeys(clean)) if info.field_name == "tags" else clean


class BillRecord(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str = Field(min_length=1, max_length=200)
    revision: StrictInt = Field(default=0, ge=0)
    bill_status: Literal["NORMAL", "IGNORED", "LINKED"] = "NORMAL"
    facts: BillFacts
    classification: Optional[BillClassification] = None


class BillDocument(BaseModel):
    model_config = ConfigDict(extra="forbid")
    schema_version: Literal["local-ledger.bills.v1"] = "local-ledger.bills.v1"
    bills: list[BillRecord] = Field(max_length=20000)
    ai_reference: Optional[dict] = None

    @classmethod
    def read(cls, content):
        try:
            doc = cls.model_validate_json(content)
            if len({b.id for b in doc.bills}) != len(doc.bills):
                raise DomainError("统一账单中有重复编号")
            return doc
        except ValidationError as e:
            first = e.errors(include_input=False)[0]
            raise DomainError(
                "统一账单格式错误："
                + ".".join(map(str, first["loc"]))
                + " — "
                + first["msg"]
            ) from None
        except DomainError:
            raise
        except (ValueError, TypeError):
            raise DomainError("无法读取统一账单 JSON") from None


class BillAdapter(ABC):
    @abstractmethod
    def normalize(self, source_row: dict) -> BillRecord: ...


class AlipayBillAdapter(BillAdapter):
    """Only this boundary understands Alipay's field values and status names."""

    def normalize(self, d):
        if d.get("error"):
            raise DomainError("原始账单存在解析错误，不能转为有效统一账单")
        states = {
            "交易成功": "COMPLETED",
            "支付成功": "COMPLETED",
            "代付成功": "COMPLETED",
            "等待确认收货": "AWAITING_RECEIPT",
            "退款成功": "REFUNDED",
            "交易关闭": "CLOSED",
        }
        return BillRecord(
            id=d["source_key"],
            bill_status="IGNORED" if d["direction"] == "不计收支" else "NORMAL",
            facts=BillFacts(
                occurred_at=d["occurred_at"],
                amount_minor=d["amount"],
                flow={"收入": "IN", "支出": "OUT"}.get(d["direction"], "UNSPECIFIED"),
                settlement=states.get(d["status"], "UNKNOWN"),
                counterparty=d["counterparty"],
                description=d["note"],
                payment_hint=d["method"],
            ),
        )


class StandardBillAdapter(BillAdapter):
    """New parsers map provider semantics before this shared normalization boundary."""

    def normalize(self, row):
        record = AlipayBillAdapter().normalize(row)
        # Only the ordinary Alipay statement has the user-defined ignore rule.
        record.bill_status = "NORMAL"
        return record


class BillNormalizer:
    def __init__(self):
        self.adapters = {
            "alipay": AlipayBillAdapter(),
            **{
                name: StandardBillAdapter()
                for name in ("wechat", "alipay_pouch", "cmb", "boc")
            },
        }

    def normalize(self, provider, rows):
        if provider not in self.adapters:
            raise DomainError("尚未支持该来源的统一格式转换")
        result = {}
        for row in rows:
            if row.get("error"):
                continue
            record = self.adapters[provider].normalize(row)
            if record.id in result and record.facts != result[record.id].facts:
                raise DomainError("同一外部事件存在不同内容，请核对原文件")
            result[record.id] = record
        return BillDocument(bills=list(result.values()))


class BillService:
    def __init__(self, database):
        self.db = database

    @staticmethod
    def _json(value):
        return json.dumps(value, ensure_ascii=False, sort_keys=True)

    def sync_imports(self):
        """Backfill old records without overwriting any existing bill or classification."""
        with self.db.write() as s:
            existing = {b.id for b in s.query(Bill)}
            batches = {
                b.id: json.loads(b.metadata_json).get("parser", "alipay")
                for b in s.query(ImportBatch)
            }
            added = 0
            for row in s.query(ImportRow).order_by(ImportRow.id):
                if row.source_key in existing:
                    continue
                data = json.loads(row.data)
                doc = BillNormalizer().normalize(batches[row.batch_id], [data])
                for record in doc.bills:
                    if record.bill_status == "IGNORED":
                        continue
                    s.add(
                        Bill(
                            id=record.id,
                            facts=self._json(record.facts.model_dump()),
                            classification="null",
                            revision=0,
                            saved_at=Clock.now(),
                        )
                    )
                    existing.add(record.id)
                    added += 1
            return added

    def save(self, document: BillDocument, *, allow_new=False):
        """Atomic merge. Classification may update posting categories, never source facts or amounts."""
        document = BillDocument.read(document.model_dump_json())
        with self.db.write() as s:
            return self.save_in_session(s, document, allow_new=allow_new)

    def save_in_session(self, s, document, *, allow_new=False, skip_existing=False):
        result = {"created": 0, "updated": 0, "unchanged": 0}
        for record in document.bills:
            disposition = s.get(BillDisposition, record.id)
            if record.bill_status != "NORMAL" or (
                disposition and disposition.status != "NORMAL"
            ):
                raise DomainError("已忽略或已关联的账单不能独立生成或修改交易明细")
            facts = record.facts.model_dump()
            labels = (
                record.classification.model_dump() if record.classification else None
            )
            from .refund_matching import RefundMatchService

            labels = RefundMatchService.normalize_label(labels, facts)
            from .classification_policy import ClassificationPolicyService
            from .category_catalog import CategoryCatalog

            if not ClassificationPolicyService.read_in(s)["allow_new_categories"]:
                labels = CategoryCatalog(s).normalize(labels)

            bill = s.get(Bill, record.id)
            if bill:
                if json.loads(bill.facts) != facts:
                    raise DomainError("账单事实被修改，已拒绝整个文件：" + record.id)
                if (
                    skip_existing
                    or labels is None
                    or json.loads(bill.classification) == labels
                ):
                    result["unchanged"] += 1
                    continue
                if record.revision != bill.revision:
                    raise DomainError("分类版本已更新，请重新导出后修改：" + record.id)
                from .bill_posting import BillPostingService

                BillPostingService(self.db).update_classification(s, bill, labels)
                bill.classification = self._json(labels)
                bill.revision += 1
                bill.saved_at = Clock.now()
                result["updated"] += 1
            else:
                if not allow_new:
                    raise DomainError(
                        "账单编号未知，请先转换原账单；分类文件不能新增账单："
                        + record.id
                    )
                if record.revision not in (0, 1) and labels is None:
                    raise DomainError("新账单版本无效")
                bill = Bill(
                    id=record.id,
                    facts=self._json(facts),
                    classification=self._json(labels),
                    revision=1 if labels else 0,
                    saved_at=Clock.now(),
                )
                s.add(bill)
                s.flush()
                result["created"] += 1
            if labels:
                s.add(
                    BillClassificationHistory(
                        bill_id=bill.id,
                        revision=bill.revision,
                        classification=bill.classification,
                        saved_at=bill.saved_at,
                    )
                )
        return result

    def list(self, filters=None):
        f = filters or {}
        result = []
        with self.db.read() as s:
            from .taxonomy import TagHierarchy, CategoryPath

            tag_tree = TagHierarchy(s)
            from .category_catalog import CategoryGraph, CategoryCatalog

            category_graph = CategoryGraph(s)
            entry_paths = {}
            for entry in s.query(Entry).filter(Entry.category_id != None):
                category = category_graph.canonical(entry.category_id)
                path = [
                    "收入" if category.kind == "INCOME" else "支出",
                    *category_graph.path(category.id),
                ]
                if path not in entry_paths.setdefault(entry.transaction_id, []):
                    entry_paths[entry.transaction_id].append(path)
            selected_category = f.get("category")
            if selected_category and "/" in selected_category:
                parts = [v.strip() for v in selected_category.split("/") if v.strip()]
                if parts and parts[0] in ("收入", "支出"):
                    kind = "INCOME" if parts[0] == "收入" else "EXPENSE"
                    selected_category = " / ".join(
                        [
                            parts[0],
                            *category_graph.path(
                                CategoryCatalog(s).resolve(kind, parts[1:]).id
                            ),
                        ]
                    )
            sources = {}
            ledgers = {l.bill_id: l for l in s.query(BillLedger)}
            nettings = {n.payment_id: n for n in s.query(BillNetting)}
            associations = {}
            for relation in s.query(BillAssociation):
                associations.setdefault(relation.target_id, []).append(
                    relation.source_id
                )
            graph = AccountGraph(s)
            accounts = {
                a.id: graph.canonical(a.id).name for a in graph.accounts.values()
            }
            group_scope = (
                AccountGroupService.accounts_in(s, f["group_id"])
                if f.get("group_id")
                else None
            )
            for row in s.query(ImportRow).order_by(ImportRow.id):
                sources.setdefault(
                    row.source_key,
                    {
                        "row_id": row.id,
                        "source_transaction_id": json.loads(row.data).get(
                            "order_id", ""
                        ),
                        "batch_id": row.batch_id,
                        "posting_status": row.status,
                        "original_fields": json.loads(row.data),
                        "transaction_id": row.transaction_id,
                        "account_id": (
                            graph.canonical(json.loads(row.decision)["account_id"]).id
                            if json.loads(row.decision).get("account_id")
                            else None
                        ),
                        "account_name": accounts.get(
                            json.loads(row.decision).get("account_id")
                        ),
                    },
                )
            ignored = {
                d.source_key
                for d in s.query(BillDisposition).filter(
                    BillDisposition.status != "NORMAL"
                )
            }
            for bill in s.query(Bill):
                if bill.id in ignored:
                    continue
                facts = json.loads(bill.facts)
                wallet_notes = [
                    sources[key]["original_fields"].get("note", "")
                    for key in associations.get(bill.id, [])
                    if key.startswith("wechat:") and key in sources
                ]
                labels = json.loads(bill.classification)
                state = labels["status"] if labels else "UNCLASSIFIED"
                if f.get("status") and f["status"] != state:
                    continue
                if f.get("tag") and (
                    not labels or not tag_tree.matches(labels["tags"], f["tag"])
                ):
                    continue
                ledger_for_category = ledgers.get(bill.id)
                category_paths = (
                    entry_paths.get(ledger_for_category.transaction_id, [])
                    if ledger_for_category
                    else []
                )
                if not category_paths:
                    category_paths = [labels["category_path"]] if labels else []
                if selected_category and not any(
                    CategoryPath.matches(path, selected_category)
                    for path in category_paths
                ):
                    continue
                if f.get("start") and facts["occurred_at"][:10] < f["start"]:
                    continue
                if f.get("end") and facts["occurred_at"][:10] > f["end"]:
                    continue
                if (
                    f.get("q")
                    and f["q"].casefold()
                    not in (
                        facts["counterparty"]
                        + " "
                        + facts["description"]
                        + " "
                        + " ".join(wallet_notes)
                        + " "
                        + " ".join(
                            sources[key].get("source_transaction_id", "")
                            + " "
                            + sources[key]["original_fields"].get("counterparty", "")
                            for key in associations.get(bill.id, [])
                            if key in sources
                        )
                    ).casefold()
                ):
                    continue
                source = sources.get(
                    bill.id, {"posting_status": "NOT_LINKED", "transaction_id": None}
                )
                if f.get("batch_id") and source.get("batch_id") != int(f["batch_id"]):
                    continue
                ledger = ledgers.get(bill.id)
                if f.get("ledger_status") and f["ledger_status"] != (
                    ledger.status if ledger else "PENDING"
                ):
                    continue
                tx = (
                    s.get(Transaction, ledger.transaction_id)
                    if ledger and ledger.transaction_id
                    else None
                )
                financial_account = (
                    s.query(Entry)
                    .join(Account, Entry.account_id == Account.id)
                    .filter(Entry.transaction_id == tx.id, Account.role != "SYSTEM")
                    .first()
                    if tx
                    else None
                )
                effective_ids = (
                    {
                        graph.canonical(e.account_id).id
                        for e in s.query(Entry).filter_by(transaction_id=tx.id)
                        if graph.accounts[e.account_id].role != "SYSTEM"
                    }
                    if tx
                    else set()
                )
                if not effective_ids and source.get("account_id"):
                    effective_ids.add(source["account_id"])
                if group_scope is not None and not (
                    effective_ids & {graph.canonical(i).id for i in group_scope}
                ):
                    continue
                result.append(
                    {
                        "id": bill.id,
                        "revision": bill.revision,
                        "facts": facts,
                        "display_description": " · ".join(
                            dict.fromkeys([facts["description"], *wallet_notes])
                        ),
                        "effective_amount_minor": (
                            nettings[bill.id].net_minor
                            if bill.id in nettings
                            else facts["amount_minor"]
                        ),
                        "refund_amount_minor": (
                            nettings[bill.id].refund_minor if bill.id in nettings else 0
                        ),
                        "related_sources": [
                            sources[key]
                            for key in associations.get(bill.id, [])
                            if key in sources
                        ],
                        "source_count": 1 + len(associations.get(bill.id, [])),
                        "payment_channel": (
                            "微信支付"
                            if any(
                                key.startswith("wechat:")
                                for key in [bill.id, *associations.get(bill.id, [])]
                            )
                            else ""
                        ),
                        "classification": labels,
                        "category_paths": category_paths,
                        "display_category_path": (
                            category_paths[0]
                            if len(category_paths) == 1
                            else (labels["category_path"] if labels else [])
                        ),
                        "classification_status": state,
                        "saved_at": bill.saved_at,
                        **source,
                        "transaction_id": (
                            ledger.transaction_id
                            if ledger
                            else source.get("transaction_id")
                        ),
                        "ledger_status": ledger.status if ledger else "PENDING",
                        "ledger_reason": ledger.reason if ledger else "待导入并入账",
                        "revoked_at": ledger.revoked_at if ledger else None,
                        "account_name": (
                            accounts.get(financial_account.account_id)
                            if financial_account
                            else source.get("account_name")
                        ),
                        "account_id": (
                            graph.canonical(financial_account.account_id).id
                            if financial_account
                            else source.get("account_id")
                        ),
                        "account_ids": sorted(effective_ids),
                        "transaction_kind": tx.kind if tx else None,
                        "posted_amount_minor": (
                            sum(
                                e.amount
                                for e in s.query(Entry).filter_by(transaction_id=tx.id)
                                if e.amount > 0
                            )
                            if tx
                            else None
                        ),
                    }
                )
        return sorted(
            result, key=lambda b: (b["facts"]["occurred_at"], b["id"]), reverse=True
        )

    def export(self, filters=None):
        from .classification_policy import ClassificationPolicyService

        return BillDocument(
            ai_reference=ClassificationPolicyService(self.db).reference(),
            bills=[
                BillRecord(
                    id=b["id"],
                    revision=b["revision"],
                    facts=b["facts"],
                    classification=b["classification"],
                )
                for b in self.list(filters)
            ],
        )

    def history(self, bill_id):
        with self.db.read() as s:
            return [
                {
                    "revision": h.revision,
                    "classification": json.loads(h.classification),
                    "saved_at": h.saved_at,
                }
                for h in s.query(BillClassificationHistory)
                .filter_by(bill_id=bill_id)
                .order_by(BillClassificationHistory.revision)
            ]
