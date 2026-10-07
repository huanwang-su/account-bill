import io, os, json, csv, uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import pytest
from fastapi.testclient import TestClient
from app.database import Database
from app.domain import Money, DomainError, Journal, Posting
from app.services import (
    AccountService,
    CatalogService,
    TransactionService,
    ReportService,
)
from app.importers import AlipayParser, ImportService
from app.models import Transaction, Entry, Account
from app.main import LedgerApplication


@pytest.fixture
def db(tmp_path):
    d = Database(tmp_path / "ledger.sqlite3")
    d.initialize()
    return d


def payload(db, **kw):
    a = next(a for a in AccountService(db).list() if a["name"] == "支付宝余额")
    c = next(c for c in CatalogService(db).categories() if c["name"] == "买菜")
    return dict(
        {
            "kind": "EXPENSE",
            "account_id": a["id"],
            "amount": "80.00",
            "category_id": c["id"],
            "occurred_at": "2026-09-10 12:00:00",
            "idempotency_key": str(uuid.uuid4()),
        },
        **kw
    )


def statement(rows):
    s = io.StringIO()
    s.write("导出信息：\n支付宝账户：test@example.com\n")
    w = csv.writer(s)
    w.writerow(
        [
            "交易时间",
            "交易分类",
            "交易对方",
            "对方账号",
            "商品说明",
            "收/支",
            "金额",
            "收/付款方式",
            "交易状态",
            "交易订单号",
            "商家订单号",
            "备注",
            "",
        ]
    )
    for r in rows:
        w.writerow(
            [
                "2026-09-10 12:00:00",
                "餐饮美食",
                "测试商家",
                "/",
                "商品,含逗号",
                "支出",
                "80.00",
                "账户余额",
                "交易成功",
                r + "\t",
                "",
                "",
                "",
            ]
        )
    return s.getvalue().encode("gb18030")


def test_money_and_balance(db):
    for invalid in ("NaN", "Infinity", "1.001", "abc"):
        with pytest.raises(DomainError):
            Money.parse(invalid)
    with pytest.raises(DomainError):
        Journal([Posting(1, -1), Posting(2, 2)]).validate()
    svc = TransactionService(db)
    p = payload(db)
    t = svc.post(p)
    assert svc.post(p) == t
    accounts = AccountService(db).list()
    assert next(a for a in accounts if a["name"] == "支付宝余额")["balance"] == -8000
    assert ReportService(db).integrity()["ok"]
    svc.reverse(t["id"])
    svc.reverse(t["id"])
    assert ReportService(db).summary()["expense"] == 0
    assert (
        next(a for a in AccountService(db).list() if a["name"] == "支付宝余额")[
            "balance"
        ]
        == 0
    )


def test_split_filter_and_transfer(db):
    c = next(c for c in CatalogService(db).categories() if c["name"] == "日用品")
    p = payload(db)
    p["items"] = [
        {"amount": "120", "category_id": p["category_id"]},
        {"amount": "80", "category_id": c["id"]},
    ]
    TransactionService(db).post(p)
    assert (
        ReportService(db).summary({"category_id": p["category_id"]})["expense"] == 12000
    )
    parent = next(c for c in CatalogService(db).categories() if c["name"] == "餐饮")
    assert ReportService(db).summary({"category_id": parent["id"]})["expense"] == 12000
    other = next(a for a in AccountService(db).list() if a["name"] == "微信")
    TransactionService(db).post(
        payload(db, kind="TRANSFER", to_account_id=other["id"], amount="100")
    )
    assert ReportService(db).summary()["expense"] == 20000
    assert ReportService(db).integrity()["ok"]


def test_concurrent_posts_and_rollback(db):
    p = payload(db)
    with ThreadPoolExecutor(max_workers=6) as pool:
        ids = list(pool.map(lambda _: TransactionService(db).post(p)["id"], range(12)))
    assert len(set(ids)) == 1
    with ThreadPoolExecutor(max_workers=4) as pool:
        list(pool.map(lambda _: TransactionService(db).post(payload(db)), range(8)))
    assert ReportService(db).summary()["expense"] == 9 * 8000
    before = ReportService(db).summary()
    with pytest.raises(DomainError):
        TransactionService(db).replace(ids[0], payload(db, category_id=99999))
    assert ReportService(db).summary() == before


def test_refund_replace_and_opening(db):
    svc = TransactionService(db)
    p = payload(db)
    tx = svc.post(p)
    refund = svc.post(payload(db, kind="REFUND", related_id=tx["id"], amount="20"))
    assert ReportService(db).summary()["expense"] == 6000
    with pytest.raises(DomainError):
        svc.post(payload(db, kind="REFUND", related_id=tx["id"], amount="61"))
    with pytest.raises(DomainError):
        svc.reverse(tx["id"])
    svc.reverse(refund["id"])
    svc.replace(tx["id"], payload(db, amount="30"))
    assert ReportService(db).summary()["expense"] == 3000
    account = AccountService(db)
    with pytest.raises(DomainError):
        account.opening(p["account_id"], {"amount": "100", "occurred_at": "2026-10-01"})
    account.opening(p["account_id"], {"amount": "100", "occurred_at": "2026-09-01"})
    result = account.reconcile(p["account_id"], {"actual": "70", "at": "2026-10-01"})
    assert result["difference"] == 0


def test_category_cycle_and_cross_kind(db):
    catalog = CatalogService(db)
    cats = catalog.categories()
    p = next(c for c in cats if c["name"] == "餐饮")
    c = next(c for c in cats if c["name"] == "买菜")
    with pytest.raises(DomainError):
        catalog.save_category({**p, "parent_id": c["id"]}, p["id"])
    with pytest.raises(DomainError):
        catalog.save_category({"name": "错误", "parent_id": p["id"], "kind": "INCOME"})


def test_parser_and_dedup(db):
    data = statement(["1234567890123456789012345", "1234567890123456789012345"])
    parsed = AlipayParser().parse(data, "a.csv")
    assert parsed.rows[0]["note"] == "商品,含逗号"
    assert parsed.rows[0]["order_id"] == "1234567890123456789012345"
    service = ImportService(db)
    b = service.upload(data, "a.csv")
    assert service.upload(data, "b.csv")["existing"]
    rows = service.rows(b["id"])
    assert [r["status"] for r in rows] == ["READY", "DUPLICATE"]
    assert service.commit(b["id"])["posted"] == 1
    assert service.commit(b["id"])["posted"] == 0
    other = service.upload(statement(["1234567890123456789012345", "new"]), "c.csv")
    assert service.rows(other["id"])[0]["status"] == "DUPLICATE"
    assert service.commit(other["id"])["posted"] == 1
    assert ReportService(db).summary()["expense"] == 16000


def test_utf8_xlsx_and_review(db):
    data = statement(["one"]).decode("gb18030").replace("账户余额", "待确认账户")
    service = ImportService(db)
    b = service.upload(data.encode("utf-8-sig"), "a.csv")
    r = service.rows(b["id"])[0]
    assert r["status"] == "REVIEW"
    assert service.commit(b["id"])["posted"] == 0
    service.decide(r["id"], payload(db))
    assert service.commit(b["id"])["posted"] == 1
    from openpyxl import Workbook

    wb = Workbook()
    ws = wb.active
    for row in csv.reader(io.StringIO(statement(["two"]).decode("gb18030"))):
        ws.append(row)
    stream = io.BytesIO()
    wb.save(stream)
    assert len(AlipayParser().parse(stream.getvalue(), "bill.xlsx").rows) == 1


def test_api_security_backup_and_export(tmp_path):
    application = LedgerApplication(tmp_path / "api.sqlite3")
    client = TestClient(application.app)
    assert client.post("/api/accounts", json={"name": "bad"}).status_code == 403
    headers = {"X-Ledger-Client": "local-web"}
    assert (
        client.post(
            "/api/accounts",
            json={"name": "test"},
            headers={**headers, "Origin": "https://evil.example"},
        ).status_code
        == 403
    )
    response = client.post(
        "/api/transactions",
        json=payload(application.db, counterparty="=malicious()"),
        headers=headers,
    )
    assert response.status_code == 200
    assert "'=malicious()" in client.get("/api/export").text
    backup = client.get("/api/backup")
    assert backup.content[:16] == b"SQLite format 3\x00"
    assert client.get("/api/integrity").json()["ok"]


def test_real_sample(db):
    path = os.environ.get("ALIPAY_SAMPLE")
    if not path:
        pytest.skip("Set ALIPAY_SAMPLE to run the private real statement regression")
    content = Path(path).read_bytes()
    parsed = AlipayParser().parse(content, "sample.csv")
    assert len(parsed.rows) == 128
    assert parsed.metadata["totals"] == {
        "不计收支": {"count": 113, "amount": 595246},
        "支出": {"count": 12, "amount": 576602},
        "收入": {"count": 3, "amount": 60182},
    }
    assert parsed.metadata["declared_totals"]["不计收支"]["amount"] == 546446
    assert len(parsed.metadata["warnings"]) == 1
    assert sum(r["amount"] == 0 for r in parsed.rows) == 5
    service = ImportService(db)
    b = service.upload(content, "sample.csv")
    rows = service.rows(b["id"])
    assert len(rows) == 128 and not any(r["status"] == "ERROR" for r in rows)
    assert all(r["status"] != "READY" for r in rows if r["direction"] == "不计收支")
    ready = sum(r["status"] == "READY" for r in rows)
    assert service.commit(b["id"])["posted"] == ready
    assert service.commit(b["id"])["posted"] == 0
    assert service.upload(content, "same.csv")["existing"]
    assert ReportService(db).integrity()["ok"]


def test_order_status_change_does_not_double_post(db):
    service = ImportService(db)
    data = statement(["stable-order"])
    first = service.upload(data, "a.csv")
    service.commit(first["id"])
    changed = (
        data.decode("gb18030").replace("交易成功", "等待确认收货").encode("gb18030")
    )
    second = service.upload(changed, "b.csv")
    assert service.rows(second["id"])[0]["status"] == "DUPLICATE"
    assert service.commit(second["id"])["posted"] == 0


def test_backup_restore(db, tmp_path):
    from manage import BackupManager

    TransactionService(db).post(payload(db))
    backup = tmp_path / "backup.sqlite3"
    db.backup(backup)
    target = tmp_path / "restored.sqlite3"
    BackupManager().restore(backup, target)
    restored = Database(target)
    restored.initialize()
    assert ReportService(restored).summary()["expense"] == 8000
    assert ReportService(restored).integrity()["ok"]


def test_restore_rejects_running_ledger(db, tmp_path):
    from app.database import ProcessLease
    from manage import BackupManager

    backup = tmp_path / "snapshot.sqlite3"
    db.backup(backup)
    with ProcessLease(db.path):
        with pytest.raises(DomainError):
            BackupManager().restore(backup, db.path)


def test_same_named_categories_remain_separate(db):
    catalog = CatalogService(db)
    parent = catalog.save_category({"name": "旅行", "kind": "EXPENSE"})["id"]
    category = catalog.save_category(
        {"name": "买菜", "kind": "EXPENSE", "parent_id": parent}
    )["id"]
    TransactionService(db).post(payload(db))
    TransactionService(db).post(payload(db, category_id=category))
    categories = ReportService(db).summary()["categories"]
    assert len(categories) == 2
    assert set(c["name"] for c in categories) == {"餐饮 / 买菜", "旅行 / 买菜"}
