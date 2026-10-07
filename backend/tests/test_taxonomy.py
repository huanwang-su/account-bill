import json
import sqlite3
import pytest
from app.database import Database
from app.models import Category, Tag, Entry, Bill, Account
from app.services import (
    CatalogService,
    TransactionService,
    ReportService,
    AccountService,
)
from app.bills import BillService
from app.domain import DomainError


@pytest.fixture
def db(tmp_path):
    d = Database(tmp_path / "db")
    d.initialize()
    return d


def tag(catalog, name, parent=None, scope="BOTH"):
    return catalog.save_tag(dict(name=name, parent_id=parent, scope=scope))["id"]


def post(db, key, tags, category=1):
    return TransactionService(db).post(
        dict(
            kind="EXPENSE",
            account_id=5,
            amount="12.34",
            category_id=category,
            occurred_at="2026-09-01",
            idempotency_key=key,
            tags=tags,
        )
    )


def test_baby_root_and_recursive_category_filter_export_preserve_money(db):
    catalog = CatalogService(db)
    baby = next(c for c in catalog.categories() if c["name"] == "宝宝")
    child = next(
        c["id"]
        for c in catalog.categories()
        if c["name"] == "用品" and c["parent_id"] == baby["id"]
    )
    with pytest.raises(DomainError, match="两级"):
        catalog.save_category(dict(name="奶粉", kind="EXPENSE", parent_id=child))
    post(db, "milk", [], child)
    post(db, "meal", [])
    result = BillService(db).list({"category": "支出 / 宝宝"})
    assert len(result) == 1 and result[0]["classification"]["category_path"] == [
        "支出",
        "宝宝",
        "用品",
    ]
    assert len(BillService(db).export({"category": "支出 / 宝宝"}).bills) == 1
    assert ReportService(db).summary({"category_id": baby["id"]})["expense"] == 1234
    db.initialize()
    assert (
        len(
            [
                c
                for c in catalog.categories()
                if c["name"] == "宝宝" and c["parent_id"] is None
            ]
        )
        == 1
    )


def test_parent_tag_matches_grandchildren_on_bills_reports_and_accounts(db):
    catalog = CatalogService(db)
    root = tag(catalog, "宝宝生活")
    child = tag(catalog, "宝宝用品", root)
    tag(catalog, "尿布", child)
    post(db, "diaper", ["尿布"])
    post(db, "meal", ["餐饮"])
    assert len(BillService(db).list({"tag": "宝宝生活"})) == 1
    assert len(BillService(db).export({"tag": "宝宝生活"}).bills) == 1
    assert len(ReportService(db).list({"tag": "宝宝生活"})) == 1
    assert ReportService(db).summary({"tag": "宝宝生活"})["expense"] == 1234
    account = next(a for a in AccountService(db).list() if a["id"] == 5)
    AccountService(db).save({**account, "tags": ["尿布"]}, 5)
    assert len(ReportService(db).list({"account_tag": "宝宝生活"})) == 2
    catalog.save_tag(dict(name="宝宝用品", parent_id=None, scope="BOTH"), child)
    assert not BillService(db).list({"tag": "宝宝生活"})
    assert len(BillService(db).list({"tag": "宝宝用品"})) == 1


def test_category_move_refreshes_saved_classification_path_without_changing_entries(db):
    catalog = CatalogService(db)
    post(db, "meal", ["餐饮"], 2)
    with db.read() as s:
        entries = [
            (e.id, e.account_id, e.category_id, e.amount) for e in s.query(Entry)
        ]
        original = s.query(Bill).one().facts
    baby = next(c for c in catalog.categories() if c["name"] == "宝宝")
    catalog.save_category(dict(name="买菜", kind="EXPENSE", parent_id=baby["id"]), 2)
    assert len(BillService(db).list({"category": "支出 / 宝宝"})) == 1
    assert BillService(db).list()[0]["classification"]["category_path"] == [
        "支出",
        "宝宝",
        "买菜",
    ]
    with db.read() as s:
        assert entries == [
            (e.id, e.account_id, e.category_id, e.amount) for e in s.query(Entry)
        ]
        assert s.query(Bill).one().facts == original
    assert len(BillService(db).history(BillService(db).list()[0]["id"])) == 2


def test_tag_cycles_scope_and_used_name_guard(db):
    catalog = CatalogService(db)
    root = tag(catalog, "生活")
    child = tag(catalog, "消费", root)
    with pytest.raises(DomainError, match="自身或子标签"):
        catalog.save_tag(dict(name="生活", scope="BOTH", parent_id=child), root)
    with pytest.raises(DomainError, match="范围"):
        catalog.save_tag(dict(name="生活", scope="ACCOUNT"), root)
    post(db, "x", ["消费"])
    with pytest.raises(DomainError, match="改名"):
        catalog.save_tag(dict(name="新消费", scope="BOTH", parent_id=root), child)
    with pytest.raises(DomainError, match="范围"):
        catalog.save_tag(dict(name="消费", scope="ACCOUNT", parent_id=root), child)
    only_account = tag(catalog, "账户组", scope="ACCOUNT")
    with pytest.raises(DomainError, match="范围"):
        tag(catalog, "交易用途", only_account, scope="TRANSACTION")


def test_upgrade_009_preserves_existing_tag_identity_and_journals(tmp_path):
    from alembic.config import Config
    from alembic import command
    from pathlib import Path

    path = tmp_path / "old"
    root = Path(__file__).resolve().parents[1]
    config = Config(str(root / "alembic.ini"))
    config.set_main_option("script_location", str(root / "migrations"))
    config.set_main_option("sqlalchemy.url", "sqlite:///" + str(path))
    command.upgrade(config, "009")
    with sqlite3.connect(path) as c:
        c.execute("insert into tags(id,name,scope) values(1,'旧标签','BOTH')")
    d = Database(path)
    d.initialize()
    with d.read() as s:
        saved = s.get(Tag, 1)
        assert saved.name == "旧标签" and saved.parent_id is None
        assert len([c for c in s.query(Category) if c.name == "宝宝"]) == 1
    assert Path(str(path) + ".before-upgrade-009").exists()
