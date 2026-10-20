from pathlib import Path
import json
from urllib.parse import quote
from fastapi import Request, UploadFile, File
from fastapi.responses import Response
from starlette.concurrency import run_in_threadpool
from ..domain import DomainError
from ..bills import BillDocument
from ..uploads import read_upload


def register(self):
    app = self.app

    @app.get("/api/bills/association-candidates")
    def association_candidates(bill_id: str):
        return self.associations.candidates(bill_id)

    @app.post("/api/bills/associate")
    def associate_bills(data: dict):
        return self.associations.link(
            data.get("source_id"), data.get("target_id"), data.get("note")
        )

    @app.post("/api/bills/confirmed-transfer")
    def confirm_transfer(data: dict):
        from ..confirmed_transfers import ConfirmedTransferService

        return ConfirmedTransferService(self.db).confirm(data)

    @app.post("/api/internal-transfers/match")
    def match_internal_transfers():
        return self.transfers.auto()

    @app.get("/api/imports")
    def imports():
        return self.imports.batches()

    @app.post("/api/imports")
    async def upload(file: UploadFile = File(...), start_at: str = None):
        content = await read_upload(file)
        return await run_in_threadpool(
            self.workflow.stage,
            content,
            Path(file.filename or "账单.csv").name,
            start_at=start_at,
        )

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
        content = await read_upload(file)
        return await run_in_threadpool(
            self.refunds.apply,
            key,
            content,
            Path(file.filename or "AI退款匹配结果.json").name,
        )

    @app.get("/api/imports/{key}/rows")
    def rows(key: int):
        return self.imports.rows(key)

    @app.put("/api/import-rows/{key}")
    def decide(key: int, data: dict):
        return self.imports.decide(key, data)

    @app.post("/api/imports/{key}/commit")
    def commit(key: int):
        from ..models import Bill, ImportRow

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
        if request.query_params.get("page"):
            from ..bill_pages import BillPageService

            return BillPageService(self.db).page(self.period_filters(request))
        return self.bills.list(self.period_filters(request))

    @app.get("/api/bills/export")
    def export_bills(request: Request):
        doc = self.bills.export(self.period_filters(request))
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
        content = await read_upload(file)
        return await run_in_threadpool(
            self.workflow.classify,
            key,
            content,
            Path(file.filename or "AI分类账单.json").name,
        )

    @app.post("/api/import-runs/{key}/original")
    async def attach_original(key: int, file: UploadFile = File(...)):
        content = await read_upload(file)
        return await run_in_threadpool(
            self.workflow.attach_legacy_original,
            key,
            content,
            Path(file.filename or "原账单.csv").name,
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
