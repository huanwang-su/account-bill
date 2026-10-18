"""Configured accounts, independently reconciled to their actual journal balances."""

from collections import defaultdict
from .analysis_settings import AnalysisSettingsService
from .account_config import AccountGraph
from .category_catalog import CategoryGraph
from .counterparty_analysis import CounterpartyAnalysisService
from .expense_analysis import AnalysisPeriod
from .financial_analysis import FinancialAnalysisService
from .services import ReportService
from .domain import DomainError


class SingleAccountAnalysisService:
    def __init__(self, db):
        self.db = db

    def analyze(self, start=None, end=None, account_id=None, *, account_ids=None):
        period = AnalysisPeriod(start, end)
        start, end = period.start.isoformat(), period.end.isoformat()
        rows = ReportService(self.db).list(dict(start=start, end=end))
        with self.db.read() as session:
            config = AnalysisSettingsService.read_in(session)
            graph = AccountGraph(session)
            ids = (
                sorted(
                    set(config["single_account_ids"])
                    | set(config["single_excluded_account_ids"])
                )
                if account_ids is None
                else AnalysisSettingsService.normalize(graph, account_ids, strict=True)
            )
            if account_id is not None:
                key = graph.canonical(account_id).id
                if key not in ids:
                    raise DomainError("请先在分析配置中添加该账户")
                ids = [key]
            _, opening = graph.balances(
                session, period.previous_end.isoformat() + " 23:59:59"
            )
            _, ending = graph.balances(session, end + " 23:59:59")
            categories = CategoryGraph(session)
            results = []
            for key in ids:
                account = graph.accounts[key]
                mode = config["single_account_modes"].get(str(key), "both")
                cashflow_enabled = mode in ("cashflow", "both")
                detail = []
                daily = defaultdict(int)
                cash_daily = defaultdict(
                    lambda: dict(income=0, expense=0, transfer_in=0, transfer_out=0)
                )
                bucket = {}
                income = expense = refunds = transfer_in = transfer_out = valuation = (
                    adjustments
                ) = 0
                for row in rows:
                    signed = sum(
                        e["amount"] for e in row["entries"] if e["account_id"] == key
                    )
                    if not signed:
                        continue
                    day = row["occurred_at"][:10]
                    daily[day] += signed
                    if row["kind"] == "OPENING":
                        adjustments += signed
                    elif row["source"] == "证券余额更新":
                        valuation += signed
                    elif row["kind"] == "INCOME":
                        income += signed
                        cash_daily[day]["income"] += signed
                    elif row["kind"] == "EXPENSE":
                        expense -= signed
                        cash_daily[day]["expense"] -= signed
                    elif row["kind"] == "REFUND":
                        refunds += signed
                        cash_daily[day]["expense"] -= signed
                    elif row["kind"] == "TRANSFER":
                        transfer_in += max(0, signed)
                        transfer_out -= min(0, signed)
                        cash_daily[day]["transfer_in"] += max(0, signed)
                        cash_daily[day]["transfer_out"] -= min(0, signed)
                    else:
                        adjustments += signed  # Opening entries inside this interval.
                    names = []
                    for entry in row["entries"]:
                        if entry["role"] != "SYSTEM" or not entry["category_id"]:
                            continue
                        category = categories.canonical(entry["category_id"])
                        names.append(" / ".join(categories.path(category.id)))
                        if (
                            not cashflow_enabled
                            or row["source"] == "证券余额更新"
                            or row["kind"]
                            not in (
                                "INCOME",
                                "EXPENSE",
                            )
                        ):
                            continue
                        while category.parent_id:
                            category = categories.canonical(category.parent_id)
                        target = bucket.setdefault(
                            (row["kind"], category.id),
                            dict(
                                id=category.id,
                                name=category.name,
                                kind=row["kind"],
                                amount=0,
                                transactions=set(),
                            ),
                        )
                        target["amount"] += (
                            -entry["amount"]
                            if row["kind"] == "INCOME"
                            else entry["amount"]
                        )
                        target["transactions"].add(row["id"])
                    detail.append(
                        dict(
                            **row,
                            account_change=signed,
                            category_names=list(dict.fromkeys(names)),
                        )
                    )
                current = opening.get(key, 0)
                trend = []
                for day in FinancialAnalysisService.periods(start, end, "day"):
                    current += daily[day]
                    trend.append(
                        dict(
                            day=day,
                            balance=current,
                            change=daily[day],
                            **cash_daily[day],
                        )
                    )
                movement = (
                    income
                    - expense
                    + refunds
                    + transfer_in
                    - transfer_out
                    + valuation
                    + adjustments
                )
                counterparties = (
                    CounterpartyAnalysisService(self.db).analyze(
                        key, dict(start=start, end=end)
                    )
                    if mode in ("counterparties", "both")
                    else None
                )
                results.append(
                    dict(
                        id=key,
                        analysis_mode=mode,
                        name=account.name,
                        kind=account.kind,
                        role=account.role,
                        group_id=account.group_id,
                        opening_balance=opening.get(key, 0),
                        ending_balance=ending.get(key, 0),
                        change=ending.get(key, 0) - opening.get(key, 0),
                        income=income,
                        expense=expense,
                        refunds=refunds,
                        net=income - expense + refunds,
                        transfer_in=transfer_in,
                        transfer_out=transfer_out,
                        transfer_net=transfer_in - transfer_out,
                        valuation_profit=valuation,
                        adjustments=adjustments,
                        reconciled=opening.get(key, 0) + movement == ending.get(key, 0),
                        count=sum(r["kind"] != "OPENING" for r in detail),
                        categories=[
                            dict(
                                **{k: v for k, v in b.items() if k != "transactions"},
                                count=len(b["transactions"]),
                                transaction_ids=sorted(b["transactions"]),
                            )
                            for b in sorted(
                                bucket.values(),
                                key=lambda b: (b["kind"], -b["amount"], b["id"]),
                            )
                        ],
                        trend=trend,
                        counterparties=counterparties,
                        transactions=detail,
                    )
                )
        return dict(
            start=start,
            end=end,
            revision=config["revision"],
            configured_account_ids=(
                sorted(
                    set(config["single_account_ids"])
                    | set(config["single_excluded_account_ids"])
                )
                if account_ids is None
                else ids
            ),
            accounts=results,
        )
