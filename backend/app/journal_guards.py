"""Shared invariants for imports, manual entries and reversals."""

import json
from sqlalchemy import or_
from .account_config import AccountGraph
from .domain import Clock, DomainError
from .models import AccountValuation, Entry, Transaction


class ValuationHistoryGuard:
    @staticmethod
    def check(session, data, postings):
        if data.get("_valuation_update") or data.get("_baseline_reconciliation"):
            return
        graph = AccountGraph(session)
        changes = {}
        for posting in postings:
            if graph.accounts[posting.account_id].role in ("ASSET", "LIABILITY"):
                key = graph.canonical(posting.account_id).id
                changes[key] = changes.get(key, 0) + posting.amount
        funding = {key for key, amount in changes.items() if amount}
        members = {i for key in funding for i in graph.members(key)}
        if not members:
            return
        query = (
            session.query(AccountValuation)
            .outerjoin(Transaction, Transaction.id == AccountValuation.transaction_id)
            .filter(
                AccountValuation.revoked_at.is_(None),
                AccountValuation.account_id.in_(members),
                AccountValuation.occurred_at > Clock.normalize(data["occurred_at"]),
                or_(
                    AccountValuation.transaction_id.is_(None),
                    Transaction.status == "POSTED",
                ),
            )
        )
        if data.get("reversal_of"):
            query = query.filter(
                or_(
                    AccountValuation.transaction_id.is_(None),
                    AccountValuation.transaction_id != data["reversal_of"],
                )
            )
        if query.first():
            raise DomainError(
                "该日期之后已有证券估值，请先撤销受影响的估值，再补录、修改或撤销历史交易并重新更新余额"
            )


class JournalIdempotency:
    @staticmethod
    def check(session, old, data, postings):
        from .category_catalog import CategoryGraph

        accounts, categories = AccountGraph(session), CategoryGraph(session)

        def identity(row):
            return (
                accounts.canonical(row.account_id).id,
                row.amount,
                categories.canonical(row.category_id).id if row.category_id else 0,
            )

        expected = sorted(identity(p) for p in postings)
        actual = sorted(
            identity(e) for e in session.query(Entry).filter_by(transaction_id=old.id)
        )
        if not (
            expected == actual
            and old.kind == data["kind"]
            and old.occurred_at == Clock.normalize(data["occurred_at"])
            and old.counterparty == str(data.get("counterparty", ""))
            and old.note == str(data.get("note", ""))
            and sorted(json.loads(old.tags)) == sorted(set(data.get("tags", [])))
            and old.related_id == data.get("related_id")
            and old.reversal_of == data.get("reversal_of")
            and old.source == data.get("source", "手动")
        ):
            raise DomainError("提交编号已用于不同的交易内容，请刷新后重新提交")
        return old
