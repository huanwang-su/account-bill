"""Unified detail -> financial postings. Reversal preserves source facts and identity."""

import hashlib
import json
from .domain import Clock, DomainError
from .bill_status import BillStatusService
from .models import (
    Account,
    Bill,
    BillLedger,
    BillClassificationHistory,
    ImportRow,
    ImportBatch,
    ImportSource,
    BillJournalHistory,
)


class BillJournalLink:
    """Bill identity and posting history used by all journal producers."""

    def __init__(self, database):
        self.db = database

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
        from .bill_states import BillStates

        link.transaction_id = tx.id
        BillStates.posting(link, "POSTED")
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
