import pytest
from app.database import Database
from app.domain import DomainError
from app.services import AccountService, TransactionService, ReportService
from app.account_config import AccountMergeService
from app.balance_sheet import BalanceSheetService
from app.securities import SecuritiesValuationService
from app.import_workflow import BillImportWorkflow
from test_ledger import statement, payload
from test_import_workflow import prepared


@pytest.fixture
def db(tmp_path):
    result = Database(tmp_path / "audit.sqlite3")
    result.initialize()
    yield result
    result.engine.dispose()


def test_failed_upload_does_not_reverse_posted_journal(db):
    flow = BillImportWorkflow(db)
    flow.commit(prepared(flow, ["payment"]))
    before = ReportService(db).summary()
    raw = (
        statement(["payment"])
        .decode("gb18030")
        .replace("支出,80.00", "不计收支,80.00")
        .encode()
    )
    run = flow.stage(raw, "changed.csv")
    assert run["status"] == "ERROR"
    assert ReportService(db).summary() == before
    with pytest.raises(DomainError):
        flow.commit(run["run_id"])


def test_idempotent_payload_conflict(db):
    service = TransactionService(db)
    data = payload(db)
    result = service.post(data)
    assert service.post(data) == result
    for changed in [
        dict(amount="81"),
        dict(note="different"),
        dict(source="different"),
        dict(occurred_at="2026-09-11"),
    ]:
        with pytest.raises(DomainError, match="不同的交易内容"):
            service.post(dict(data, **changed))


def test_merged_opening_and_labels_are_reversible(db):
    service = AccountService(db)
    a = service.save(dict(name="A", tags=["A"], role="ASSET"))["id"]
    b = service.save(dict(name="B", tags=["B"], role="ASSET"))["id"]
    service.opening(a, dict(amount="0", occurred_at="2026-09-28"))
    merges = AccountMergeService(db)
    merges.merge(dict(source_id=b, target_id=a))
    account = next(row for row in service.list() if row["id"] == a)
    snapshot = next(
        row
        for row in BalanceSheetService(db).snapshot("2026-10-20")["accounts"]
        if row["id"] == a
    )
    assert account["opening_set"] == snapshot["opening_set"] == False
    assert account["opening_status"] == "PARTIAL"
    merges.unmerge(b)
    assert next(row for row in service.list() if row["id"] == a)["tags"] == ["A"]


def test_historical_principal_and_reversal_protected_by_valuation(db):
    service = AccountService(db)
    stock = service.save(dict(name="证券测试", role="ASSET", kind="证券"))["id"]
    bank = service.save(dict(name="银行测试", role="ASSET"))["id"]
    valuation = SecuritiesValuationService(db)
    valuation.update(
        stock, dict(actual="100", occurred_at="2026-10-01", idempotency_key="first")
    )
    update = valuation.update(
        stock, dict(actual="110", occurred_at="2026-10-10", idempotency_key="latest")
    )
    data = dict(
        kind="TRANSFER",
        account_id=bank,
        to_account_id=stock,
        amount="100",
        occurred_at="2026-10-05",
        idempotency_key="principal",
    )
    with pytest.raises(DomainError, match="已有证券估值"):
        TransactionService(db).post(data)
    assert next(a for a in service.list() if a["id"] == stock)["balance"] == 11000
    valuation.cancel(stock, update["id"])
    TransactionService(db).post(data)
    assert ReportService(db).integrity()["ok"]


def test_refund_retry_and_replacement_payloads(db):
    service = TransactionService(db)
    expense = payload(db, amount="80")
    original = service.post(expense)["id"]
    refund = payload(db, kind="REFUND", amount="80", related_id=original)
    assert service.post(refund) == service.post(refund)
    service.reverse(service.post(refund)["id"])
    replacement = payload(db, amount="40")
    result = service.replace(original, replacement)
    assert service.replace(original, replacement) == result
    with pytest.raises(DomainError, match="不同的交易内容"):
        service.replace(original, dict(replacement, amount="41"))


def test_database_pages_match_full_filters_and_stable_order(db):
    import uuid
    from app.bills import BillService
    from app.bill_pages import BillPageService

    service, reports = TransactionService(db), ReportService(db)
    for index in range(31):
        service.post(
            payload(
                db,
                amount=str(index + 1),
                counterparty="测试店铺",
                idempotency_key=uuid.uuid4().hex,
            )
        )
    for filters in (
        {},
        {"kind": "EXPENSE", "q": "店铺"},
        {"account_id": 5, "min_amount": "12", "max_amount": "20"},
    ):
        expected = reports.list(filters)
        rows = []
        for page in range(1, (len(expected) + 6) // 7 + 1):
            result = reports.page(dict(filters, page=page, page_size=7))
            assert result["total"] == len(expected)
            rows += result["items"]
        assert [r["id"] for r in rows] == [r["id"] for r in expected]
    page = reports.page(dict(page=1, page_size=5, sort="amount", order="asc"))
    assert [r["amount"] for r in page["items"]] == [100, 200, 300, 400, 500]
    assert reports.detail(page["items"][0]["id"])["amount"] == 100
    bills = BillPageService(db).page(dict(page=1, page_size=5))
    assert bills["total"] == len(BillService(db).list()) == bills["statistics"]["total"]
    service.post(payload(db, amount="99"))
    assert (
        BillPageService(db).page(dict(page=1, page_size=5))["total"]
        == bills["total"] + 1
    )


def test_snapshot_consistency_does_not_block_writer(db):
    from concurrent.futures import ThreadPoolExecutor

    service, reports = TransactionService(db), ReportService(db)
    initial = len(reports.list())
    with ThreadPoolExecutor(max_workers=1) as pool:
        with db.read():
            assert len(reports.list()) == initial
            pool.submit(service.post, payload(db)).result(timeout=5)
            assert len(reports.list()) == initial
        assert len(reports.list()) == initial + 1


def test_legacy_business_backup_additive_upgrade(db):
    from app.data_backup import BackupRecords
    from app.schema_versions import SchemaVersions

    TransactionService(db).post(payload(db))
    _, tables, _ = BackupRecords.snapshot(db)
    for row in tables["transactions"]:
        row.pop("purpose")
    for row in tables["account_valuations"]:
        row.pop("revoked_at")
    content, _ = BackupRecords.encode("015", tables)
    upgraded, manifest = BackupRecords.decode(content, SchemaVersions.head())
    assert manifest.schema_version == "015"
    assert all(row["purpose"] == "GENERAL" for row in upgraded["transactions"])


def test_maintenance_runs_once_and_rolls_back_on_failure(db):
    from app.maintenance import MaintenanceRunner
    from app.models import Account

    runner, calls = MaintenanceRunner(db), []
    assert runner.run("test-v1", lambda: calls.append(1))
    assert not runner.run("test-v1", lambda: calls.append(2))
    assert calls == [1]

    def failed():
        with db.write() as session:
            session.add(Account(name="未完成升级", role="ASSET", kind="其他"))
        raise DomainError("升级失败")

    with pytest.raises(DomainError):
        runner.run("test-v2", failed)
    assert all(a["name"] != "未完成升级" for a in AccountService(db).list())
    assert runner.run("test-v2", lambda: None)
