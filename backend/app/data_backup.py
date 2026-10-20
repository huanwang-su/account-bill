"""Portable business records, validated staging and atomic online replacement.

The archive contains JSON records, never uploaded SQL or executable schemas.
Import artifact metadata survives; its binary/file contents are deliberately omitted.
"""

import hashlib
import io
import json
import secrets
import sqlite3
import tempfile
import time
import zipfile
import zlib
from pathlib import Path
from threading import RLock
from pydantic import BaseModel, ConfigDict, Field, StrictInt
from typing import Literal
from sqlalchemy import Integer, Boolean, LargeBinary
from .database import Database
from .domain import Clock, DomainError, Money
from .models import Base
from .bills import BillFacts, BillClassification, BillNormalizer
from .analysis_settings import AnalysisSettingsValues, AnalysisSettingsService
from .classification_policy import PolicyValues
from .backup_encryption import BackupEncryption


class BackupManifest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    format: Literal["youshu.business-backup.v1"]
    schema_version: str = Field(min_length=1, max_length=32)
    created_at: str = Field(max_length=32)
    file_contents_included: Literal[False]
    sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    counts: dict[str, StrictInt]


class BackupRecords:
    TABLES = dict(Base.metadata.tables)
    MAX_UPLOAD = 64 * 1024 * 1024
    MAX_DATA = 256 * 1024 * 1024

    @staticmethod
    def json_bytes(value):
        return json.dumps(
            value,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
            allow_nan=False,
        ).encode()

    @staticmethod
    def load_json(content):
        def unique(pairs):
            result = {}
            for key, value in pairs:
                if key in result:
                    raise ValueError("duplicate key")
                result[key] = value
            return result

        def invalid(_):
            raise ValueError("nonfinite number")

        return json.loads(content, object_pairs_hook=unique, parse_constant=invalid)

    @classmethod
    def snapshot(cls, db):
        tables = {}
        fingerprint = hashlib.sha256()
        with db.barrier.shared(), sqlite3.connect(db.path) as connection:
            connection.row_factory = sqlite3.Row
            connection.execute("BEGIN")
            version = connection.execute(
                "SELECT version_num FROM alembic_version"
            ).fetchone()[0]
            fingerprint.update(version.encode())
            for name, table in sorted(cls.TABLES.items()):
                order = ",".join(f'"{column.name}"' for column in table.primary_key)
                names = [
                    column.name
                    for column in table.columns
                    if not isinstance(column.type, LargeBinary)
                ]
                selected = ",".join('"' + column + '"' for column in names)
                rows = connection.execute(
                    f'SELECT {selected} FROM "{name}" ORDER BY {order}'
                ).fetchall()
                records = []
                for row in rows:
                    record = dict(row)
                    digest_record = {
                        key: (
                            hashlib.sha256(value).hexdigest()
                            if isinstance(value, bytes)
                            else value
                        )
                        for key, value in record.items()
                    }
                    fingerprint.update(cls.json_bytes([name, digest_record]))
                    if name == "bill_import_artifacts":
                        record.pop("content", None)
                    records.append(record)
                tables[name] = records
        return version, tables, fingerprint.hexdigest()

    @classmethod
    def encode(cls, version, tables):
        content = cls.json_bytes({"tables": tables})
        manifest = BackupManifest(
            format="youshu.business-backup.v1",
            schema_version=version,
            created_at=Clock.now(),
            file_contents_included=False,
            sha256=hashlib.sha256(content).hexdigest(),
            counts={name: len(rows) for name, rows in tables.items()},
        )
        output = io.BytesIO()
        with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            archive.comment = secrets.token_hex(16).encode("ascii")
            archive.writestr("manifest.json", cls.json_bytes(manifest.model_dump()))
            archive.writestr("data.json", content)
        return output.getvalue(), manifest

    @classmethod
    def decode(cls, content, schema_version):
        try:
            if not content or len(content) > cls.MAX_UPLOAD:
                raise DomainError("请选择不超过 64 MB 的账本备份")
            with zipfile.ZipFile(io.BytesIO(content)) as archive:
                files = archive.infolist()
                if len(files) != 2 or {item.filename for item in files} != {
                    "manifest.json",
                    "data.json",
                }:
                    raise DomainError("备份文件结构错误，应包含清单和业务数据")
                if any(
                    item.flag_bits & 1
                    or item.compress_type
                    not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED)
                    for item in files
                ):
                    raise DomainError("不支持加密或特殊压缩格式的备份")
                if (
                    archive.getinfo("manifest.json").file_size > 65536
                    or archive.getinfo("data.json").file_size > cls.MAX_DATA
                ):
                    raise DomainError("备份解压后的数据超过限制")
                manifest = BackupManifest.model_validate(
                    cls.load_json(archive.read("manifest.json"))
                )
                if Clock.normalize(manifest.created_at) != manifest.created_at:
                    raise DomainError("备份时间格式错误")
                data = archive.read("data.json")
                if len(data) > cls.MAX_DATA or not secrets.compare_digest(
                    hashlib.sha256(data).hexdigest(), manifest.sha256
                ):
                    raise DomainError("备份校验值不一致，文件可能损坏或被修改")
                payload = cls.load_json(data)
            if (
                type(payload) is not dict
                or set(payload) != {"tables"}
                or type(payload["tables"]) is not dict
            ):
                raise DomainError("备份数据格式错误")
            from .backup_migrations import BackupMigrations

            tables = BackupMigrations.upgrade(
                payload["tables"], manifest.schema_version, schema_version
            )
            if set(tables) != set(cls.TABLES) or set(manifest.counts) != set(
                cls.TABLES
            ):
                raise DomainError("备份缺少业务表或包含不支持的数据表")
            count = 0
            for name, table in cls.TABLES.items():
                rows = tables[name]
                if type(rows) is not list or len(rows) != manifest.counts[name]:
                    raise DomainError("备份记录数量与清单不一致：" + name)
                count += len(rows)
                if count > 1000000:
                    raise DomainError("备份记录数量超过限制")
                columns = {
                    column.name: column
                    for column in table.columns
                    if not isinstance(column.type, LargeBinary)
                }
                for row in rows:
                    if type(row) is not dict or set(row) != set(columns):
                        raise DomainError("备份记录字段不完整：" + name)
                    for key, column in columns.items():
                        value = row[key]
                        if value is None:
                            if not column.nullable or column.primary_key:
                                raise DomainError(
                                    "备份必填字段为空：" + name + "." + key
                                )
                        elif isinstance(column.type, Boolean):
                            if type(value) is not int or value not in (0, 1):
                                raise DomainError(
                                    "备份开关字段格式错误：" + name + "." + key
                                )
                        elif isinstance(column.type, Integer):
                            if type(value) is not int or abs(value) > Money.MAX:
                                raise DomainError(
                                    "备份整数或金额字段格式错误：" + name + "." + key
                                )
                            if (key == "id" or key.endswith("_id")) and value <= 0:
                                raise DomainError("备份编号必须大于零")
                            if key == "revision" and value < 0:
                                raise DomainError("备份修订版本不能为负数")
                        elif type(value) is not str:
                            raise DomainError(
                                "备份文本字段格式错误：" + name + "." + key
                            )
                        elif column.primary_key and not value.strip():
                            raise DomainError("备份编号不能为空")
            return tables, manifest
        except DomainError:
            raise
        except (
            ValueError,
            TypeError,
            KeyError,
            OSError,
            RuntimeError,
            zipfile.BadZipFile,
            zlib.error,
            RecursionError,
        ):
            raise DomainError(
                "无法读取备份，请上传本系统下载的 .ledger.zip 文件"
            ) from None

    @classmethod
    def replace(cls, connection, tables):
        # Names and columns come exclusively from the application's trusted models.
        for name in cls.TABLES:
            connection.execute(f'DELETE FROM "{name}"')
        for name, table in cls.TABLES.items():
            columns = [column.name for column in table.columns]
            names = ",".join(f'"{key}"' for key in columns)
            placeholders = ",".join("?" for _ in columns)
            connection.executemany(
                f'INSERT INTO "{name}" ({names}) VALUES ({placeholders})',
                [
                    [
                        (
                            b""
                            if isinstance(table.columns[key].type, LargeBinary)
                            else row[key]
                        )
                        for key in columns
                    ]
                    for row in tables[name]
                ],
            )


class BackupValidator:
    JSON_FIELDS = {
        "accounts": {"tags": list},
        "transactions": {"tags": list},
        "import_batches": {"metadata_json": dict},
        "import_rows": {"data": dict, "decision": dict},
        "bill_import_runs": {"summary": dict, "result": dict},
        "saved_reports": {"filters": dict},
    }

    @staticmethod
    def acyclic(rows, field, label):
        links = {row["id"]: row[field] for row in rows}
        finished = set()
        for key in links:
            seen = set()
            while key is not None and key not in finished:
                if key in seen:
                    raise DomainError(label + "存在循环关联")
                seen.add(key)
                key = links.get(key)
            finished.update(seen)

    @classmethod
    def check(cls, connection, tables):
        if connection.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise DomainError("备份数据库完整性检查失败")
        if connection.execute("PRAGMA foreign_key_check").fetchone():
            raise DomainError("备份存在无效关联：账户、账单或交易记录缺失")
        if any(
            row["status"]
            not in ("NORMALIZED", "CLASSIFIED", "IMPORTED", "ERROR", "CANCELLED")
            for row in tables["bill_import_runs"]
        ):
            raise DomainError("备份导入批次状态不合法")
        bad = connection.execute(
            """SELECT t.id FROM transactions t LEFT JOIN entries e ON e.transaction_id=t.id
            GROUP BY t.id HAVING COUNT(e.id)<2 OR SUM(e.amount)!=0 LIMIT 1"""
        ).fetchone()
        if bad:
            raise DomainError("备份账目不平衡或流水缺失，交易编号：" + str(bad[0]))
        if connection.execute(
            "SELECT id FROM transactions WHERE kind NOT IN ('INCOME','EXPENSE','TRANSFER','REFUND','OPENING','ADJUSTMENT','REVERSAL') LIMIT 1"
        ).fetchone():
            raise DomainError("备份存在无效交易类型")
        if connection.execute(
            """SELECT b.bill_id FROM bill_ledger b LEFT JOIN transactions t ON t.id=b.transaction_id
            WHERE b.status='POSTED' AND (t.id IS NULL OR t.status!='POSTED') LIMIT 1"""
        ).fetchone():
            raise DomainError("备份入账状态与交易记录不一致")
        if not {"消费", "收入", "期初", "余额调整"} <= {
            row["name"] for row in tables["accounts"] if row["role"] == "SYSTEM"
        }:
            raise DomainError("备份缺少必要的系统账户")
        for name, fields in cls.JSON_FIELDS.items():
            for row in tables[name]:
                for key, expected in fields.items():
                    if (
                        row[key] is not None
                        and type(BackupRecords.load_json(row[key])) is not expected
                    ):
                        raise DomainError(
                            "备份中的业务配置格式错误：" + name + "." + key
                        )
                    if (
                        expected is list
                        and row[key] is not None
                        and any(
                            type(tag) is not str or not tag.strip() or len(tag) > 40
                            for tag in BackupRecords.load_json(row[key])
                        )
                    ):
                        raise DomainError("备份标签格式错误")
        for row in tables["transactions"]:
            if row["purpose"] not in ("GENERAL", "VALUATION", "OPENING"):
                raise DomainError("备份交易用途不合法")
        for row in tables["bills"]:
            BillFacts.model_validate_json(row["facts"])
            if row["classification"] != "null":
                BillClassification.model_validate_json(row["classification"])
        batches = {row["id"]: row for row in tables["import_batches"]}
        normalizer = BillNormalizer()
        for row in tables["import_rows"]:
            raw = BackupRecords.load_json(row["data"])
            if raw.get("error"):
                continue
            provider = BackupRecords.load_json(
                batches[row["batch_id"]]["metadata_json"]
            ).get("parser", "alipay")
            if (
                provider not in normalizer.adapters
                or raw.get("source_key") != row["source_key"]
            ):
                raise DomainError("备份账单来源或流水编号不一致")
            normalizer.adapters[provider].normalize(raw)
        for row in tables["bill_classification_history"]:
            if row["classification"] != "null":
                BillClassification.model_validate_json(row["classification"])
        for row in tables["analysis_settings"]:
            AnalysisSettingsValues.model_validate(
                BackupRecords.load_json(row["content"])
            )
        for row in tables["classification_policy"]:
            PolicyValues.model_validate(BackupRecords.load_json(row["content"]))
        for name, field, label in (
            ("accounts", "merged_into_id", "账户合并"),
            ("account_groups", "parent_id", "账户组"),
            ("categories", "parent_id", "分类"),
            ("categories", "merged_into_id", "分类合并"),
            ("tags", "parent_id", "标签"),
        ):
            cls.acyclic(tables[name], field, label)


class DataBackupService:
    TTL = 30 * 60

    def __init__(self, db):
        self.db = db
        self.guard = RLock()
        self.drafts = {}
        self.root = db.path.parent / "restore-staging"
        self.backups = db.path.parent / "backups"

    def download(self, password="", recovery_filename=None):
        BackupEncryption.password(password)
        if recovery_filename is not None:
            return BackupEncryption.seal(
                self.recovery(recovery_filename).read_bytes(), password
            )
        version, tables, _ = BackupRecords.snapshot(self.db)
        return BackupEncryption.seal(BackupRecords.encode(version, tables)[0], password)

    @staticmethod
    def summary(tables):
        return {
            key: len(tables[key])
            for key in (
                "accounts",
                "account_groups",
                "categories",
                "tags",
                "bills",
                "transactions",
                "entries",
                "account_valuations",
                "import_batches",
            )
        }

    def _prune(self):
        for token, draft in list(self.drafts.items()):
            if draft["expires"] < time.monotonic():
                draft["temporary"].cleanup()
                del self.drafts[token]

    def prepare(self, content, filename, password=""):
        with self.guard:
            self._prune()
            if len(self.drafts) >= 5:
                raise DomainError("待恢复备份过多，请稍后重试或重新打开程序")
            encrypted = BackupEncryption.encrypted(content)
            content = BackupEncryption.open(content, password)
            version, current, fingerprint = BackupRecords.snapshot(self.db)
            tables, manifest = BackupRecords.decode(content, version)
            self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
            temporary = tempfile.TemporaryDirectory(prefix="validate-", dir=self.root)
            candidate = Path(temporary.name) / "candidate.sqlite3"
            candidate_db = Database(candidate)
            try:
                candidate_db.initialize()
                with sqlite3.connect(candidate) as connection:
                    connection.execute("PRAGMA foreign_keys=OFF")
                    connection.execute("BEGIN IMMEDIATE")
                    BackupRecords.replace(connection, tables)
                    BackupValidator.check(connection, tables)
                # Exercise the same canonical preference reader used by reports.
                AnalysisSettingsService(candidate_db).get()
            except Exception as error:
                candidate_db.engine.dispose()
                temporary.cleanup()
                if isinstance(error, DomainError):
                    raise
                if isinstance(
                    error,
                    (sqlite3.Error, ValueError, TypeError, KeyError, RecursionError),
                ):
                    raise DomainError(
                        "备份业务数据校验失败：字段、关联或配置不合法"
                    ) from None
                raise
            candidate_db.engine.dispose()
            token = secrets.token_hex(24)
            self.drafts[token] = dict(
                temporary=temporary,
                candidate=candidate,
                tables=tables,
                manifest=manifest,
                fingerprint=fingerprint,
                expires=time.monotonic() + self.TTL,
            )
            return dict(
                token=token,
                filename=Path(filename).name,
                created_at=manifest.created_at,
                encrypted=encrypted,
                current=self.summary(current),
                incoming=self.summary(tables),
                checks=[
                    "文件格式与校验值",
                    "数据版本及必填字段",
                    "唯一编号与引用关系",
                    "逐笔流水借贷平衡",
                    "业务配置及树状结构",
                ],
                omitted_files=len(tables["bill_import_artifacts"]),
                unfinished_imports=sum(
                    row["status"] in ("NORMALIZED", "CLASSIFIED")
                    for row in tables["bill_import_runs"]
                ),
                expires_in_seconds=self.TTL,
            )

    def restore(self, token, confirmation):
        if confirmation != "OVERWRITE_LEDGER":
            raise DomainError("请先确认覆盖当前工程的全部账本数据和业务设置")
        with self.guard, self.db.exclusive():
            self._prune()
            draft = self.drafts.get(token) if isinstance(token, str) else None
            if draft is None:
                raise DomainError("备份校验已过期或已使用，请重新上传校验")
            try:
                with sqlite3.connect(self.db.path, timeout=15) as connection:
                    connection.execute("PRAGMA foreign_keys=OFF")
                    # Freeze other SQLite writers before checking the preview snapshot.
                    connection.execute("BEGIN IMMEDIATE")
                    version, current, fingerprint = BackupRecords.snapshot(self.db)
                    if fingerprint != draft["fingerprint"]:
                        raise DomainError(
                            "校验后当前账本已有修改，请重新上传校验，避免覆盖新增数据"
                        )
                    with sqlite3.connect(draft["candidate"]) as candidate:
                        BackupValidator.check(candidate, draft["tables"])
                    stamp = (
                        Clock.now().replace(":", "").replace("-", "").replace(" ", "-")
                    )
                    prefix = f"before-restore-{stamp}-{secrets.token_hex(4)}"
                    self.backups.mkdir(parents=True, exist_ok=True)
                    full_backup = self.backups / (prefix + ".sqlite3")
                    rollback = self.backups / (prefix + ".ledger.zip")
                    self.db.backup(full_backup)
                    rollback.write_bytes(BackupRecords.encode(version, current)[0])
                    # All deletes and inserts commit together; any failure rolls back.
                    BackupRecords.replace(connection, draft["tables"])
                    BackupValidator.check(connection, draft["tables"])
            except Exception as error:
                if isinstance(error, DomainError):
                    raise
                raise DomainError(
                    "恢复失败，当前账本已保持原状，可重新上传校验"
                ) from error
            self.db.engine.dispose()
            draft["temporary"].cleanup()
            del self.drafts[token]
            return dict(
                restored=True,
                counts=self.summary(draft["tables"]),
                rollback_filename=rollback.name,
                rollback_download_url="/api/data-backup/recovery/" + rollback.name,
            )

    def discard(self, token):
        with self.guard:
            draft = self.drafts.pop(token, None)
            if draft:
                draft["temporary"].cleanup()
        return {"discarded": True}

    def recovery(self, filename):
        import re

        if not re.fullmatch(
            r"before-restore-\d{8}-\d{6}-[a-f0-9]{8}\.ledger\.zip", filename
        ):
            raise DomainError("恢复前备份不存在")
        path = self.backups / filename
        if not path.is_file() or path.is_symlink():
            raise DomainError("恢复前备份不存在")
        return path
