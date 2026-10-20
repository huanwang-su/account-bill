"""Read-only period balances, independent of transaction-level report filters."""

from collections import defaultdict
from sqlalchemy import func
from .account_config import AccountGraph, AccountGroupService
from .domain import Clock, DomainError
from .models import Entry, Transaction
from .report_scope import ReportAccountScope


class AccountMovementService:
    KINDS = (
        ("INCOME", "收入"),
        ("EXPENSE", "付款"),
        ("REFUND", "退款"),
        ("TRANSFER", "内部转账"),
        ("VALUATION", "证券估值"),
        ("OPENING", "期初录入"),
        ("ADJUSTMENT", "其他调整"),
        ("REVERSAL", "冲销"),
    )
    TRANSACTION_FILTERS = (
        "category_id",
        "exact_category",
        "tag",
        "account_tag",
        "q",
        "kind",
        "min_amount",
        "max_amount",
        "direct_group",
    )
    AMOUNTS = (
        "opening_balance",
        "ending_balance",
        "net_change",
        "opening_added",
        "operating_change",
        "inflow",
        "outflow",
        "operating_inflow",
        "operating_outflow",
        "opening_assets",
        "opening_liabilities",
        "ending_assets",
        "ending_liabilities",
        "asset_change",
        "liability_change",
    )

    def __init__(self, database):
        self.db = database

    @staticmethod
    def _has(value):
        return value is not None and value != ""

    @staticmethod
    def _cutoff(value, end=False):
        if not isinstance(value, str):
            raise DomainError("日期格式不正确")
        return Clock.normalize(
            value + " 23:59:59" if end and len(value) == 10 else value
        )

    def _period(self, session, members, filters):
        start = (
            self._cutoff(filters["start"]) if self._has(filters.get("start")) else None
        )
        end = (
            self._cutoff(filters["end"], True)
            if self._has(filters.get("end"))
            else None
        )
        if start and end and start > end:
            raise DomainError("开始日期不能晚于结束日期")
        first = last = None
        if members and (start is None or end is None):
            extent = (
                session.query(
                    func.min(Transaction.occurred_at), func.max(Transaction.occurred_at)
                )
                .join(
                    Entry,
                    Entry.transaction_id == Transaction.id,
                )
                .filter(Entry.account_id.in_(members))
            )
            if end:
                extent = extent.filter(Transaction.occurred_at <= end)
            first, last = extent.one()
        if end is None:
            end = max(
                Clock.now()[:10] + " 23:59:59",
                last[:10] + " 23:59:59" if last else "",
                start[:10] + " 23:59:59" if start else "",
            )
        if start is None:
            start = (first[:10] if first else end[:10]) + " 00:00:00"
        return start, end

    @staticmethod
    def _raw_balances(session, members, cutoff, before=False):
        if not members:
            return {}
        query = (
            session.query(Entry.account_id, func.sum(Entry.amount))
            .join(
                Transaction,
                Transaction.id == Entry.transaction_id,
            )
            .filter(Entry.account_id.in_(members))
        )
        query = (
            query.filter(Transaction.occurred_at < cutoff)
            if before
            else query.filter(Transaction.occurred_at <= cutoff)
        )
        return dict(query.group_by(Entry.account_id))

    @staticmethod
    def _position(account, graph, members, raw, composite):
        balance = sum(raw.get(key, 0) for key in members)
        if composite:
            assets = sum(
                raw.get(key, 0)
                for key in members
                if graph.accounts[key].role == "ASSET"
            )
            liabilities = -sum(
                raw.get(key, 0)
                for key in members
                if graph.accounts[key].role == "LIABILITY"
            )
        else:
            assets = balance if account.role == "ASSET" else 0
            liabilities = -balance if account.role == "LIABILITY" else 0
        return balance, assets, liabilities

    @classmethod
    def _kind(cls, transaction):
        if transaction.kind == "REVERSAL":
            return "REVERSAL"
        if transaction.kind == "OPENING":
            return "OPENING"
        if transaction.purpose == "VALUATION":
            return "VALUATION"
        return (
            transaction.kind
            if transaction.kind in {key for key, _ in cls.KINDS}
            else "ADJUSTMENT"
        )

    @classmethod
    def _breakdown(cls, movements, transactions):
        rows = []
        for kind, label in cls.KINDS:
            selected = {
                key: value
                for key, value in movements.items()
                if cls._kind(transactions[key]) == kind
            }
            if not selected:
                continue
            incoming = sum(max(0, value) for value in selected.values())
            outgoing = sum(max(0, -value) for value in selected.values())
            rows.append(
                dict(
                    kind=kind,
                    label=label,
                    inflow=incoming,
                    outflow=outgoing,
                    net_change=incoming - outgoing,
                    transaction_count=len(selected),
                    transaction_ids=sorted(selected),
                )
            )
        return rows

    def analyze(self, filters=None):
        filters = filters or {}
        with self.db.read() as session:
            graph = AccountGraph(session)
            account_scope = (
                ReportAccountScope(session, filters)
                if ReportAccountScope.active(filters)
                else None
            )
            excluded = account_scope.excluded_ids if account_scope else set()
            account_id = None
            if self._has(filters.get("account_id")):
                account_id = graph.canonical(filters["account_id"]).id
            group_id = None
            groups = None
            if self._has(filters.get("group_id")):
                group_id = int(filters["group_id"])
                groups = AccountGroupService.descendants(session, group_id)
            accounts = [
                account
                for account in graph.accounts.values()
                if not account.merged_into_id
                and account.role in ("ASSET", "LIABILITY")
                and account.id not in excluded
                and (account_id is None or account.id == account_id)
                and (groups is None or account.group_id in groups)
            ]
            accounts.sort(
                key=lambda account: (account.group_id or 0, account.name, account.id)
            )
            account_members = {
                account.id: graph.members(account.id) for account in accounts
            }
            members = set().union(*account_members.values()) if accounts else set()
            canonical = {
                key: account.id
                for account in accounts
                for key in account_members[account.id]
            }
            start, end = self._period(session, members, filters)
            opening = self._raw_balances(session, members, start, before=True)
            ending = self._raw_balances(session, members, end)
            movements = defaultdict(lambda: defaultdict(int))
            transactions = {}
            if members:
                # Keep original and reversal entries, exactly as balances do.
                # A transaction is first netted within each canonical account,
                # so an internal move between merged components has no flow.
                for entry, transaction in (
                    session.query(Entry, Transaction)
                    .join(
                        Transaction,
                        Transaction.id == Entry.transaction_id,
                    )
                    .filter(
                        Entry.account_id.in_(members),
                        Transaction.occurred_at >= start,
                        Transaction.occurred_at <= end,
                    )
                ):
                    movements[canonical[entry.account_id]][
                        transaction.id
                    ] += entry.amount
                    transactions[transaction.id] = transaction
            first_openings = (
                dict(
                    session.query(Entry.account_id, func.min(Transaction.occurred_at))
                    .join(
                        Transaction,
                        Transaction.id == Entry.transaction_id,
                    )
                    .filter(
                        Transaction.kind == "OPENING", Entry.account_id.in_(members)
                    )
                    .group_by(Entry.account_id)
                )
                if members
                else {}
            )
            rows = []
            for account in accounts:
                keys = account_members[account.id]
                composite = graph.is_composite(account.id)
                initial, initial_assets, initial_liabilities = self._position(
                    account, graph, keys, opening, composite
                )
                final, final_assets, final_liabilities = self._position(
                    account, graph, keys, ending, composite
                )
                changes = movements[account.id]
                incoming = sum(max(0, value) for value in changes.values())
                outgoing = sum(max(0, -value) for value in changes.values())
                opening_added = sum(
                    value
                    for key, value in changes.items()
                    if self._kind(transactions[key]) == "OPENING"
                )
                operating = {
                    key: value
                    for key, value in changes.items()
                    if self._kind(transactions[key]) != "OPENING"
                }
                rows.append(
                    dict(
                        id=account.id,
                        name=account.name,
                        role=account.role,
                        kind=account.kind,
                        group_id=account.group_id,
                        active=account.active,
                        composite=composite,
                        merged_source_count=len(keys) - 1,
                        opening_set=all(
                            graph.accounts[key].opening_set
                            and (
                                key not in first_openings or first_openings[key] <= end
                            )
                            for key in keys
                        ),
                        opening_balance=initial,
                        ending_balance=final,
                        net_change=final - initial,
                        opening_added=opening_added,
                        operating_change=final - initial - opening_added,
                        inflow=incoming,
                        outflow=outgoing,
                        operating_inflow=sum(
                            max(0, value) for value in operating.values()
                        ),
                        operating_outflow=sum(
                            max(0, -value) for value in operating.values()
                        ),
                        opening_assets=initial_assets,
                        opening_liabilities=initial_liabilities,
                        ending_assets=final_assets,
                        ending_liabilities=final_liabilities,
                        asset_change=final_assets - initial_assets,
                        liability_change=final_liabilities - initial_liabilities,
                        reconciled=initial + incoming - outgoing == final,
                        transaction_count=len(changes),
                        transaction_ids=sorted(changes),
                        breakdown=self._breakdown(changes, transactions),
                    )
                )
            totals = {key: sum(row[key] for row in rows) for key in self.AMOUNTS}
            totals.update(
                account_count=len(rows),
                transaction_count=len(transactions),
                reconciled=all(row["reconciled"] for row in rows)
                and totals["opening_balance"] + totals["inflow"] - totals["outflow"]
                == totals["ending_balance"],
            )
            ignored = [
                key for key in self.TRANSACTION_FILTERS if self._has(filters.get(key))
            ]
            return dict(
                start=start[:10],
                end=end[:10],
                start_at=start,
                end_at=end,
                start_unbounded=not self._has(filters.get("start")),
                end_unbounded=not self._has(filters.get("end")),
                basis="complete_account_period",
                flow_basis="net_per_transaction_per_canonical_account",
                includes_reversals=True,
                ignored_filters=ignored,
                applied_filters=dict(
                    start=filters.get("start"),
                    end=filters.get("end"),
                    account_id=account_id,
                    group_id=group_id,
                ),
                accounts=rows,
                totals=totals,
                missing_opening_ids=[
                    row["id"] for row in rows if not row["opening_set"]
                ],
                account_scope=account_scope.projection() if account_scope else None,
            )
