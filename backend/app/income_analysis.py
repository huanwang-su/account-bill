"""Income-only reporting over effective journal transactions, without principal flows."""

from .analysis_scope import AnalysisAccountScope
from .expense_analysis import AnalysisPeriod
from .financial_analysis import FinancialAnalysisService
from .category_catalog import CategoryGraph
from .domain import DomainError


class IncomeAnalysisService:
    def __init__(self, db):
        self.db = db

    def analyze(self, filters=None, grain="day", level=1, large_amount=None):
        filters = dict(filters or {})
        period = AnalysisPeriod(filters.get("start"), filters.get("end"))
        from .analysis_settings import AnalysisDefaults

        threshold = AnalysisDefaults(self.db).threshold("income", large_amount)
        large_amount = f"{threshold // 100}.{threshold % 100:02d}"
        with self.db.read() as session:
            scope = AnalysisAccountScope(session, filters)
            categories = CategoryGraph(session)
            if (
                filters.get("category_id")
                and categories.canonical(filters["category_id"]).kind != "INCOME"
            ):
                raise DomainError("请选择收入分类")
            if filters.get("account_id"):
                scope.graph.canonical(filters["account_id"])
            if scope.direct_group:
                filters.pop("group_id", None)
            filters["kind"] = "INCOME"
            analysis = FinancialAnalysisService(self.db)
            current = analysis.analyze(
                dict(
                    filters, start=period.start.isoformat(), end=period.end.isoformat()
                ),
                grain,
                level,
                large_amount,
                account_scope=scope,
            )
            previous = analysis.analyze(
                dict(
                    filters,
                    start=period.previous_start.isoformat(),
                    end=period.previous_end.isoformat(),
                ),
                grain,
                level,
                large_amount,
                account_scope=scope,
            )
            grouped = {}
            accounts = {}
            sources = {}
            for row in current["transactions"]:
                funding_id = next(iter(scope.funding_ids(row)), None)
                account = scope.graph.accounts.get(funding_id)
                group_id = account.group_id if account else None
                if account:
                    target = accounts.setdefault(
                        account.id,
                        dict(
                            id=account.id,
                            name=account.name,
                            group_id=group_id,
                            amount=0,
                            count=0,
                        ),
                    )
                    target["amount"] += row["amount"]
                    target["count"] += 1
                name = (row["counterparty"] or "").strip() or "未填写交易方"
                source = sources.setdefault(
                    name.casefold(), dict(name=name, amount=0, count=0)
                )
                source["amount"] += row["amount"]
                source["count"] += 1
                has_category = False
                for entry in row["entries"]:
                    if (
                        entry["role"] != "SYSTEM"
                        or not entry["category_id"]
                        or not entry["selected"]
                    ):
                        continue
                    has_category = True
                    category = categories.canonical(entry["category_id"])
                    while category.parent_id:
                        category = categories.canonical(category.parent_id)
                    target = grouped.setdefault(
                        (group_id, category.id),
                        dict(
                            group_id=group_id,
                            category_id=category.id,
                            name=category.name,
                            amount=0,
                            transactions=set(),
                        ),
                    )
                    target["amount"] -= entry["amount"]
                    target["transactions"].add(row["id"])
                if not has_category:
                    target = grouped.setdefault(
                        (group_id, 0),
                        dict(
                            group_id=group_id,
                            category_id=0,
                            name="未分类",
                            amount=0,
                            transactions=set(),
                        ),
                    )
                    target["amount"] += row["amount"]
                    target["transactions"].add(row["id"])
        amount = current["income"]
        earlier = previous["income"]
        trend = {row["period"]: row["income"] for row in current["trend"]}
        current["trend"] = [
            dict(period=key, income=trend.get(key, 0))
            for key in analysis.periods(
                period.start.isoformat(), period.end.isoformat(), grain
            )
        ]
        return dict(
            start=period.start.isoformat(),
            end=period.end.isoformat(),
            days=period.days,
            previous_start=period.previous_start.isoformat(),
            previous_end=period.previous_end.isoformat(),
            grain=grain,
            level=level,
            income=amount,
            count=current["income_count"],
            previous_income=earlier,
            change=amount - earlier,
            change_ratio=(amount - earlier) / earlier if earlier > 0 else None,
            average=amount // current["income_count"] if current["income_count"] else 0,
            average_daily=amount // period.days,
            excluded_account_ids=sorted(scope.excluded_ids),
            categories=current["categories"]["income"],
            trend=current["trend"],
            group_categories=[
                dict(
                    **{k: v for k, v in row.items() if k != "transactions"},
                    count=len(row["transactions"]),
                    transaction_ids=sorted(row["transactions"]),
                )
                for _, row in sorted(
                    grouped.items(), key=lambda item: (item[0][0] or 0, item[0][1])
                )
            ],
            accounts=sorted(accounts.values(), key=lambda r: (-r["amount"], r["id"])),
            sources=sorted(sources.values(), key=lambda r: (-r["amount"], r["name"])),
            large_amount_minor=current["large_amount_minor"],
            large_count=current["large_count"],
            large_income=current["large_income"],
            large_transactions=current["large_transactions"],
            transactions=current["transactions"],
        )
