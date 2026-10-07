"""Bill routing rules. They precede classification, detail creation and posting."""

import json
from .domain import Clock, DomainError
from .models import (
    Bill,
    BillDisposition,
    BillLedger,
    ImportBatch,
    ImportRow,
    Transaction,
)


class BillStatusService:
    REASON = "支付宝原账单标为不计收支，忽略且不转交易明细"

    def __init__(self, database):
        self.db = database

    @staticmethod
    def ignored(session, source_key):
        state = session.get(BillDisposition, source_key)
        return bool(state and state.status == "IGNORED")

    @staticmethod
    def routing(session, source_key):
        state = session.get(BillDisposition, source_key)
        return state.status if state else "NORMAL"

    @staticmethod
    def excluded(session, source_key):
        return BillStatusService.routing(session, source_key) != "NORMAL"

    def apply_rows(self, session, rows):
        from .bill_posting import BillPostingService

        posting = BillPostingService(self.db)
        count = 0
        # Reverse refund transactions first when they refer to an ignored payment.
        ordered = sorted(rows, key=lambda r: 0 if "退款" in r.get("status", "") else 1)
        for row in ordered:
            if row.get("direction") != "不计收支":
                continue
            key = row["source_key"]
            state = session.get(BillDisposition, key)
            if state and state.status == "IGNORED":
                continue
            if session.get(Bill, key):
                posting.reverse_in(session, key)
            if not state:
                state = BillDisposition(source_key=key)
                session.add(state)
            state.status = "IGNORED"
            state.reason = self.REASON
            state.changed_at = Clock.now()
            for source in session.query(ImportRow).filter_by(source_key=key):
                source.status = "IGNORED"
                source.warning = self.REASON
            session.flush()
            count += 1
        return count

    def apply_existing(self):
        # One transaction: if a dependent external refund blocks reversal, no partial change.
        with self.db.write() as session:
            batches = {
                b.id
                for b in session.query(ImportBatch)
                if json.loads(b.metadata_json).get("parser") == "alipay"
            }
            rows = [
                json.loads(r.data)
                for r in session.query(ImportRow)
                if r.batch_id in batches
            ]
            return self.apply_rows(session, rows)

    @staticmethod
    def require_normal(session, bill_id):
        status = BillStatusService.routing(session, bill_id)
        if status != "NORMAL":
            raise DomainError(
                "账单已关联交易，不允许重复入账"
                if status == "LINKED"
                else "账单已忽略，不允许生成交易明细或入账"
            )
