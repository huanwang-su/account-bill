"""Unified detail -> financial postings. Reversal preserves source facts and identity."""

import hashlib
import json
from decimal import Decimal
from .domain import Clock, DomainError
from .account_config import AccountGraph
from .bill_status import BillStatusService
from .models import (
    Account,
    Bill,
    BillLedger,
    BillClassificationHistory,
    Category,
    Entry,
    ImportRow,
    ImportBatch,
    ImportSource,
    Transaction,
    BillNetting,
    BillJournalHistory,
    RefundMatch,
)
from .services import Repository, TransactionService


class BillPostingService:
    def __init__(self, database):
        self.db = database

    @staticmethod
    def money(amount):
        return format(Decimal(amount) / 100, ".2f")

    def category(self, s, kind, path):
        from .category_catalog import CategoryCatalog
        from .classification_policy import ClassificationPolicyService

        allow_create = ClassificationPolicyService.read_in(s)["allow_new_categories"]
        return CategoryCatalog(s).resolve(kind, path, allow_create).id

    def category_path(self, s, key):
        from .category_catalog import CategoryGraph

        return CategoryGraph(s).path(key)

    def prepare_transaction(self, s, data, postings):
        """Called before creating a journal; manual entries create their detail first."""
        from .bills import BillNormalizer

        key = (
            data.get("_bill_id")
            or "manual:" + hashlib.sha256(data["idempotency_key"].encode()).hexdigest()
        )
        BillStatusService.require_normal(s, key)
        bill = s.get(Bill, key)
        if bill is None:
            source = s.query(ImportRow).filter_by(source_key=key).first()
            kind = data["kind"]
            prefix = (
                "收入"
                if kind == "INCOME"
                else "支出" if kind in ("EXPENSE", "REFUND") else "资金往来"
            )
            category_ids = {p.category_id for p in postings if p.category_id}
            path = (
                self.category_path(s, next(iter(category_ids)))
                if len(category_ids) == 1
                else [
                    (
                        "拆分记账"
                        if category_ids
                        else "内部转账" if kind == "TRANSFER" else "期初余额"
                    )
                ]
            )
            labels = {
                "category_path": ["退款"] if kind == "REFUND" else [prefix, *path],
                "tags": data.get("tags", []),
                "status": "CLASSIFIED",
                "note": "人工确认记账",
                "classified_by": "人工记账",
            }
            if source:
                facts = (
                    BillNormalizer()
                    .normalize(
                        json.loads(
                            s.get(ImportBatch, source.batch_id).metadata_json
                        ).get("parser", "alipay"),
                        [json.loads(source.data)],
                    )
                    .bills[0]
                    .facts.model_dump()
                )
            else:
                account = s.get(
                    Account, data.get("account_id") or postings[0].account_id
                )
                facts = {
                    "occurred_at": Clock.normalize(data["occurred_at"]),
                    "amount_minor": sum(p.amount for p in postings if p.amount > 0),
                    "currency": "CNY",
                    "flow": (
                        "OUT"
                        if kind == "EXPENSE"
                        else "IN" if kind in ("INCOME", "REFUND") else "UNSPECIFIED"
                    ),
                    "settlement": "REFUNDED" if kind == "REFUND" else "COMPLETED",
                    "counterparty": str(data.get("counterparty", "")),
                    "description": str(data.get("note", "")),
                    "payment_hint": account.name if account else "",
                }
            bill = Bill(
                id=key,
                facts=json.dumps(facts, ensure_ascii=False),
                classification=json.dumps(labels, ensure_ascii=False),
                revision=1,
                saved_at=Clock.now(),
            )
            s.add(bill)
            s.flush()
            s.add(
                BillClassificationHistory(
                    bill_id=key,
                    revision=1,
                    classification=bill.classification,
                    saved_at=bill.saved_at,
                )
            )
        link = s.get(BillLedger, key)
        if link and link.status == "REVERSED":
            raise DomainError("交易已撤销，重复导入不会重新入账")
        if link and link.transaction_id:
            raise DomainError("该明细已有账户流水")
        if not link:
            link = BillLedger(
                bill_id=key,
                owner_run_id=data.get("_owner_run_id"),
                status="PENDING",
                reason="",
            )
            s.add(link)
            s.flush()
        return link

    @staticmethod
    def source_state(s, bill_id, status, reason):
        for row in s.query(ImportRow).filter_by(source_key=bill_id):
            row.status = status
            row.warning = reason

    def attach_transaction(self, s, link, tx):
        link.transaction_id = tx.id
        link.status = "POSTED"
        link.reason = ""
        if not s.get(BillJournalHistory, tx.id):
            s.add(BillJournalHistory(transaction_id=tx.id, bill_id=link.bill_id))
        for row in s.query(ImportRow).filter_by(source_key=link.bill_id):
            row.transaction_id = tx.id
            row.status = "POSTED"
            row.warning = "已生成账户流水"
            old_source = s.get(ImportSource, link.bill_id)
            if old_source:
                old_source.transaction_id = tx.id
            else:
                s.add(
                    ImportSource(key=link.bill_id, transaction_id=tx.id, row_id=row.id)
                )
                s.flush()

        from .bill_associations import BillAssociationService

        BillAssociationService.sync_sources(s, link.bill_id)

    def post_auto(self, s, bill_id, run_id):
        BillStatusService.require_normal(s, bill_id)
        bill = Repository(s).require(Bill, bill_id)
        link = s.get(BillLedger, bill_id)
        if link and link.status in ("POSTED", "REVERSED", "IGNORED"):
            return "existing"
        if not link:
            link = BillLedger(
                bill_id=bill_id, owner_run_id=run_id, status="PENDING", reason=""
            )
            s.add(link)
            s.flush()
        elif link.owner_run_id is None:
            link.owner_run_id = run_id
        facts = json.loads(bill.facts)
        labels = json.loads(bill.classification)
        row = (
            s.query(ImportRow)
            .filter_by(source_key=bill_id)
            .order_by(ImportRow.id)
            .first()
        )
        decision = json.loads(row.decision) if row else {}
        reason = ""
        if facts["amount_minor"] == 0 or facts["settlement"] == "CLOSED":
            link.status, link.reason = "IGNORED", "零金额或交易关闭，不生成资金流水"
            self.source_state(s, bill_id, "IGNORED", link.reason)
            return "ignored"
        source_data = json.loads(row.data) if row else {}
        from .classification_policy import ClassificationPolicyService

        policy = ClassificationPolicyService.read_in(s)
        broad_allowed = policy["allow_broad_categories"]
        refund_income = (
            policy["unmatched_refund_income"]
            and facts["settlement"] == "REFUNDED"
            and facts["flow"] == "IN"
            and labels
            and labels["category_path"] == ["退款"]
            and not s.query(RefundMatch).filter_by(refund_id=bill_id).first()
        )
        broad = (
            labels
            and labels["category_path"][0] in ("收入", "支出")
            and labels.get("review_scope") == "CATEGORY"
        )
        if source_data.get("review_reason"):
            reason = source_data["review_reason"]
        elif facts["settlement"] != "COMPLETED" and not refund_income:
            reason = "交易状态需确认；退款需核对收款账户及原交易"
        elif not labels or (
            labels["status"] != "CLASSIFIED" and not (broad_allowed and broad)
        ):
            reason = "分类仍需复核"
        elif "&" in facts["payment_hint"] or "因公付" in facts["payment_hint"]:
            reason = "混合支付、优惠或企业付款，请确认个人实际金额"
        root = labels["category_path"][0] if labels else ""
        kind = (
            "INCOME"
            if refund_income
            else {"收入": "INCOME", "支出": "EXPENSE"}.get(root)
        )
        if not reason and not kind:
            reason = "转账或资金往来需明确转出和转入账户"
        if (
            not reason
            and facts["flow"] in ("IN", "OUT")
            and facts["flow"] != ("IN" if kind == "INCOME" else "OUT")
        ):
            reason = "分类与原始收支方向不一致"
        account = (
            AccountGraph(s).canonical(decision.get("account_id"))
            if decision.get("account_id")
            else None
        )
        if not reason and (
            not account
            or not account.active
            or account.role not in ("ASSET", "LIABILITY")
        ):
            reason = "请确认实际收付款账户"
        if reason:
            link.reason = reason
            self.source_state(s, bill_id, "REVIEW", reason)
            return "pending"
        # Nested transaction keeps a failed individual resolution free of partial categories/tags.
        try:
            with s.begin_nested():
                category = self.category(
                    s,
                    kind,
                    (
                        ["退款收入"]
                        if refund_income
                        else labels["category_path"][1:] or ["未分类"]
                    ),
                )
                self.post_resolved(
                    s,
                    bill,
                    link,
                    {
                        "kind": kind,
                        "account_id": decision.get("account_id") or account.id,
                        "category_id": category,
                        "tags": labels["tags"],
                    },
                )
            return "posted"
        except DomainError as exc:
            link.reason = str(exc)
            self.source_state(s, bill_id, "REVIEW", link.reason)
            return "pending"

    def post_resolved(self, s, bill, link, decision):
        if link.status == "REVERSED":
            raise DomainError("已撤销的明细不能重新入账")
        if link.transaction_id:
            return s.get(Transaction, link.transaction_id)
        facts = json.loads(bill.facts)
        payload = {
            k: decision[k]
            for k in (
                "kind",
                "account_id",
                "to_account_id",
                "category_id",
                "related_id",
                "tags",
                "items",
                "amount",
            )
            if k in decision
        }
        payload.update(
            occurred_at=facts["occurred_at"],
            counterparty=facts["counterparty"],
            note=facts["description"],
            source="统一交易明细",
            idempotency_key=decision.get("_posting_key", "bill:" + bill.id),
            _bill_id=bill.id,
        )
        netting = s.get(BillNetting, bill.id)
        amount = netting.net_minor if netting else facts["amount_minor"]
        if netting:
            if payload.get("kind") != "EXPENSE":
                raise DomainError("已匹配部分退款的付款必须按净支出入账")
            payload.pop("items", None)
            payload["amount"] = self.money(amount)
            payload["idempotency_key"] = (
                "bill-net:"
                + hashlib.sha256(
                    (bill.id + ":" + str(netting.refund_minor)).encode()
                ).hexdigest()
            )
        payload.setdefault("amount", self.money(amount))
        if facts["settlement"] == "REFUNDED":
            from .classification_policy import ClassificationPolicyService

            refund_income = (
                payload.get("kind") == "INCOME"
                and facts["flow"] == "IN"
                and ClassificationPolicyService.read_in(s)["unmatched_refund_income"]
                and not s.query(RefundMatch).filter_by(refund_id=bill.id).first()
                and (json.loads(bill.classification) or {}).get("category_path")
                == ["退款"]
            )
            if payload.get("kind") != "REFUND" and not refund_income:
                raise DomainError("退款账单请按退款类型入账")
            payload.pop("items", None)
            payload["category_id"] = self.category(
                s,
                "INCOME" if refund_income else "EXPENSE",
                ["退款收入"] if refund_income else ["退款"],
            )

        labels = json.loads(bill.classification)
        payload.setdefault("tags", labels["tags"] if labels else [])
        if (
            payload.get("kind") in ("INCOME", "EXPENSE", "REFUND")
            and not payload.get("category_id")
            and not payload.get("items")
        ):
            expected = "收入" if payload["kind"] == "INCOME" else "支出"
            valid = labels and (
                labels["category_path"][0] == expected
                or (payload["kind"] == "REFUND" and labels["category_path"] == ["退款"])
            )
            if not valid:
                raise DomainError("请选择明确的入账分类")
            payload["category_id"] = self.category(
                s,
                "INCOME" if expected == "收入" else "EXPENSE",
                (
                    ["退款"]
                    if payload["kind"] == "REFUND"
                    else labels["category_path"][1:]
                ),
            )
        return TransactionService(self.db).post_in(s, payload)

    def resolve(self, bill_id, decision):
        with self.db.write() as s:
            BillStatusService.require_normal(s, bill_id)
            bill = Repository(s).require(Bill, bill_id)
            link = s.get(BillLedger, bill_id)
            if link is None:
                link = BillLedger(bill_id=bill_id, status="PENDING", reason="")
                s.add(link)
                s.flush()
            if link.status != "PENDING":
                raise DomainError("仅待核对记录可以确认入账")
            tx = self.post_resolved(s, bill, link, decision)
            return {"transaction_id": tx.id}

    def update_classification(self, s, bill, labels):
        link = s.get(BillLedger, bill.id)
        if not link or link.status != "POSTED":
            return
        tx = s.get(Transaction, link.transaction_id)
        if tx.kind in ("INCOME", "EXPENSE", "REFUND"):
            expected = "收入" if tx.kind == "INCOME" else "支出"
            refund_income = (
                tx.kind == "INCOME"
                and json.loads(bill.facts)["settlement"] == "REFUNDED"
                and labels["category_path"] == ["退款"]
            )
            if labels["category_path"][0] != expected and not (
                (tx.kind == "REFUND" and labels["category_path"] == ["退款"])
                or refund_income
            ):
                raise DomainError(
                    "已入账交易不能通过修改分类改变收支类型，请修改或撤销交易"
                )
            entries = (
                s.query(Entry)
                .filter(Entry.transaction_id == tx.id, Entry.category_id != None)
                .all()
            )
            if len({e.category_id for e in entries}) > 1:
                raise DomainError("拆分交易请在账户流水中修改各项分类")
            category = self.category(
                s,
                "INCOME" if expected == "收入" else "EXPENSE",
                (
                    ["退款收入"]
                    if refund_income
                    else (
                        ["退款"] if tx.kind == "REFUND" else labels["category_path"][1:]
                    )
                ),
            )
            for entry in entries:
                entry.category_id = category
        tx.tags = Repository(s).tag_values(labels["tags"], "TRANSACTION")

    def reverse_in(self, s, bill_id):
        from .models import BillAssociation

        association = s.get(BillAssociation, bill_id)
        if association:
            return self.reverse_in(s, association.target_id)
        from .models import TransferMatch

        mirror = s.query(TransferMatch).filter_by(incoming_id=bill_id).first()
        if mirror:
            return self.reverse_in(s, mirror.outgoing_id)
        Repository(s).require(Bill, bill_id)
        link = s.get(BillLedger, bill_id)
        if link and link.status == "REVERSED":
            return False
        if not link:
            link = BillLedger(bill_id=bill_id, status="PENDING", reason="")
            s.add(link)
        if link.transaction_id:
            tx = s.get(Transaction, link.transaction_id)
            if tx.status == "POSTED":
                TransactionService(self.db)._reverse(s, tx)
        link.status = "REVERSED"
        link.reason = "已撤销，保留明细与原始文件"
        link.revoked_at = Clock.now()
        self.source_state(s, bill_id, "REVERSED", link.reason)
        for association in s.query(BillAssociation).filter_by(target_id=bill_id):
            child = s.get(BillLedger, association.source_id)
            if child:
                child.status, child.reason, child.revoked_at = (
                    "REVERSED",
                    "关联交易已撤销，凭证保留",
                    Clock.now(),
                )
                self.source_state(s, child.bill_id, "REVERSED", child.reason)
        return True

    def reverse(self, bill_id):
        with self.db.write() as s:
            return {"reversed": self.reverse_in(s, bill_id)}

    def backfill(self):
        """Connect historical journals without changing their entries or balances."""
        from .domain import Posting

        with self.db.write() as s:
            for tx in s.query(Transaction).filter(Transaction.kind != "REVERSAL").all():
                if s.get(BillJournalHistory, tx.id):
                    continue
                source = s.query(ImportSource).filter_by(transaction_id=tx.id).first()
                postings = [
                    Posting(e.account_id, e.amount, e.category_id)
                    for e in s.query(Entry).filter_by(transaction_id=tx.id)
                ]
                data = {
                    k: getattr(tx, k)
                    for k in (
                        "kind",
                        "idempotency_key",
                        "occurred_at",
                        "counterparty",
                        "note",
                    )
                }
                data["tags"] = json.loads(tx.tags)
                if source:
                    data["_bill_id"] = source.key
                link = self.prepare_transaction(s, data, postings)
                link.transaction_id = tx.id
                link.status = tx.status
                link.reason = "历史流水关联"
                if not s.get(BillJournalHistory, tx.id):
                    s.add(
                        BillJournalHistory(transaction_id=tx.id, bill_id=link.bill_id)
                    )
