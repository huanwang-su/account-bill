"""Portfolio returns separate valuation changes, other earnings, and funding flows."""

from collections import defaultdict
from datetime import date
from .account_config import AccountGraph
from .models import AccountValuation, Entry, Transaction
from .domain import DomainError
from .financial_analysis import FinancialAnalysisService
from .investment_scope import InvestmentScope


class InvestmentAnalysisService:
    def __init__(self, db):
        self.db = db

    @staticmethod
    def day(value):
        try:
            if date.fromisoformat(value).isoformat() != value:
                raise ValueError()
            return value
        except (ValueError, TypeError):
            raise DomainError("日期需为 YYYY-MM-DD") from None

    def analyze(self, account_id=None, start=None, end=None, grain="month"):
        from .domain import Clock

        end = self.day(end or Clock.now()[:10])
        if start:
            start = self.day(start)
        if start and start > end:
            raise DomainError("开始日期不能晚于结束日期")
        if grain not in ("day", "month"):
            raise DomainError("分析粒度需为日/月")
        cutoff = end + " 23:59:59"
        with self.db.read() as s:
            graph = AccountGraph(s)
            all_transactions = {
                t.id: t
                for t in s.query(Transaction)
                if t.status == "POSTED" and t.kind != "REVERSAL"
            }
            all_entries = defaultdict(list)
            for entry in s.query(Entry):
                if entry.transaction_id in all_transactions:
                    all_entries[entry.transaction_id].append(entry)
            investment_scope = InvestmentScope(graph)
            investment_assets = investment_scope.assets
            if account_id is not None:
                account = graph.canonical(account_id)
                selected = account.id
                if selected not in investment_assets:
                    raise DomainError("请选择证券或理财类型的资产账户")
                scope = {selected}
            else:
                scope = investment_assets
            transactions = {
                t.id: t for t in all_transactions.values() if t.occurred_at <= cutoff
            }
            entries = defaultdict(list)
            for key in transactions:
                entries[key] = all_entries[key]
            snapshots = [
                v
                for v in s.query(AccountValuation).filter(
                    AccountValuation.occurred_at <= cutoff
                )
                if graph.canonical(v.account_id).id in scope
                and investment_scope.asset_owner(v.account_id) is not None
                and (v.transaction_id is None or v.transaction_id in transactions)
            ]
            relevant = [
                t
                for t in transactions.values()
                if any(
                    investment_scope.asset_owner(e.account_id)
                    in scope & investment_assets
                    for e in entries[t.id]
                )
            ]
            start = start or min(
                [t.occurred_at[:10] for t in relevant]
                + [v.occurred_at[:10] for v in snapshots]
                + [end]
            )
            lower = start + " 00:00:00"
            baseline_times = defaultdict(list)
            for when, key in (
                s.query(Transaction.occurred_at, Entry.account_id)
                .join(Entry, Entry.transaction_id == Transaction.id)
                .filter(Transaction.kind == "OPENING")
            ):
                baseline_times[key].append(when)
            for snapshot in s.query(AccountValuation).filter_by(baseline=True):
                baseline_times[snapshot.account_id].append(snapshot.occurred_at)
            accounts = {
                key: dict(
                    id=key,
                    name=graph.accounts[key].name,
                    kind=graph.accounts[key].kind,
                    analysis_mode="ASSET",
                    active=graph.accounts[key].active,
                    beginning=0,
                    ending=0,
                    opening_added=0,
                    capital_in=0,
                    capital_out=0,
                    internal_in=0,
                    internal_out=0,
                    valuation_profit=0,
                    other_profit=0,
                    asset_profit=0,
                    other_changes=0,
                    gain=0,
                    loss=0,
                    profit_count=0,
                    last_valuation=None,
                    opening_set=all(
                        graph.accounts[i].opening_set
                        and (not baseline_times[i] or min(baseline_times[i]) <= cutoff)
                        for i in investment_scope.asset_members.get(
                            key, graph.members(key)
                        )
                    ),
                )
                for key in sorted(scope)
            }
            for v in snapshots:
                row = accounts[graph.canonical(v.account_id).id]
                row["last_valuation"] = max(
                    row["last_valuation"] or v.occurred_at, v.occurred_at
                )
            days = defaultdict(lambda: dict(profit=0, asset_change=0))
            profits, transfers = [], []
            internal_volume = 0
            for tx in sorted(relevant, key=lambda t: (t.occurred_at, t.id)):
                es = entries[tx.id]
                asset_signed = defaultdict(int)
                for e in es:
                    key = investment_scope.asset_owner(e.account_id)
                    if key in scope & investment_assets:
                        asset_signed[key] += e.amount
                signed = dict(asset_signed)
                signed = {key: value for key, value in signed.items() if value}
                if not signed:
                    continue
                delta = sum(asset_signed.values())
                for key, value in signed.items():
                    if key not in investment_assets:
                        continue
                    accounts[key]["ending"] += asset_signed.get(key, 0)
                    if tx.occurred_at < lower:
                        accounts[key]["beginning"] += asset_signed.get(key, 0)
                if tx.occurred_at < lower:
                    continue
                bucket = days[tx.occurred_at[: 7 if grain == "month" else 10]]
                bucket["asset_change"] += delta
                detail = dict(
                    id=tx.id,
                    occurred_at=tx.occurred_at,
                    counterparty=tx.counterparty,
                    note=tx.note,
                    source=tx.source,
                    kind=tx.kind,
                    scope_change=delta,
                    account_names=[accounts[k]["name"] for k in signed],
                )
                if tx.kind == "OPENING":
                    for key, value in signed.items():
                        accounts[key]["opening_added"] += value
                elif tx.kind == "TRANSFER":
                    peers = {
                        graph.canonical(e.account_id).id
                        for e in es
                        if graph.canonical(e.account_id).role != "SYSTEM"
                    }
                    internal = peers <= investment_assets and all(
                        investment_scope.asset_owner(e.account_id) is not None
                        for e in es
                        if graph.canonical(e.account_id).role != "SYSTEM"
                    )
                    for key, value in signed.items():
                        accounts[key][
                            (
                                "internal_in"
                                if internal and value > 0
                                else (
                                    "internal_out"
                                    if internal
                                    else "capital_in" if value > 0 else "capital_out"
                                )
                            )
                        ] += abs(value)
                    amount = sum(e.amount for e in es if e.amount > 0)
                    if internal:
                        internal_volume += amount
                    transfers.append(
                        dict(
                            **detail,
                            amount=amount,
                            internal=internal,
                            from_accounts=sorted(
                                {
                                    graph.funding(e.account_id).name
                                    for e in es
                                    if e.amount < 0
                                    and graph.canonical(e.account_id).role != "SYSTEM"
                                }
                            ),
                            to_accounts=sorted(
                                {
                                    graph.funding(e.account_id).name
                                    for e in es
                                    if e.amount > 0
                                    and graph.canonical(e.account_id).role != "SYSTEM"
                                }
                            )
                        )
                    )
                elif tx.kind in ("INCOME", "EXPENSE", "REFUND"):
                    valuation = tx.source == "证券余额更新"
                    for key, value in signed.items():
                        row = accounts[key]
                        row[
                            "valuation_profit" if valuation else "other_profit"
                        ] += value
                        row["gain" if value > 0 else "loss"] += abs(value)
                        row["profit_count"] += 1
                        row["asset_profit"] += asset_signed.get(key, 0)
                    bucket["profit"] += sum(signed.values())
                    profits.append(
                        dict(**detail, amount=sum(signed.values()), valuation=valuation)
                    )
                else:
                    for key, value in signed.items():
                        accounts[key]["other_changes"] += value
            for row in accounts.values():
                row["profit"] = row["valuation_profit"] + row["other_profit"]
                row["capital_net"] = row["capital_in"] - row["capital_out"]
                row["internal_net"] = row["internal_in"] - row["internal_out"]
                row["reconciled"] = (
                    row["ending"]
                    == row["beginning"]
                    + row["opening_added"]
                    + row["capital_net"]
                    + row["internal_net"]
                    + row["asset_profit"]
                    + row["other_changes"]
                )
            totals = {
                name: sum(row[name] for row in accounts.values())
                for name in (
                    "beginning",
                    "ending",
                    "opening_added",
                    "capital_in",
                    "capital_out",
                    "capital_net",
                    "internal_in",
                    "internal_out",
                    "internal_net",
                    "valuation_profit",
                    "other_profit",
                    "profit",
                    "asset_profit",
                    "gain",
                    "loss",
                    "profit_count",
                    "other_changes",
                )
            }
            trend = []
            totals["profit_count"] = len(profits)
            assets, cumulative = totals["beginning"], 0
            for period in (
                FinancialAnalysisService.periods(start, end, grain) if scope else []
            ):
                assets += days[period]["asset_change"]
                cumulative += days[period]["profit"]
                trend.append(
                    dict(
                        period=period,
                        profit=days[period]["profit"],
                        cumulative_profit=cumulative,
                        assets=assets,
                    )
                )
            return dict(
                **totals,
                start=start,
                end=end,
                grain=grain,
                account_id=selected if account_id is not None else None,
                account_count=len(accounts),
                asset_account_count=len(scope & investment_assets),
                income_only_count=0,
                income_only_profit=0,
                available_accounts=investment_scope.options(),
                internal_volume=internal_volume,
                accounts=list(accounts.values()),
                trend=trend,
                profits=sorted(
                    profits, key=lambda r: (r["occurred_at"], r["id"]), reverse=True
                ),
                transfers=sorted(
                    transfers, key=lambda r: (r["occurred_at"], r["id"]), reverse=True
                ),
                missing_opening_ids=[
                    r["id"]
                    for r in accounts.values()
                    if r["analysis_mode"] == "ASSET" and not r["opening_set"]
                ],
                reconciled=all(r["reconciled"] for r in accounts.values())
            )
