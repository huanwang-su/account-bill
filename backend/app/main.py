from pathlib import Path
import os
from urllib.parse import urlparse
from threading import RLock
from fastapi import FastAPI
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.trustedhost import TrustedHostMiddleware
from sqlalchemy.exc import IntegrityError
from .database import Database, ProcessLease
from .domain import DomainError
from .services import AccountService, CatalogService, TransactionService, ReportService
from .importers import ImportService
from .bills import BillService
from .import_workflow import BillImportWorkflow
from .bill_posting import BillPostingService
from .bill_status import BillStatusService
from .refund_matching import RefundMatchService
from .account_config import AccountMergeService, AccountGroupService
from .classification_policy import ClassificationPolicyService
from .transfer_matching import TransferMatchService
from .bill_associations import BillAssociationService
from .balance_sheet import BalanceSheetService
from .financial_analysis import FinancialAnalysisService
from .fund_flows import FundFlowService
from .fund_boundaries import FundBoundaryService
from .securities import SecuritiesValuationService
from .counterparty_analysis import CounterpartyAnalysisService
from .investment_analysis import InvestmentAnalysisService
from .expense_analysis import ExpenseAnalysisService
from .overview import OverviewService
from .overview_period import OverviewPeriod
from .income_analysis import IncomeAnalysisService
from .analysis_settings import AnalysisSettingsService
from .single_account_analysis import SingleAccountAnalysisService
from .data_backup import DataBackupService

ROOT = Path(__file__).resolve().parents[2]


class LedgerApplication:
    def __init__(self, path=None):
        self.db = Database(
            path or os.environ.get("LEDGER_DB", ROOT / "data" / "ledger.sqlite3")
        )
        self.lease = ProcessLease(self.db.path)
        self.db.initialize()
        self.accounts = AccountService(self.db)
        self.catalog = CatalogService(self.db)
        self.account_merges = AccountMergeService(self.db)
        self.account_groups = AccountGroupService(self.db)
        self.transactions = TransactionService(self.db)
        self.reports = ReportService(self.db)
        self.balance_sheet = BalanceSheetService(self.db)
        self.financial_analysis = FinancialAnalysisService(self.db)
        self.fund_flows = FundFlowService(self.db)
        self.fund_boundaries = FundBoundaryService(self.db, self.fund_flows)
        self.securities = SecuritiesValuationService(self.db)
        self.counterparties = CounterpartyAnalysisService(self.db)
        self.investments = InvestmentAnalysisService(self.db)
        self.expenses = ExpenseAnalysisService(self.db)
        self.incomes = IncomeAnalysisService(self.db)
        self.analysis_settings = AnalysisSettingsService(self.db)
        self.single_accounts = SingleAccountAnalysisService(self.db)
        self.overview = OverviewService(self.db)
        self.imports = ImportService(self.db)
        self.bills = BillService(self.db)
        self.workflow = BillImportWorkflow(self.db)
        self.refunds = RefundMatchService(self.db)
        self.policy = ClassificationPolicyService(self.db)
        self.transfers = TransferMatchService(self.db)
        self.associations = BillAssociationService(self.db)
        self.posting = BillPostingService(self.db)
        from .maintenance import MaintenanceRunner

        def upgrade_legacy():
            self.imports.link_existing_pouches()
            self.workflow.recover_legacy()
            self.posting.backfill()
            BillStatusService(self.db).apply_existing()

        MaintenanceRunner(self.db).run("legacy-bill-links-v1", upgrade_legacy)
        self.lock = RLock()
        self.data_backup = DataBackupService(self.db)
        self.app = FastAPI(title="有数 · 本地账本", version="0.18.0")
        self.app.add_middleware(
            TrustedHostMiddleware,
            allowed_hosts=["127.0.0.1", "localhost", "testserver"],
        )
        self._routes()

    def period_filters(self, request):
        values = dict(request.query_params)
        if values.get("period") == "all" and request.url.path in (
            "/api/bills",
            "/api/bills/export",
        ):
            return {
                key: value
                for key, value in values.items()
                if key not in ("period", "start", "end")
            }
        if values.get("period"):
            if values["period"] not in (
                "latest_month",
                "1m",
                "3m",
                "6m",
                "1y",
                "custom",
            ):
                raise DomainError("请选择有效的统计时间范围")
            # Explicit dates from a chart drilldown remain narrower than its preset.
            if not (values.get("start") and values.get("end")):
                period = OverviewPeriod(self.db, values).projection()
                values.update(start=period["start"], end=period["end"])
        return values

    def _routes(self):
        app = self.app

        @app.middleware("http")
        async def local_only(request, call_next):
            origin = request.headers.get("origin")
            if origin and urlparse(origin).netloc != request.headers.get("host"):
                return JSONResponse({"detail": "仅允许同源访问"}, status_code=403)
            if (
                request.method not in ("GET", "HEAD", "OPTIONS")
                and request.headers.get("x-ledger-client") != "local-web"
            ):
                return JSONResponse(
                    {"detail": "请求缺少本地客户端标识"}, status_code=403
                )
            response = await call_next(request)
            response.headers["X-Content-Type-Options"] = "nosniff"
            if request.url.path.startswith("/assets/") and response.status_code == 200:
                response.headers["Cache-Control"] = (
                    "public, max-age=31536000, immutable"
                )
            else:
                response.headers["Cache-Control"] = "no-store"
            return response

        @app.exception_handler(DomainError)
        async def invalid(_, error):
            return JSONResponse({"detail": str(error)}, status_code=400)

        @app.exception_handler(IntegrityError)
        async def conflict(_, error):
            return JSONResponse({"detail": "数据冲突，请刷新后重试"}, status_code=409)

        @app.exception_handler(KeyError)
        async def missing(_, error):
            return JSONResponse(
                {"detail": "缺少必填字段：" + str(error)}, status_code=400
            )

        from .routes import accounts, catalog, reports, imports, backup

        for routes in (accounts, catalog, reports, imports, backup):
            routes.register(self)

        dist = ROOT / "frontend" / "dist"
        if dist.exists():
            app.mount("/", StaticFiles(directory=dist, html=True), name="frontend")


def create_app():
    return LedgerApplication().app
