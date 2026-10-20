import csv, io
from fastapi import Request
from fastapi.responses import Response
from ..domain import Clock
from ..overview_period import OverviewPeriod
from ..contracts import TransactionCommand


def register(self):
    app = self.app

    @app.get("/api/reports/period")
    def report_period(request: Request):
        return dict(
            OverviewPeriod(self.db, dict(request.query_params)).projection(),
            today=Clock.now()[:10],
        )

    @app.get("/api/reports/single-accounts")
    def single_account_analysis(
        request: Request, start: str = None, end: str = None, account_id: int = None
    ):
        filters = self.period_filters(request)
        return self.single_accounts.analyze(
            filters.get("start"), filters.get("end"), account_id
        )

    @app.get("/api/health")
    def health():
        return {"ok": True, "name": "有数", "version": app.version}

    @app.get("/api/reports/counterparties")
    def counterparties(request: Request, account_id: int):
        return self.counterparties.analyze(account_id, self.period_filters(request))

    @app.get("/api/reports/investments")
    def investments(
        request: Request,
        account_id: int = None,
        start: str = None,
        end: str = None,
        grain: str = "month",
    ):
        filters = self.period_filters(request)
        return self.investments.analyze(
            account_id, filters.get("start"), filters.get("end"), grain
        )

    @app.get("/api/transactions")
    def transactions(request: Request):
        f = self.period_filters(request)
        return (
            self.reports.page(f, audit=f.get("audit") == "true")
            if f.get("page")
            else self.reports.list(f, audit=f.get("audit") == "true")
        )

    @app.get("/api/reports/balance-sheet")
    def balance_sheet(as_of: str = None, group_id: int = None):
        return self.balance_sheet.snapshot(as_of, group_id)

    @app.get("/api/reports/analysis")
    def financial_analysis(
        request: Request,
        grain: str = "day",
        level: int = 1,
        large_amount: str = None,
        large_income_amount: str = None,
        large_expense_amount: str = None,
        group_id: int = None,
        account_id: int = None,
        category_id: int = None,
    ):
        return self.financial_analysis.analyze(
            self.period_filters(request), grain, level, large_amount
        )

    @app.get("/api/reports/fund-flows")
    def fund_flows(
        request: Request,
        start: str = None,
        end: str = None,
        group_id: int = None,
        account_id: int = None,
    ):
        return self.fund_flows.analyze(self.period_filters(request))

    @app.get("/api/reports/fund-boundaries")
    def fund_boundaries(
        request: Request,
        start: str = None,
        end: str = None,
        group_id: int = None,
        account_id: int = None,
    ):
        return self.fund_boundaries.analyze(self.period_filters(request))

    @app.get("/api/reports/expenses")
    def expense_analysis(
        request: Request,
        large_amount: str = None,
        group_id: int = None,
        account_id: int = None,
        category_id: int = None,
        excluded_account_ids: str = None,
        exact_category: bool = False,
        direct_group: bool = False,
    ):
        return self.expenses.analyze(self.period_filters(request), large_amount)

    @app.get("/api/reports/income")
    def income_analysis(
        request: Request,
        grain: str = "day",
        level: int = 1,
        large_amount: str = None,
        group_id: int = None,
        account_id: int = None,
        category_id: int = None,
        direct_group: bool = False,
        excluded_account_ids: str = None,
    ):
        return self.incomes.analyze(
            self.period_filters(request), grain, level, large_amount
        )

    @app.get("/api/reports/overview")
    def overview(request: Request, as_of: str = None):
        filters = self.period_filters(request)
        filters.pop("as_of", None)
        return self.overview.snapshot(as_of, filters)

    @app.get("/api/reports/overview/details")
    def overview_details(
        request: Request,
        section: str,
        as_of: str = None,
        day: str = None,
        cumulative: bool = False,
        group_id: int = None,
    ):
        return self.overview.details(
            section, as_of, day, cumulative, group_id, self.period_filters(request)
        )

    @app.get("/api/transactions/{key}")
    def transaction_detail(key: int):
        return self.reports.detail(key)

    @app.get("/api/workspace")
    def workspace():
        with self.db.read() as session:
            return dict(
                accounts=self.accounts.list(),
                groups=self.account_groups.list(),
                categories=self.catalog.categories(),
                tags=self.catalog.tags(),
                pending_bill_count=self.bills.pending_count(),
                revision=session.info["revision"],
            )

    @app.post("/api/transactions")
    def post(data: TransactionCommand):
        return self.transactions.post(data.model_dump(exclude_unset=True))

    @app.post("/api/transactions/{key}/reverse")
    def reverse(key: int):
        return self.transactions.reverse(key)

    @app.post("/api/transactions/{key}/replace")
    def replace(key: int, data: TransactionCommand):
        return self.transactions.replace(key, data.model_dump(exclude_unset=True))

    @app.get("/api/reports/summary")
    def summary(request: Request):
        return self.reports.summary(self.period_filters(request))

    @app.get("/api/reports/saved")
    def saved():
        return self.reports.saved()

    @app.post("/api/reports/saved")
    def save(data: dict):
        return self.reports.save(data)

    @app.get("/api/integrity")
    def integrity():
        return self.reports.integrity()

    @app.get("/api/export")
    def export(request: Request):
        rows = self.reports.list(self.period_filters(request))
        output = io.StringIO()
        w = csv.writer(output)
        w.writerow(
            [
                "编号",
                "时间",
                "类型",
                "金额（元）",
                "交易对方",
                "账户",
                "分类",
                "标签",
                "备注",
                "来源",
            ]
        )

        def safe(v):
            v = str(v)
            return "'" + v if v.lstrip().startswith(("=", "+", "-", "@")) else v

        labels = {
            "EXPENSE": "支出",
            "INCOME": "收入",
            "TRANSFER": "转账",
            "REFUND": "退款",
            "OPENING": "期初",
        }
        for r in rows:
            w.writerow(
                [
                    r["id"],
                    r["occurred_at"],
                    labels.get(r["kind"], r["kind"]),
                    format(r["amount"] / 100, ".2f"),
                    safe(r["counterparty"]),
                    safe(
                        "、".join(
                            e["account"] for e in r["entries"] if e["role"] != "SYSTEM"
                        )
                    ),
                    safe(
                        "、".join(e["category"] for e in r["entries"] if e["category"])
                    ),
                    safe("、".join(r["tags"])),
                    safe(r["note"]),
                    r["source"],
                ]
            )
        return Response(
            ("\ufeff" + output.getvalue()).encode("utf-8"),
            media_type="text/csv",
            headers={"Content-Disposition": 'attachment; filename="ledger.csv"'},
        )
