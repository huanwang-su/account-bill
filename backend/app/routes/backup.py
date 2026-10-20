import os, tempfile
from urllib.parse import quote
from fastapi import UploadFile, File, Form
from fastapi.responses import FileResponse, Response
from starlette.background import BackgroundTask
from starlette.concurrency import run_in_threadpool
from ..domain import Clock
from ..data_backup import BackupRecords


def register(self):
    app = self.app

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

    @app.get("/api/data-backup")
    def download_business_backup():
        return business_backup_response("")

    def business_backup_response(password, recovery_filename=None):
        content = self.data_backup.download(password, recovery_filename)
        filename = (
            "有数账本-"
            + Clock.now().replace(":", "-").replace(" ", "_")
            + ".ledger.zip"
        )
        if recovery_filename is not None:
            filename = recovery_filename
        return Response(
            content,
            media_type="application/zip",
            headers={
                "Content-Disposition": "attachment; filename*=UTF-8''" + quote(filename)
            },
        )

    @app.post("/api/data-backup")
    def download_protected_backup(data: dict):
        return business_backup_response(data.get("password", ""))

    @app.post("/api/data-backup/validate")
    async def validate_business_backup(
        file: UploadFile = File(...), password: str = Form(default="")
    ):
        try:
            content = await file.read(BackupRecords.MAX_UPLOAD + 1)
            return await run_in_threadpool(
                self.data_backup.prepare,
                content,
                file.filename or "账本备份.ledger.zip",
                password,
            )
        finally:
            await file.close()

    @app.post("/api/data-backup/restore")
    def restore_business_backup(data: dict):
        return self.data_backup.restore(data.get("token"), data.get("confirmation"))

    @app.delete("/api/data-backup/validation/{token}")
    def discard_business_backup(token: str):
        return self.data_backup.discard(token)

    @app.get("/api/data-backup/recovery/{filename}")
    def recovery_business_backup(filename: str):
        return FileResponse(
            self.data_backup.recovery(filename),
            filename=filename,
            media_type="application/zip",
        )

    @app.post("/api/data-backup/recovery/{filename}")
    def download_protected_recovery(filename: str, data: dict):
        return business_backup_response(data.get("password", ""), filename)
