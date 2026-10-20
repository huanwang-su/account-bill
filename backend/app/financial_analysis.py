"""Income/expense analytics over the same effective transactions as reports."""

from collections import defaultdict
from datetime import date, timedelta
from .report_context import consistent_read
from .domain import DomainError
from .category_catalog import CategoryGraph
from .services import ReportService
from .account_movements import AccountMovementService
from .report_scope import ReportAccountScope
from .analysis_settings import AnalysisDefaults


class FinancialAnalysisService:
    def __init__(self, database):
        self.db = database

    @staticmethod
    def periods(start, end, grain):
        from .analysis_period import PeriodSeries
        return PeriodSeries.values(start, end, grain)

    @consistent_read
    def analyze(
        self,
        filters=None,
        grain="day",
        level=1,
        large_amount=None,
        account_scope=None,
        large_income_amount=None,
        large_expense_amount=None,
    ):
        if grain not in ("day", "month") or level not in (1, 2):
            raise DomainError("分析粒度需为日/月，分类层级需为一级/二级")
        filters = filters or {}
        defaults = AnalysisDefaults(self.db)
        income_threshold = defaults.threshold(
            "income",
            (
                large_income_amount
                if large_income_amount is not None
                else filters.get("large_income_amount", large_amount)
            ),
        )
        expense_threshold = defaults.threshold(
            "expense",
            (
                large_expense_amount
                if large_expense_amount is not None
                else filters.get("large_expense_amount", large_amount)
            ),
        )
        include_movements = account_scope is None
        exclusion = None
        if account_scope is None:
            with self.db.read() as session:
                exclusion = ReportAccountScope(session, filters)
            account_scope = exclusion
        rows = [
            r
            for r in ReportService(self.db).list(filters)
            if r["kind"] in ("INCOME", "EXPENSE", "REFUND")
            and (account_scope is None or account_scope.allows(r))
        ]
        trend = defaultdict(lambda: dict(income=0, expense=0))
        buckets = {}
        income = expense = income_count = expense_count = refund_count = 0
        large = []
        detailed = []
        with self.db.read() as session:
            graph = CategoryGraph(session)
            for row in rows:
                is_income = row["kind"] == "INCOME"
                side = "income" if is_income else "expense"
                value = row["amount"] * (-1 if row["kind"] == "REFUND" else 1)
                if is_income:
                    income += value
                    income_count += 1
                else:
                    expense += value
                    expense_count += row["kind"] == "EXPENSE"
                    refund_count += row["kind"] == "REFUND"
                period = row["occurred_at"][: 7 if grain == "month" else 10]
                trend[period][side] += value
                entries = [
                    e
                    for e in row["entries"]
                    if e["role"] == "SYSTEM" and e["category_id"] and e["selected"]
                ]
                category_names = []
                for entry in entries:
                    category = graph.canonical(entry["category_id"])
                    category_names.append(" / ".join(graph.path(category.id)))
                    if level == 1:
                        while category.parent_id:
                            category = graph.canonical(category.parent_id)
                    key = (side, category.id)
                    bucket = buckets.setdefault(
                        key,
                        dict(
                            id=category.id,
                            name=" / ".join(graph.path(category.id)),
                            amount=0,
                            transaction_ids=set(),
                        ),
                    )
                    bucket["amount"] += (
                        -entry["amount"] if is_income else entry["amount"]
                    )
                    bucket["transaction_ids"].add(row["id"])
                if not entries:
                    bucket = buckets.setdefault(
                        (side, 0),
                        dict(id=0, name="未分类", amount=0, transaction_ids=set()),
                    )
                    bucket["amount"] += value
                    bucket["transaction_ids"].add(row["id"])
                    category_names.append("未分类")
                detail = dict(
                    **row,
                    category_names=list(dict.fromkeys(category_names)),
                    account_names=list(
                        dict.fromkeys(
                            e["account"]
                            for e in row["entries"]
                            if e["role"] in ("ASSET", "LIABILITY")
                        )
                    ),
                    direction="INCOME" if is_income else "EXPENSE",
                )
                detailed.append(detail)
                if row["amount"] >= (
                    income_threshold if is_income else expense_threshold
                ):
                    large.append(detail)
        labels = []
        if rows:
            labels = self.periods(
                filters.get("start") or min(r["occurred_at"] for r in rows),
                filters.get("end") or max(r["occurred_at"] for r in rows),
                grain,
            )
        result_categories = {}
        for side in ("income", "expense"):
            categories = [
                dict(
                    id=b["id"],
                    name=b["name"],
                    amount=b["amount"],
                    count=len(b["transaction_ids"]),
                )
                for (s, _), b in buckets.items()
                if s == side
            ]
            positive = sum(max(0, c["amount"]) for c in categories)
            for category in categories:
                category["share"] = (
                    max(0, category["amount"]) / positive if positive else 0
                )
            result_categories[side] = sorted(
                categories, key=lambda c: (-c["amount"], c["id"])
            )
        large.sort(key=lambda r: (r["amount"], r["occurred_at"], r["id"]), reverse=True)
        result = dict(
            grain=grain,
            level=level,
            income=income,
            expense=expense,
            net=income - expense,
            count=len(rows),
            income_count=income_count,
            expense_count=expense_count,
            refund_count=refund_count,
            average_expense=expense // expense_count if expense_count else 0,
            categories=result_categories,
            trend=[
                dict(period=p, **trend[p], net=trend[p]["income"] - trend[p]["expense"])
                for p in labels
            ],
            large_amount_minor=(
                income_threshold
                if filters.get("kind") == "INCOME"
                else expense_threshold
            ),
            large_income_amount_minor=income_threshold,
            large_expense_amount_minor=expense_threshold,
            large_count=len(large),
            large_share=len(large) / len(rows) if rows else 0,
            large_income=sum(r["amount"] for r in large if r["kind"] == "INCOME"),
            large_expense=sum(
                r["amount"] * (-1 if r["kind"] == "REFUND" else 1)
                for r in large
                if r["kind"] != "INCOME"
            ),
            large_transactions=large,
            transactions=detailed,
        )
        if include_movements:
            result["account_movements"] = AccountMovementService(self.db).analyze(
                dict(
                    filters,
                    **(
                        {
                            key: value
                            for key, value in exclusion.projection().items()
                            if key in ReportAccountScope.FIELDS
                            and key != "excluded_account_ids"
                        }
                        if exclusion
                        else {}
                    ),
                )
            )
        if exclusion is not None:
            result["account_scope"] = exclusion.projection()
        return result
