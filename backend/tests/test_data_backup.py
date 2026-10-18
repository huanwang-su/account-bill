import io
import json
import sqlite3
import time
import zipfile
from pathlib import Path
import pytest
from fastapi.testclient import TestClient
from app.data_backup import BackupRecords, BackupValidator, DataBackupService
from app.backup_encryption import BackupEncryption
from app.main import LedgerApplication
from app.database import Database
from app.domain import DomainError
from app.services import AccountService, ReportService
from app.import_workflow import ImportArtifactStore
from test_analysis_settings import configured_ledger
from test_import_workflow import prepared, classify_run
from test_ledger import statement
from test_report_defaults import save

HEADERS = {"X-Ledger-Client": "local-web"}


@pytest.fixture
def ledger(configured_ledger):
    db, ids = configured_ledger
    app = LedgerApplication(db.path)
    save(
        db,
        single_account_ids=[5, ids["wealth"]],
        single_excluded_account_ids=[6],
        large_income_threshold_minor=12345,
    )
    run = prepared(app.workflow, ["backup-paid"])
    app.workflow.commit(run)
    raw = (
        statement(["backup-pending"])
        .decode("gb18030")
        .replace("账户余额", "未知账户")
        .encode()
    )
    pending = app.workflow.stage(raw, "pending.csv")["run_id"]
    app.workflow.classify(
        pending, classify_run(app.workflow, pending).model_dump_json().encode()
    )
    app.workflow.commit(pending)
    with db.write() as session:
        ImportArtifactStore().add(
            session,
            run,
            "ORIGINAL_ARCHIVE",
            "original.zip",
            b"SECRET-ORIGINAL-FILE-CONTENT",
        )
    yield app, run
    app.lease.close()


def archive(data, modify=None, version=None):
    with zipfile.ZipFile(io.BytesIO(data)) as source:
        tables = json.loads(source.read("data.json"))["tables"]
        schema = json.loads(source.read("manifest.json"))["schema_version"]
    if modify:
        modify(tables)
    return BackupRecords.encode(version or schema, tables)[0]


def test_download_validate_confirm_replace_rollback_and_duplicate_import(ledger):
    app, run = ledger
    client = TestClient(app.app)
    baseline = BackupRecords.snapshot(app.db)
    response = client.get("/api/data-backup")
    assert (
        response.status_code == 200
        and response.headers["content-type"] == "application/zip"
    )
    with zipfile.ZipFile(io.BytesIO(response.content)) as file:
        assert set(file.namelist()) == {"manifest.json", "data.json"}
        assert b"SECRET-ORIGINAL-FILE-CONTENT" not in file.read("data.json")
    tables, manifest = BackupRecords.decode(response.content, baseline[0])
    assert tables == baseline[1] and manifest.file_contents_included is False
    assert all("content" not in item for item in tables["bill_import_artifacts"])
    added = AccountService(app.db).save(
        dict(name="恢复应移除的账户", role="ASSET", kind="银行卡")
    )
    before_validation = BackupRecords.snapshot(app.db)[2]
    upload = client.post(
        "/api/data-backup/validate",
        files={"file": ("账本.ledger.zip", response.content)},
        headers=HEADERS,
    )
    assert upload.status_code == 200, upload.text
    preview = upload.json()
    assert preview["current"]["accounts"] == preview["incoming"]["accounts"] + 1
    assert BackupRecords.snapshot(app.db)[2] == before_validation
    assert (
        client.post(
            "/api/data-backup/restore",
            json={"token": preview["token"]},
            headers=HEADERS,
        ).status_code
        == 400
    )
    assert BackupRecords.snapshot(app.db)[2] == before_validation
    restored = client.post(
        "/api/data-backup/restore",
        json={"token": preview["token"], "confirmation": "OVERWRITE_LEDGER"},
        headers=HEADERS,
    )
    assert restored.status_code == 200, restored.text
    result = restored.json()
    assert BackupRecords.snapshot(app.db)[1] == baseline[1]
    assert added["id"] not in {item["id"] for item in AccountService(app.db).list()}
    assert client.get("/api/integrity").json()["ok"]
    assert app.analysis_settings.get()["large_income_threshold_minor"] == 12345
    assert len(client.get("/api/bills?ledger_status=PENDING").json()) >= 1
    detail = client.get(f"/api/import-runs/{run}")
    assert detail.status_code == 200, detail.text
    assert detail.json()["files_omitted"] and len(detail.json()["rows"]) == 1
    assert all(not item["available"] for item in detail.json()["artifacts"])
    assert (
        "未包含"
        in client.get(
            "/api/import-artifacts/" + str(detail.json()["artifacts"][0]["id"])
        ).json()["detail"]
    )
    assert (
        client.post(
            "/api/data-backup/restore",
            json={"token": preview["token"], "confirmation": "OVERWRITE_LEDGER"},
            headers=HEADERS,
        ).status_code
        == 400
    )
    rollback = client.get(result["rollback_download_url"])
    assert rollback.status_code == 200
    old_tables, _ = BackupRecords.decode(rollback.content, baseline[0])
    assert any(item["id"] == added["id"] for item in old_tables["accounts"])
    protected_rollback = client.post(
        result["rollback_download_url"],
        json={"password": "recovery-password"},
        headers=HEADERS,
    )
    assert protected_rollback.status_code == 200
    decrypted_rollback = BackupEncryption.open(
        protected_rollback.content, "recovery-password"
    )
    assert decrypted_rollback == rollback.content
    full_backup = next(app.data_backup.backups.glob("*.sqlite3"))
    with sqlite3.connect(full_backup) as connection:
        assert (
            connection.execute(
                "SELECT COUNT(*) FROM bill_import_artifacts WHERE length(content)>0"
            ).fetchone()[0]
            > 0
        )
    before = len(ReportService(app.db).list())
    duplicate = prepared(app.workflow, ["backup-paid"])
    assert app.workflow.commit(duplicate)["duplicates"] == 1
    assert len(ReportService(app.db).list()) == before
    # The business-only archive also survives a subsequent process start.
    app.lease.close()
    restarted = LedgerApplication(app.db.path)
    assert restarted.workflow.detail(run)["files_omitted"]
    assert restarted.reports.integrity()["ok"]
    assert restarted.workflow.cancel(run)["reversed_details"] == 1
    assert restarted.reports.integrity()["ok"]
    restarted.lease.close()


def test_password_download_decrypt_validate_and_restore(ledger):
    app, _ = ledger
    client = TestClient(app.app)
    baseline = BackupRecords.snapshot(app.db)
    password = "  家庭备份 test 🔐  "
    response = client.post(
        "/api/data-backup", json={"password": password}, headers=HEADERS
    )
    assert response.status_code == 200
    assert response.headers["content-type"] == "application/zip"
    assert ".ledger.zip" in response.headers["content-disposition"]
    assert response.headers["cache-control"] == "no-store"
    assert BackupEncryption.encrypted(response.content)
    assert password.encode() not in response.content
    with zipfile.ZipFile(io.BytesIO(response.content)) as archive_file:
        assert set(archive_file.namelist()) == {"manifest.json", "data.json"}
        assert all(item.flag_bits & 1 for item in archive_file.infolist())
        with pytest.raises(RuntimeError):
            archive_file.read("data.json")
        item = archive_file.getinfo("data.json")
        encrypted_offset = (
            item.header_offset + 30 + len(item.filename.encode()) + len(item.extra)
        )
    second = client.post(
        "/api/data-backup", json={"password": password}, headers=HEADERS
    )
    assert (
        second.content != response.content
    )  # Native ZIP creates fresh encryption headers for each download.
    decoded, _ = BackupRecords.decode(
        BackupEncryption.open(response.content, password), baseline[0]
    )
    assert decoded == baseline[1]
    assert (
        client.post("/api/data-backup", json={"password": password}).status_code == 403
    )

    # Missing/wrong password, corrupted content and truncated files fail closed.
    def changed(index):
        data = bytearray(response.content)
        data[index] ^= 1
        return bytes(data)

    for content, secret in (
        (response.content, ""),
        (response.content, "wrong-password"),
        (response.content, password.strip()),
        (changed(encrypted_offset + 12), password),
        (response.content[:30], password),
    ):
        result = client.post(
            "/api/data-backup/validate",
            files={"file": ("backup.ledger.zip", content)},
            data={"password": secret},
            headers=HEADERS,
        )
        assert result.status_code == 400, result.text
        assert password not in result.text
        assert BackupRecords.snapshot(app.db)[2] == baseline[2]
        assert not app.data_backup.drafts

    # ZIP password protection does not bypass the existing business validators.
    invalid = archive(
        app.data_backup.download(),
        lambda t: t["entries"][0].update(amount=t["entries"][0]["amount"] + 1),
    )
    rejected = client.post(
        "/api/data-backup/validate",
        files={
            "file": ("invalid.ledger.zip", BackupEncryption.seal(invalid, password))
        },
        data={"password": password},
        headers=HEADERS,
    )
    assert rejected.status_code == 400
    assert BackupRecords.snapshot(app.db)[2] == baseline[2]
    assert not app.data_backup.drafts

    AccountService(app.db).save(
        dict(name="下载后新增账户", role="ASSET", kind="银行卡")
    )
    before_validation = BackupRecords.snapshot(app.db)[2]
    upload = client.post(
        "/api/data-backup/validate",
        files={"file": ("renamed.zip", response.content)},
        data={"password": password},
        headers=HEADERS,
    )
    assert upload.status_code == 200, upload.text
    preview = upload.json()
    assert preview["encrypted"] is True
    assert password not in repr(app.data_backup.drafts)
    assert BackupRecords.snapshot(app.db)[2] == before_validation
    restored = client.post(
        "/api/data-backup/restore",
        json={"token": preview["token"], "confirmation": "OVERWRITE_LEDGER"},
        headers=HEADERS,
    )
    assert restored.status_code == 200, restored.text
    assert BackupRecords.snapshot(app.db)[1] == baseline[1]
    assert app.reports.integrity()["ok"]


def test_password_input_and_unencrypted_compatibility(ledger):
    app, _ = ledger
    client = TestClient(app.app)
    before = BackupRecords.snapshot(app.db)[2]
    for password in (None, False, 123, [], "x" * 257):
        result = client.post(
            "/api/data-backup", json={"password": password}, headers=HEADERS
        )
        assert result.status_code == 400
    plain = client.post("/api/data-backup", json={}, headers=HEADERS)
    assert plain.status_code == 200 and plain.content.startswith(b"PK")
    assert ".ledger.zip" in plain.headers["content-disposition"]
    compatible = client.post(
        "/api/data-backup/validate",
        files={"file": ("old.zip", plain.content)},
        data={"password": "unused"},
        headers=HEADERS,
    )
    assert compatible.status_code == 200
    assert compatible.json()["encrypted"] is False
    assert BackupRecords.snapshot(app.db)[2] == before
    app.data_backup.discard(compatible.json()["token"])


@pytest.mark.parametrize(
    "mutation",
    [
        lambda t: t["entries"][0].update(amount=t["entries"][0]["amount"] + 1),
        lambda t: t["entries"][0].update(account_id=99999999),
        lambda t: t["entries"][0].update(amount="100"),
        lambda t: t["accounts"][0].update(active=2),
        lambda t: t["accounts"].append(dict(t["accounts"][0])),
        lambda t: t["accounts"][0].update(merged_into_id=t["accounts"][0]["id"]),
        lambda t: t["transactions"][0].update(kind="UNKNOWN"),
        lambda t: t["analysis_settings"][0].update(
            content='{"exclude_single_accounts":"yes"}'
        ),
        lambda t: t["import_batches"][0].update(metadata_json="broken-json"),
        lambda t: t.pop("tags"),
        lambda t: t["accounts"][0].update(unexpected="field"),
    ],
)
def test_invalid_business_data_never_changes_current_ledger(ledger, mutation):
    app, _ = ledger
    backup = app.data_backup.download()
    before = BackupRecords.snapshot(app.db)[2]
    client = TestClient(app.app)
    response = client.post(
        "/api/data-backup/validate",
        files={"file": ("invalid.zip", archive(backup, mutation))},
        headers=HEADERS,
    )
    assert response.status_code == 400, response.text
    assert BackupRecords.snapshot(app.db)[2] == before
    assert not app.data_backup.drafts


def test_corrupt_incomplete_or_incompatible_archives_are_rejected(ledger):
    app, _ = ledger
    backup = app.data_backup.download()
    before = BackupRecords.snapshot(app.db)[2]
    with zipfile.ZipFile(io.BytesIO(backup)) as source:
        manifest, data = source.read("manifest.json"), source.read("data.json")

    def packed(entries):
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w") as output:
            for name, content in entries:
                output.writestr(name, content)
        return buffer.getvalue()

    invalid = [
        b"",
        b"not a backup",
        b"SQLite format 3\x00malformed",
        backup[:25],
        archive(backup, version="999"),
        packed([("manifest.json", manifest), ("data.json", data + b" ")]),
        packed([("manifest.json", manifest)]),
        packed([("manifest.json", manifest), ("data.json", data), ("../evil", b"x")]),
    ]
    for content in invalid:
        with pytest.raises(DomainError):
            app.data_backup.prepare(content, "invalid.zip")
        assert BackupRecords.snapshot(app.db)[2] == before
    client = TestClient(app.app)
    assert (
        client.post(
            "/api/data-backup/validate", files={"file": ("b.zip", backup)}
        ).status_code
        == 403
    )


def test_new_writes_expiration_and_cancel_prevent_stale_overwrite(ledger):
    app, _ = ledger
    service = app.data_backup
    backup = service.download()
    preview = service.prepare(backup, "backup.zip")
    AccountService(app.db).save(dict(name="校验后新增", role="ASSET", kind="银行卡"))
    before = BackupRecords.snapshot(app.db)[2]
    with pytest.raises(DomainError, match="已有修改"):
        service.restore(preview["token"], "OVERWRITE_LEDGER")
    assert BackupRecords.snapshot(app.db)[2] == before
    service.discard(preview["token"])
    with pytest.raises(DomainError, match="过期"):
        service.restore(preview["token"], "OVERWRITE_LEDGER")
    preview = service.prepare(backup, "backup.zip")
    service.drafts[preview["token"]]["expires"] = time.monotonic() - 1
    with pytest.raises(DomainError, match="过期"):
        service.restore(preview["token"], "OVERWRITE_LEDGER")
    assert BackupRecords.snapshot(app.db)[2] == before


def test_mid_restore_failure_rolls_back_all_tables_and_keeps_emergency_backup(
    ledger, monkeypatch
):
    app, _ = ledger
    service = app.data_backup
    backup = service.download()
    AccountService(app.db).save(
        dict(name="不能丢失的新账户", role="ASSET", kind="银行卡")
    )
    preview = service.prepare(backup, "backup.zip")
    before = BackupRecords.snapshot(app.db)[2]
    original = BackupValidator.check.__func__

    def fail(cls, connection, tables):
        original(cls, connection, tables)
        if (
            Path(connection.execute("PRAGMA database_list").fetchone()[2])
            == app.db.path
        ):
            raise DomainError("模拟恢复中断")

    monkeypatch.setattr(BackupValidator, "check", classmethod(fail))
    with pytest.raises(DomainError, match="中断"):
        service.restore(preview["token"], "OVERWRITE_LEDGER")
    assert BackupRecords.snapshot(app.db)[2] == before
    assert list(service.backups.glob("*.sqlite3")) and list(
        service.backups.glob("*.ledger.zip")
    )
    assert ReportService(app.db).integrity()["ok"]


def test_business_only_restore_retains_ignored_bill_preview(ledger, tmp_path):
    app, _ = ledger
    raw = (
        statement(["ignored-backup-row"])
        .decode("gb18030")
        .replace("支出,80.00", "不计收支,80.00")
        .encode()
    )
    run = app.workflow.stage(raw, "ignored.csv")["run_id"]
    assert app.workflow.commit(run)["ignored_bills"] == 1
    target = Database(tmp_path / "restored.sqlite3")
    target.initialize()
    service = DataBackupService(target)
    preview = service.prepare(app.data_backup.download(), "backup.zip")
    service.restore(preview["token"], "OVERWRITE_LEDGER")
    from app.import_workflow import BillImportWorkflow

    detail = BillImportWorkflow(target).detail(run)
    assert detail["files_omitted"]
    assert len(detail["rows"]) == 1
    assert detail["rows"][0]["bill_status"] == "IGNORED"
    assert detail["rows"][0]["source_transaction_id"] == "ignored-backup-row"
