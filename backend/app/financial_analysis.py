"""Income/expense analytics over the same effective transactions as reports."""

from collections import defaultdict
from datetime import date, timedelta
from .domain import DomainError, Money
from .category_catalog import CategoryGraph
from .services import ReportService


class FinancialAnalysisService:
    def __init__(self, database):
        self.db = database

    @staticmethod
    def periods(start, end, grain):
        first, last = date.fromisoformat(start[:10]), date.fromisoformat(end[:10])
        if grain == "month":
            first, last = first.replace(day=1), last.replace(day=1)
        values = []
        while first <= last:
            if len(values) >= 5000:
                raise DomainError("趋势范围过长，请缩短日期范围或切换为按月分析")
            values.append(
                first.isoformat()[:7] if grain == "month" else first.isoformat()
            )
            if first == last:
                break
            first = (
                date(first.year + (first.month == 12), first.month % 12 + 1, 1)
                if grain == "month"
                else first + timedelta(days=1)
            )
        return values

    def analyze(self, filters=None, grain="day", level=1, large_amount="1000.00"):
        if grain not in ("day", "month") or level not in (1, 2):
            raise DomainError("分析粒度需为日/月，分类层级需为一级/二级")
        threshold = Money.parse(large_amount)
        if threshold < 0:
            raise DomainError("大额门槛不能为负数")
        filters = filters or {}
        rows = [
            r
            for r in ReportService(self.db).list(filters)
            if r["kind"] in ("INCOME", "EXPENSE", "REFUND")
        ]
        trend = defaultdict(lambda: dict(income=0, expense=0))
        buckets = {}
        income = expense = income_count = expense_count = refund_count = 0
        large = []
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
                if row["amount"] >= threshold:
                    large.append(
                        dict(
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
                    )
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
        return dict(
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
            large_amount_minor=threshold,
            large_count=len(large),
            large_share=len(large) / len(rows) if rows else 0,
            large_income=sum(r["amount"] for r in large if r["kind"] == "INCOME"),
            large_expense=sum(
                r["amount"] * (-1 if r["kind"] == "REFUND" else 1)
                for r in large
                if r["kind"] != "INCOME"
            ),
            large_transactions=large,
        )
