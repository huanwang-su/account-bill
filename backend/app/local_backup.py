"""Project-local encrypted exports using the configured environment password."""

import os
import secrets
import shlex
import sqlite3
import tempfile
from datetime import datetime
from pathlib import Path

from .backup_encryption import BackupEncryption
from .data_backup import BackupRecords, DataBackupService
from .database import Database
from .domain import DomainError


class LocalBackupSettings:
    PASSWORD_KEY = "ACCOUNT-BILL-PWD"

    def __init__(self, root, environ=None):
        self.root = Path(root).resolve()
        self.environ = os.environ if environ is None else environ

    def password(self):
        # A hyphenated environment key is valid in a process environment, but
        # cannot be assigned with shell `export`; read it without sourcing code.
        if self.PASSWORD_KEY not in self.environ:
            path = self.root / ".env.local"
            if path.is_file():
                value = None
                for line in path.read_text(encoding="utf-8").splitlines():
                    key, separator, raw = line.partition("=")
                    if separator and key.strip() == self.PASSWORD_KEY:
                        try:
                            parts = shlex.split(raw, comments=True, posix=True)
                        except ValueError:
                            raise DomainError(
                                ".env.local 中的备份密码格式不正确"
                            ) from None
                        if len(parts) > 1:
                            raise DomainError("备份密码含空格时请使用引号包围")
                        value = parts[0] if parts else ""
                if value is not None:
                    self.environ[self.PASSWORD_KEY] = value
        password = self.environ.get(self.PASSWORD_KEY, "")
        if not password:
            raise DomainError(
                "请先在 .env.local 配置 ACCOUNT-BILL-PWD，默认备份必须加密"
            )
        BackupEncryption.password(password)
        return password


class LocalBackupExporter:
    def __init__(self, root, settings=None):
        self.root = Path(root).resolve()
        self.settings = settings or LocalBackupSettings(self.root)

    def export(self, database=None, output_dir=None):
        password = self.settings.password()
        source = Path(database or self.root / "data" / "ledger.sqlite3").resolve()
        if not source.is_file():
            raise DomainError("账本数据库不存在，请先确认工程的数据目录")
        folder = Path(output_dir or self.root / "backups").resolve()
        database = Database(source)
        try:
            # Reuse the website's business-only format; never initialize or
            # migrate the live database as part of a backup operation.
            with sqlite3.connect(source.as_uri() + "?mode=ro", uri=True) as connection:
                version = connection.execute(
                    "SELECT version_num FROM alembic_version"
                ).fetchone()[0]
            encrypted = DataBackupService(database).download(password)
            plain = BackupEncryption.open(encrypted, password)
            _, manifest = BackupRecords.decode(plain, version)
        finally:
            database.engine.dispose()
        folder.mkdir(parents=True, exist_ok=True, mode=0o700)
        name = (
            "account-bill-"
            + datetime.now().strftime("%Y%m%d-%H%M%S")
            + "-"
            + secrets.token_hex(4)
            + ".ledger.zip"
        )
        destination = folder / name
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(
                dir=folder, prefix=".backup-", suffix=".tmp", delete=False
            ) as output:
                temporary = Path(output.name)
                output.write(encrypted)
                output.flush()
                os.fsync(output.fileno())
            # Verify the bytes on disk before publishing the completed file.
            if BackupEncryption.open(temporary.read_bytes(), password) != plain:
                raise DomainError("备份写入校验失败，未生成备份文件")
            # Publishing a hard link is atomic and refuses to overwrite an
            # existing backup, even if the generated name happens to collide.
            os.link(temporary, destination)
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)
        return dict(
            path=destination,
            size=len(encrypted),
            created_at=manifest.created_at,
            counts=manifest.counts,
        )
