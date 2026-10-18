import hashlib
import os
import subprocess
import sys
from pathlib import Path

import pytest

from app.backup_encryption import BackupEncryption
from app.data_backup import BackupRecords
from app.database import Database
from app.domain import DomainError
from app.local_backup import LocalBackupExporter, LocalBackupSettings
from test_analysis_settings import configured_ledger


def test_local_environment_password_precedence_and_literal_values(tmp_path):
    key = LocalBackupSettings.PASSWORD_KEY
    local = tmp_path / ".env.local"
    local.write_text('# comment\nOTHER=value\nACCOUNT-BILL-PWD=" file # secret "\n')
    process = {key: "process-secret"}
    assert LocalBackupSettings(tmp_path, process).password() == "process-secret"
    empty = {}
    assert LocalBackupSettings(tmp_path, empty).password() == " file # secret "
    assert empty[key] == " file # secret "
    with pytest.raises(DomainError, match="必须加密"):
        LocalBackupSettings(tmp_path, {key: ""}).password()
    local.write_text("ACCOUNT-BILL-PWD='$(touch should-not-exist)'\n")
    assert LocalBackupSettings(tmp_path, {}).password() == "$(touch should-not-exist)"
    assert not (tmp_path / "should-not-exist").exists()
    local.write_text('ACCOUNT-BILL-PWD="unterminated-secret\n')
    with pytest.raises(DomainError, match="格式不正确") as error:
        LocalBackupSettings(tmp_path, {}).password()
    assert "unterminated-secret" not in str(error.value)


def test_default_export_is_encrypted_verified_and_read_only(
    configured_ledger, tmp_path, monkeypatch
):
    db, _ = configured_ledger
    root = tmp_path / "project"
    root.mkdir()
    password = "synthetic-backup-password"
    (root / ".env.local").write_text("ACCOUNT-BILL-PWD=" + password + "\n")
    settings = LocalBackupSettings(root, {})
    exporter = LocalBackupExporter(root, settings)
    before = BackupRecords.snapshot(db)
    monkeypatch.setattr(
        Database,
        "initialize",
        lambda _: pytest.fail(
            "Backups must never initialize or migrate the live database"
        ),
    )
    first = exporter.export(db.path)
    path = first["path"]
    assert path.parent == root / "backups" and path.name.endswith(".ledger.zip")
    assert path.stat().st_mode & 0o777 == 0o600
    data = path.read_bytes()
    assert BackupEncryption.encrypted(data) and password.encode() not in data
    tables, manifest = BackupRecords.decode(
        BackupEncryption.open(data, password), before[0]
    )
    assert tables == before[1] and first["counts"] == manifest.counts
    assert all("content" not in row for row in tables["bill_import_artifacts"])
    assert BackupRecords.snapshot(db) == before
    digest = hashlib.sha256(data).hexdigest()
    second = exporter.export(db.path)
    assert second["path"] != path
    assert hashlib.sha256(path.read_bytes()).hexdigest() == digest
    assert not list(path.parent.glob("*.tmp"))
    assert not list(path.parent.glob("*.enc"))
    assert BackupRecords.snapshot(db) == before


def test_default_export_rejects_missing_password_or_database(tmp_path):
    exporter = LocalBackupExporter(tmp_path, LocalBackupSettings(tmp_path, {}))
    with pytest.raises(DomainError, match="ACCOUNT-BILL-PWD"):
        exporter.export()
    assert not (tmp_path / "backups").exists()
    exporter = LocalBackupExporter(
        tmp_path,
        LocalBackupSettings(tmp_path, {LocalBackupSettings.PASSWORD_KEY: "secret"}),
    )
    with pytest.raises(DomainError, match="数据库不存在"):
        exporter.export()
    assert not (tmp_path / "data").exists()


def test_cli_uses_hyphenated_environment_key_without_printing_password(
    configured_ledger, tmp_path
):
    db, _ = configured_ledger
    before = BackupRecords.snapshot(db)
    password = "synthetic-cli-password"
    environment = dict(os.environ)
    environment[LocalBackupSettings.PASSWORD_KEY] = password
    output = tmp_path / "cli-output"
    result = subprocess.run(
        [
            sys.executable,
            str(Path(__file__).resolve().parents[1] / "backup.py"),
            "--database",
            str(db.path),
            "--output-dir",
            str(output),
        ],
        env=environment,
        cwd=tmp_path,
        text=True,
        capture_output=True,
    )
    assert result.returncode == 0, result.stderr
    assert password not in result.stdout + result.stderr
    files = list(output.glob("*.ledger.zip"))
    assert len(files) == 1
    tables, _ = BackupRecords.decode(
        BackupEncryption.open(files[0].read_bytes(), password), before[0]
    )
    assert tables == before[1]
    assert BackupRecords.snapshot(db) == before


def test_export_disk_verification_failure_leaves_no_published_backup(
    configured_ledger, tmp_path, monkeypatch
):
    db, _ = configured_ledger
    exporter = LocalBackupExporter(
        tmp_path,
        LocalBackupSettings(tmp_path, {LocalBackupSettings.PASSWORD_KEY: "secret"}),
    )
    before = BackupRecords.snapshot(db)
    original = BackupEncryption.open
    calls = 0

    def changed(content, password):
        nonlocal calls
        calls += 1
        return original(content, password) if calls == 1 else b"corrupted"

    monkeypatch.setattr(BackupEncryption, "open", changed)
    with pytest.raises(DomainError, match="写入校验失败"):
        exporter.export(db.path)
    assert list((tmp_path / "backups").iterdir()) == []
    assert BackupRecords.snapshot(db) == before
