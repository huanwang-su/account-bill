"""Unfiltered family snapshot and month-to-date household activity."""

from .report_context import consistent_read
from .balance_sheet import BalanceSheetService
from .analysis_period import AnalysisPeriod
from .expense_analysis import ExpenseAnalysisService
from .investment_analysis import InvestmentAnalysisService
from .services import ReportService
from .bills import BillService
from .models import BillImportRun
from .domain import DomainError
from .overview_period import OverviewPeriod
from .report_scope import ReportAccountScope
from .income_analysis import IncomeAnalysisService
from .single_account_analysis import SingleAccountAnalysisService


class OverviewService:
    def __init__(self, db):
        self.db = db

    @consistent_read
    def details(
        self,
        section,
        as_of=None,
        day=None,
        cumulative=False,
        group_id=None,
        filters=None,
    ):
        filters = filters or {}
        modern = bool(
            filters.get("period") or filters.get("start") or filters.get("end")
        )
        period = (
            OverviewPeriod(self.db, filters) if modern else AnalysisPeriod(end=as_of)
        )
        if section in ("expense", "income", "investment"):
            if not day:
                raise DomainError("请选择开支图中的日期")
            selected_day = AnalysisPeriod(day, day).end
            if not period.start <= selected_day <= period.end:
                raise DomainError("所选日期不在当前总览区间内")
            start = period.start.isoformat() if cumulative else day
            with self.db.read() as session:
                scope = ReportAccountScope(session, filters)
            request = scope.resolved_filters(dict(start=start, end=day))
            if section == "income":
                report = IncomeAnalysisService(self.db).analyze(request)
                amount, paid, refunds = report["income"], 0, 0
            elif section == "investment":
                report = InvestmentAnalysisService(self.db).analyze(
                    start=start, end=day, grain="day"
                )
                report["transactions"] = report["profits"]
                amount, paid, refunds = report["profit"], 0, 0
            else:
                report = ExpenseAnalysisService(self.db).analyze(
                    request, use_settings=False
                )
                amount, paid, refunds = (
                    report["expense"],
                    report["paid"],
                    report["refunds"],
                )
            return dict(
                section=section,
                as_of=period.end.isoformat(),
                start=start,
                end=day,
                amount=amount,
                paid=paid,
                refunds=refunds,
                count=len(report["transactions"]),
                transactions=report["transactions"],
                accounts=[],
                basis="overview_household_expense",
            )
        if section not in ("assets", "liabilities"):
            raise DomainError("请选择有效的总览图表")
        if group_id is None or group_id < 0:
            raise DomainError("请选择图中的账户组")
        snapshot = BalanceSheetService(self.db).snapshot(period.end.isoformat())
        if group_id and not any(g["id"] == group_id for g in snapshot["groups"]):
            raise DomainError("账户组不存在")
        field = "asset_amount" if section == "assets" else "liability_amount"
        # Overview bars represent direct ownership, never descendant-group totals.
        rows = [
            dict(account, analysis_amount=account[field])
            for account in snapshot["accounts"]
            if (account["group_id"] or 0) == group_id and account[field] != 0
        ]
        return dict(
            section=section,
            as_of=snapshot["as_of"],
            group_id=group_id,
            amount=sum(row["analysis_amount"] for row in rows),
            count=len(rows),
            accounts=rows,
            transactions=[],
            basis="overview_direct_group_balance",
        )

    @consistent_read
    def snapshot(self, as_of=None, filters=None):
        filters = filters or {}
        modern = bool(filters) or as_of is None
        period = (
            OverviewPeriod(self.db, filters) if modern else AnalysisPeriod(end=as_of)
        )
        day = period.end.isoformat()
        start = period.start.isoformat()
        balance = BalanceSheetService(self.db).snapshot(day)
        with self.db.read() as session:
            scope = ReportAccountScope(session, filters)
        request = scope.resolved_filters(dict(start=start, end=day))
        spending = ExpenseAnalysisService(self.db).analyze(request, use_settings=False)
        income_report = (
            IncomeAnalysisService(self.db).analyze(request) if modern else None
        )
        investments = InvestmentAnalysisService(self.db).analyze(
            start=start, end=day, grain="day" if modern else "month"
        )
        investment_report = investments if modern else None
        singles = (
            SingleAccountAnalysisService(self.db).analyze(
                start, day, account_ids=scope.config["single_account_ids"], summary_only=True
            )
            if modern
            else None
        )
        activity = ReportService(self.db).list(dict(end=day))
        recent = [
            r
            for r in activity
            if r["kind"] in ("INCOME", "EXPENSE", "REFUND", "TRANSFER")
        ][:5]
        group_rows = {}
        for account in balance["accounts"]:
            key = account["group_id"]
            group = next((g for g in balance["groups"] if g["id"] == key), None)
            row = group_rows.setdefault(
                key,
                dict(
                    id=key,
                    name=group["name"] if group else "未分组",
                    assets=0,
                    liabilities=0,
                    count=0,
                ),
            )
            row["assets"] += account["asset_amount"]
            row["liabilities"] += account["liability_amount"]
            row["count"] += 1
        for group in group_rows.values():
            group["net_assets"] = group["assets"] - group["liabilities"]
            if any(g["parent_id"] == group["id"] for g in balance["groups"]):
                group["name"] += "（直属）"
        with self.db.read() as s:
            latest = (
                s.query(BillImportRun)
                .filter(BillImportRun.committed_at != None)
                .order_by(BillImportRun.committed_at.desc())
                .first()
            )
            last_import = (
                dict(filename=latest.filename, at=latest.committed_at)
                if latest
                else None
            )
        pending = BillService(self.db).pending_count()
        return dict(
            as_of=day,
            period=(
                period.projection()
                if modern
                else dict(start=start, end=day, preset="custom", latest_data_date=None)
            ),
            account_scope=scope.projection(),
            balance_sheet=balance,
            income_report=(
                {key: income_report[key] for key in ("income", "count", "trend", "categories")}
                if income_report else None
            ),
            investment_report=(
                {key: investment_report[key] for key in ("profit", "ending", "capital_in", "capital_out", "account_count", "trend")}
                if investment_report else None
            ),
            single_accounts=singles,
            month_start=start,
            assets=balance["assets"],
            liabilities=balance["liabilities"],
            net_assets=balance["net_assets"],
            account_count=len(balance["accounts"]),
            groups=sorted(
                group_rows.values(), key=lambda r: (-r["assets"], r["id"] or 0)
            ),
            household=dict(
                income=income_report["income"] if income_report else spending["income"],
                expense=spending["expense"],
                net=(income_report["income"] if income_report else spending["income"])
                - spending["expense"],
                count=spending["count"],
                average_daily=spending["average_daily"],
                refunds=spending["refunds"],
                change=spending["change"],
                change_ratio=spending["change_ratio"],
                previous_start=spending["previous_start"],
                previous_end=spending["previous_end"],
                categories=[r for r in spending["parents"] if r["amount"] > 0][:4],
                unknown_amount=spending["unknown_amount"],
                frequent_count=len(spending["frequent_merchants"]),
                large_count=spending["large_count"],
                trend=spending["trend"],
            ),
            investments=dict(
                assets=investments["ending"],
                profit=investments["profit"],
                account_count=investments["account_count"],
                last_valuation=max(
                    (
                        a["last_valuation"]
                        for a in investments["accounts"]
                        if a["last_valuation"]
                    ),
                    default=None,
                ),
            ),
            pending_count=pending,
            last_import=last_import,
            last_activity=activity[0]["occurred_at"] if activity else None,
            recent=recent,
        )
