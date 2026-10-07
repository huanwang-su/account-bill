import json
import sqlite3
from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config
from app.database import Database
from app.services import CatalogService, TransactionService, ReportService
from app.classification_policy import ClassificationPolicyService
from app.models import Bill, Entry, Tag, Transaction
from app.domain import DomainError


def test_archive_keeps_historical_labels_and_money_and_can_restore(tmp_path):
    db = Database(tmp_path / "db")
    db.initialize()
    catalog = CatalogService(db)
    root = catalog.save_tag(dict(name="旧用途"))["id"]
    child = catalog.save_tag(dict(name="旧用餐", parent_id=root))["id"]
    TransactionService(db).post(
        dict(
            kind="EXPENSE",
            amount="12",
            account_id=5,
            category_id=1,
            occurred_at="2026-09-01",
            idempotency_key="archive",
            tags=["旧用餐"],
        )
    )

    def facts():
        with db.read() as s:
            return (
                [(e.id, e.amount, e.category_id) for e in s.query(Entry)],
                [(b.id, b.facts, b.classification, b.revision) for b in s.query(Bill)],
                [(t.id, t.tags, t.status) for t in s.query(Transaction)],
            )

    before = facts()
    assert catalog.set_tag_active(root, False) == dict(id=root, active=False, count=2)
    assert all(not t["active"] for t in catalog.tags())
    assert ClassificationPolicyService(db).reference()["taxonomy"]["tags"] == []
    assert ReportService(db).summary(dict(tag="旧用途"))["expense"] == 1200
    assert facts() == before
    assert catalog.set_tag_active(root, False)["count"] == 2
    with pytest.raises(DomainError, match="先恢复父标签"):
        catalog.set_tag_active(child, True)
    with pytest.raises(DomainError, match="先恢复父标签"):
        catalog.save_tag(dict(name="新子标签", parent_id=root))
    with pytest.raises(DomainError, match="布尔"):
        catalog.set_tag_active(root, "false")
    catalog.set_tag_active(root, True)
    assert {
        t["name"]
        for t in ClassificationPolicyService(db).reference()["taxonomy"]["tags"]
    } == {"旧用途", "旧用餐"}
    assert facts() == before


def test_tag_archive_upgrade_retains_identity_and_defaults_to_active(tmp_path):
    path = tmp_path / "old"
    root = Path(__file__).resolve().parents[1]
    cfg = Config(str(root / "alembic.ini"))
    cfg.set_main_option("script_location", str(root / "migrations"))
    cfg.set_main_option("sqlalchemy.url", "sqlite:///" + str(path))
    command.upgrade(cfg, "011")
    with sqlite3.connect(path) as c:
        c.execute("insert into tags(id,name,scope) values(1,'历史标签','BOTH')")
    db = Database(path)
    db.initialize()
    with db.read() as s:
        saved = s.get(Tag, 1)
        assert saved.name == "历史标签" and saved.active and saved.parent_id is None
    assert Path(str(path) + ".before-upgrade-011").exists()
