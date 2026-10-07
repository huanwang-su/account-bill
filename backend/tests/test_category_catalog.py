import json, sqlite3
from pathlib import Path
import pytest
from alembic.config import Config
from alembic import command
from app.database import Database
from app.models import Category, Bill, Entry, Transaction
from app.category_catalog import CategoryCatalog, CategoryGraph
from app.services import (
    CatalogService,
    TransactionService,
    ReportService,
    AccountService,
)
from app.bills import BillService, BillDocument, BillRecord, BillClassification
from app.domain import DomainError


def test_fresh_catalog_has_exactly_30_and_at_most_two_levels(tmp_path):
    db = Database(tmp_path / "db")
    db.initialize()
    catalog = CatalogService(db).categories()
    assert len(catalog) == 30
    assert len([c for c in catalog if c["kind"] == "EXPENSE"]) == 23
    assert len([c for c in catalog if c["kind"] == "INCOME"]) == 7
    by_id = {c["id"]: c for c in catalog}
    assert all(
        c["parent_id"] is None or by_id[c["parent_id"]]["parent_id"] is None
        for c in catalog
    )
    db.initialize()
    assert len(CatalogService(db).categories()) == 30


def test_ai_new_labels_map_to_existing_catalog_without_growth(tmp_path):
    db = Database(tmp_path / "db")
    db.initialize()
    doc = BillDocument(
        bills=[
            BillRecord(
                id="test:1",
                facts=dict(
                    occurred_at="2026-09-01 12:00:00",
                    amount_minor=100,
                    currency="CNY",
                    flow="OUT",
                    settlement="COMPLETED",
                    counterparty="测试商户",
                    description="未知商品",
                    payment_hint="钱包",
                ),
                classification=BillClassification(
                    category_path=["支出", "宇宙商品", "特殊子类"],
                    status="CLASSIFIED",
                    classified_by="测试",
                ),
            )
        ]
    )
    BillService(db).save(doc, allow_new=True)
    assert BillService(db).list()[0]["classification"]["category_path"] == [
        "支出",
        "未知用途",
    ]
    assert len(CatalogService(db).categories()) == 30


def test_manual_category_cannot_create_third_level(tmp_path):
    db = Database(tmp_path / "db")
    db.initialize()
    catalog = CatalogService(db)
    leaf = next(c for c in catalog.categories() if c["name"] == "用品")
    with pytest.raises(DomainError, match="两级"):
        catalog.save_category(dict(name="奶粉", kind="EXPENSE", parent_id=leaf["id"]))
    assert len(catalog.categories()) == 30


def test_upgrade_keeps_every_journal_and_aliases_old_ids(tmp_path):
    path = tmp_path / "old"
    root = Path(__file__).resolve().parents[1]
    cfg = Config(str(root / "alembic.ini"))
    cfg.set_main_option("script_location", str(root / "migrations"))
    cfg.set_main_option("sqlalchemy.url", "sqlite:///" + str(path))
    command.upgrade(cfg, "010")
    facts = json.dumps(
        dict(
            occurred_at="2026-09-01 12:00:00",
            amount_minor=100,
            currency="CNY",
            flow="OUT",
            settlement="COMPLETED",
            counterparty="测试",
            description="午餐",
            payment_hint="钱包",
        )
    )
    labels = json.dumps(
        dict(
            category_path=["支出", "餐饮", "堂食"],
            tags=[],
            status="CLASSIFIED",
            classified_by="测试",
            note="",
        )
    )
    with sqlite3.connect(path) as c:
        c.execute(
            "insert into accounts(id,name,number,role,kind,tags,active,opening_set) values(1,'消费','','SYSTEM','公共','[]',1,1),(5,'钱包','','ASSET','钱包','[]',1,0)"
        )
        c.execute(
            "insert into categories(id,name,parent_id,kind,active) values(1,'餐饮',NULL,'EXPENSE',1),(2,'堂食',1,'EXPENSE',1),(3,'交通出行',NULL,'EXPENSE',1),(4,'铁路',3,'EXPENSE',1)"
        )
        c.execute(
            "insert into transactions(id,occurred_at,posted_at,kind,counterparty,note,tags,status,source,idempotency_key) values(1,'2026-09-01 12:00:00','2026-09-01 12:00:00','EXPENSE','测试','午餐','[]','POSTED','测试','demo')"
        )
        c.execute(
            "insert into entries(id,transaction_id,account_id,category_id,amount) values(1,1,5,NULL,-100),(2,1,1,2,100)"
        )
        c.execute(
            "insert into bills(id,facts,classification,revision,saved_at) values('demo',?,?,1,'2026-09-01 12:00:00')",
            (facts, labels),
        )
        c.execute(
            "insert into bill_ledger(bill_id,status,reason,transaction_id) values('demo','POSTED','',1)"
        )
        c.execute(
            "insert into bill_journal_history(transaction_id,bill_id) values(1,'demo')"
        )
        c.execute(
            "insert into bill_classification_history(bill_id,revision,classification,saved_at) values('demo',1,?,'2026-09-01 12:00:00')",
            (labels,),
        )
        original_entries = c.execute("select * from entries").fetchall()
        original_tx = c.execute("select * from transactions").fetchall()
    db = Database(path)
    db.initialize()
    with db.read() as s:
        graph = CategoryGraph(s)
        assert graph.path(2) == ["餐饮", "日常用餐"]
        assert graph.path(4) == ["交通", "出行"]
        assert s.get(Category, 2).merged_into_id is not None
        assert s.get(Bill, "demo").facts == facts
    with sqlite3.connect(path) as c:
        assert c.execute("select * from entries").fetchall() == original_entries
        assert c.execute("select * from transactions").fetchall() == original_tx
        assert not c.execute("pragma foreign_key_check").fetchall()
    assert AccountService(db).list()[1]["balance"] == -100
    category_id = next(
        c["id"] for c in CatalogService(db).categories() if c["name"] == "日常用餐"
    )
    assert ReportService(db).summary({"category_id": category_id})["expense"] == 100
    assert BillService(db).list({"category": "支出 / 餐饮 / 日常用餐"})[0][
        "classification"
    ]["category_path"] == ["支出", "餐饮", "日常用餐"]
    assert len(CatalogService(db).categories()) == 30
    assert len(BillService(db).history("demo")) == 2
    assert Path(str(path) + ".before-upgrade-010").exists()
