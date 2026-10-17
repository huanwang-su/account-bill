from pathlib import Path
import os, json, csv, io, tempfile, sqlite3
from urllib.parse import urlparse, quote
from threading import RLock
from fastapi import FastAPI, Request, UploadFile, File
from fastapi.responses import JSONResponse, FileResponse, Response
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.trustedhost import TrustedHostMiddleware
from starlette.background import BackgroundTask
from sqlalchemy.exc import IntegrityError
from .database import Database, ProcessLease
from .domain import DomainError, Clock
from .services import AccountService, CatalogService, TransactionService, ReportService
from .importers import ImportService
from .bills import BillService, BillDocument
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
from .securities import SecuritiesValuationService
from .counterparty_analysis import CounterpartyAnalysisService
from .investment_analysis import InvestmentAnalysisService

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
        self.securities = SecuritiesValuationService(self.db)
        self.counterparties = CounterpartyAnalysisService(self.db)
        self.investments = InvestmentAnalysisService(self.db)
        self.imports = ImportService(self.db)
        self.imports.link_existing_pouches()
        self.bills = BillService(self.db)
        self.workflow = BillImportWorkflow(self.db)
        self.refunds = RefundMatchService(self.db)
        self.policy = ClassificationPolicyService(self.db)
        self.transfers = TransferMatchService(self.db)
        self.associations = BillAssociationService(self.db)
        self.workflow.recover_legacy()
        self.posting = BillPostingService(self.db)
        self.posting.backfill()
        BillStatusService(self.db).apply_existing()
        self.lock = RLock()
        self.app = FastAPI(title="有数 · 本地账本", version="0.18.0")
        self.app.add_middleware(
            TrustedHostMiddleware,
            allowed_hosts=["127.0.0.1", "localhost", "testserver"],
        )
        self._routes()

    def _routes(self):
        app = self.app

        @app.get("/api/bills/association-candidates")
        def association_candidates(bill_id: str):
            return self.associations.candidates(bill_id)

        @app.post("/api/bills/associate")
        def associate_bills(data: dict):
            return self.associations.link(
                data.get("source_id"), data.get("target_id"), data.get("note")
            )

        @app.get("/api/classification-policy")
        def classification_policy():
            return self.policy.get()

        @app.put("/api/classification-policy")
        def save_classification_policy(data: dict):
            return self.policy.save(data)

        @app.get("/api/classification-policy/reference")
        def policy_reference():
            return Response(
                json.dumps(self.policy.reference(), ensure_ascii=False, indent=2),
                media_type="application/json",
                headers={
                    "Content-Disposition": "attachment; filename=ai-classification-reference.json"
                },
            )

        @app.post("/api/classification-policy/reprocess")
        def reprocess_pending():
            return self.policy.reprocess()

        @app.post("/api/bills/confirmed-transfer")
        def confirm_transfer(data: dict):
            from .confirmed_transfers import ConfirmedTransferService

            return ConfirmedTransferService(self.db).confirm(data)

        @app.post("/api/internal-transfers/match")
        def match_internal_transfers():
            return self.transfers.auto()

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

        @app.get("/api/health")
        def health():
            return {"ok": True, "name": "有数", "version": app.version}

        @app.get("/api/account-groups")
        def groups():
            return self.account_groups.list()

        @app.post("/api/account-groups")
        def create_group(data: dict):
            return self.account_groups.save(data)

        @app.put("/api/account-groups/{key}")
        def edit_group(key: int, data: dict):
            return self.account_groups.save(data, key)

        @app.post("/api/account-groups/assign")
        def assign_group(data: dict):
            return self.account_groups.assign(data.get("group_id"), data["account_ids"])

        @app.post("/api/account-merges/preview")
        def preview_merge(data: dict):
            return self.account_merges.preview(data["source_id"], data["target_id"])

        @app.post("/api/account-merges")
        def merge_account(data: dict):
            return self.account_merges.merge(data)

        @app.post("/api/account-merges/{key}/undo")
        def undo_merge(key: int):
            return self.account_merges.unmerge(key)

        @app.get("/api/account-merges")
        def merge_history():
            return self.account_merges.history()

        @app.get("/api/accounts")
        def accounts():
            return self.accounts.list()

        @app.post("/api/accounts")
        def create_account(data: dict):
            return self.accounts.save(data)

        @app.put("/api/accounts/{key}")
        def edit_account(key: int, data: dict):
            return self.accounts.save(data, key)

        @app.post("/api/accounts/{key}/opening")
        def opening(key: int, data: dict):
            return self.accounts.opening(key, data)

        @app.post("/api/accounts/{key}/reconcile")
        def reconcile(key: int, data: dict):
            return self.accounts.reconcile(key, data)

        @app.get("/api/accounts/{key}/valuations")
        def valuations(key: int):
            return self.securities.history(key)

        @app.post("/api/accounts/{key}/valuations")
        def update_valuation(key: int, data: dict):
            return self.securities.update(key, data)

        @app.get("/api/reports/counterparties")
        def counterparties(request: Request, account_id: int):
            return self.counterparties.analyze(account_id, dict(request.query_params))

        @app.get("/api/reports/investments")
        def investments(
            account_id: int = None,
            start: str = None,
            end: str = None,
            grain: str = "month",
        ):
            return self.investments.analyze(account_id, start, end, grain)

        @app.get("/api/categories")
        def categories():
            return self.catalog.categories()

        @app.post("/api/categories")
        def create_category(data: dict):
            return self.catalog.save_category(data)

        @app.put("/api/categories/{key}")
        def edit_category(key: int, data: dict):
            return self.catalog.save_category(data, key)

        @app.get("/api/tags")
        def tags():
            return self.catalog.tags()

        @app.post("/api/tags")
        def create_tag(data: dict):
            return self.catalog.save_tag(data)

        @app.put("/api/tags/{key}")
        def edit_tag(key: int, data: dict):
            return self.catalog.save_tag(data, key)

        @app.post("/api/tags/{key}/activation")
        def tag_activation(key: int, data: dict):
            return self.catalog.set_tag_active(key, data.get("active"))

        @app.get("/api/transactions")
        def transactions(request: Request):
            f = dict(request.query_params)
            return self.reports.list(f, audit=f.get("audit") == "true")

        @app.get("/api/reports/balance-sheet")
        def balance_sheet(as_of: str = None, group_id: int = None):
            return self.balance_sheet.snapshot(as_of, group_id)

        @app.get("/api/reports/analysis")
        def financial_analysis(
            request: Request,
            grain: str = "day",
            level: int = 1,
            large_amount: str = "1000.00",
            group_id: int = None,
            account_id: int = None,
            category_id: int = None,
        ):
            return self.financial_analysis.analyze(
                dict(request.query_params), grain, level, large_amount
            )

        @app.post("/api/transactions")
        def post(data: dict):
            return self.transactions.post(data)

        @app.post("/api/transactions/{key}/reverse")
        def reverse(key: int):
            return self.transactions.reverse(key)

        @app.post("/api/transactions/{key}/replace")
        def replace(key: int, data: dict):
            return self.transactions.replace(key, data)

        @app.get("/api/reports/summary")
        def summary(request: Request):
            return self.reports.summary(dict(request.query_params))

        @app.get("/api/reports/saved")
        def saved():
            return self.reports.saved()

        @app.post("/api/reports/saved")
        def save(data: dict):
            return self.reports.save(data)

        @app.get("/api/integrity")
        def integrity():
            return self.reports.integrity()

        @app.get("/api/imports")
        def imports():
            return self.imports.batches()

        @app.post("/api/imports")
        async def upload(file: UploadFile = File(...)):
            content = await file.read(10 * 1024 * 1024 + 1)
            if len(content) > 10 * 1024 * 1024:
                raise DomainError("文件不能超过 10 MB")
            return self.workflow.stage(content, Path(file.filename or "账单.csv").name)

        @app.get("/api/import-runs/{key}/refund-candidates")
        def refund_candidates(key: int):
            return Response(
                json.dumps(
                    self.refunds.candidates(key), ensure_ascii=False, indent=2
                ).encode(),
                media_type="application/json",
                headers={
                    "Content-Disposition": "attachment; filename=refund-candidates.json"
                },
            )

        @app.post("/api/import-runs/{key}/refund-matches")
        async def match_refunds(key: int, file: UploadFile = File(...)):
            content = await file.read(10 * 1024 * 1024 + 1)
            if len(content) > 10 * 1024 * 1024:
                raise DomainError("文件不能超过 10 MB")
            return self.refunds.apply(
                key, content, Path(file.filename or "AI退款匹配结果.json").name
            )

        @app.get("/api/imports/{key}/rows")
        def rows(key: int):
            return self.imports.rows(key)

        @app.put("/api/import-rows/{key}")
        def decide(key: int, data: dict):
            return self.imports.decide(key, data)

        @app.post("/api/imports/{key}/commit")
        def commit(key: int):
            from .models import Bill, ImportRow

            with self.db.read() as s:
                if any(
                    s.get(Bill, row.source_key) is None
                    for row in s.query(ImportRow).filter_by(batch_id=key)
                ):
                    raise DomainError("请先完成统一账单分类并导入明细，再核对特殊记录")
            return self.imports.commit(key)

        @app.post("/api/bills/reverse")
        def reverse_bill(data: dict):
            return self.posting.reverse(data.get("bill_id"))

        @app.post("/api/bills/resolve")
        def resolve_bill(data: dict):
            return self.posting.resolve(data.get("bill_id"), data)

        @app.post("/api/import-runs/{key}/cancel")
        def cancel_run(key: int):
            return self.workflow.cancel(key)

        @app.get("/api/bills")
        def bills(request: Request):
            return self.bills.list(dict(request.query_params))

        @app.get("/api/bills/export")
        def export_bills(request: Request):
            doc = self.bills.export(dict(request.query_params))
            return Response(
                doc.model_dump_json(indent=2),
                media_type="application/json",
                headers={
                    "Content-Disposition": 'attachment; filename="unified-bills.json"'
                },
            )

        @app.get("/api/import-runs")
        def import_runs():
            return self.workflow.list()

        @app.get("/api/import-runs/{key}")
        def import_run(key: int):
            return self.workflow.detail(key)

        @app.get("/api/import-artifacts/{key}")
        def artifact(key: int):
            filename, content = self.workflow.download(key)
            return Response(
                content,
                media_type="application/octet-stream",
                headers={
                    "Content-Disposition": "attachment; filename*=UTF-8''"
                    + quote(filename),
                    "X-Content-Type-Options": "nosniff",
                },
            )

        @app.post("/api/import-runs/{key}/classifications")
        async def classify_run(key: int, file: UploadFile = File(...)):
            content = await file.read(10 * 1024 * 1024 + 1)
            if len(content) > 10 * 1024 * 1024:
                raise DomainError("分类文件不能超过 10 MB")
            return self.workflow.classify(
                key, content, Path(file.filename or "AI分类账单.json").name
            )

        @app.post("/api/import-runs/{key}/original")
        async def attach_original(key: int, file: UploadFile = File(...)):
            content = await file.read(10 * 1024 * 1024 + 1)
            if len(content) > 10 * 1024 * 1024:
                raise DomainError("文件不能超过 10 MB")
            return self.workflow.attach_legacy_original(
                key, content, Path(file.filename or "原账单.csv").name
            )

        @app.post("/api/import-runs/{key}/commit")
        def publish_run(key: int):
            return self.workflow.commit(key)

        @app.post("/api/bills/import")
        def import_bills():
            raise DomainError("请在账单导入页选择批次，保存分类文件后再导入交易明细")

        @app.post("/api/bills/classifications")
        def save_classifications(data: dict):
            return self.bills.save(BillDocument.read(json.dumps(data)))

        @app.get("/api/bills/history")
        def bill_history(bill_id: str):
            return self.bills.history(bill_id)

        @app.get("/api/backup")
        def backup():
            fd, path = tempfile.mkstemp(suffix=".sqlite3")
            os.close(fd)
            self.db.backup(path)
            return FileResponse(
                path,
                filename="有数备份-"
                + Clock.now().replace(":", "-").replace(" ", "_")
                + ".sqlite3",
                background=BackgroundTask(lambda: os.unlink(path)),
            )

        @app.get("/api/export")
        def export(request: Request):
            rows = self.reports.list(dict(request.query_params))
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
                                e["account"]
                                for e in r["entries"]
                                if e["role"] != "SYSTEM"
                            )
                        ),
                        safe(
                            "、".join(
                                e["category"] for e in r["entries"] if e["category"]
                            )
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

        dist = ROOT / "frontend" / "dist"
        if dist.exists():
            app.mount("/", StaticFiles(directory=dist, html=True), name="frontend")


def create_app():
    return LedgerApplication().app
