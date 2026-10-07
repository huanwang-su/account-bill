"""Personal financial position derived from the same entries as account balances."""

from datetime import date
from sqlalchemy import func
from .account_config import AccountGraph, AccountGroupService
from .domain import Clock, DomainError
from .models import AccountGroup, Entry, Transaction


class BalanceSheetService:
    def __init__(self, database):
        self.db = database

    def snapshot(self, as_of=None, group_id=None):
        day = as_of or Clock.now()[:10]
        try:
            if date.fromisoformat(day).isoformat() != day:
                raise ValueError()
        except (TypeError, ValueError):
            raise DomainError("截止日期需为 YYYY-MM-DD") from None
        cutoff = day + " 23:59:59"
        with self.db.read() as session:
            graph = AccountGraph(session)
            _, balances = graph.balances(session, cutoff)
            scope = (
                AccountGroupService.descendants(session, group_id)
                if group_id is not None
                else None
            )
            openings = dict(
                session.query(Entry.account_id, func.min(Transaction.occurred_at))
                .join(Transaction, Transaction.id == Entry.transaction_id)
                .filter(Transaction.kind == "OPENING")
                .group_by(Entry.account_id)
            )
            rows = []
            for account in graph.accounts.values():
                if account.merged_into_id or account.role not in ("ASSET", "LIABILITY"):
                    continue
                if scope is not None and account.group_id not in scope:
                    continue
                members = graph.members(account.id)
                opening_set = all(
                    graph.accounts[key].opening_set
                    and (key not in openings or openings[key] <= cutoff)
                    for key in members
                )
                balance = balances.get(account.id, 0)
                rows.append(
                    dict(
                        id=account.id,
                        name=account.name,
                        role=account.role,
                        kind=account.kind,
                        group_id=account.group_id,
                        active=account.active,
                        opening_set=opening_set,
                        balance=balance,
                        amount=balance if account.role == "ASSET" else -balance,
                        merged_source_count=len(members) - 1,
                    )
                )
            assets = sum(row["amount"] for row in rows if row["role"] == "ASSET")
            liabilities = sum(
                row["amount"] for row in rows if row["role"] == "LIABILITY"
            )
            return dict(
                as_of=day,
                group_id=int(group_id) if group_id is not None else None,
                assets=assets,
                liabilities=liabilities,
                net_assets=assets - liabilities,
                accounts=rows,
                groups=[
                    dict(id=g.id, name=g.name, parent_id=g.parent_id)
                    for g in session.query(AccountGroup).order_by(AccountGroup.id)
                    if scope is None or g.id in scope
                ],
                missing_opening_ids=[
                    row["id"] for row in rows if not row["opening_set"]
                ],
            )
