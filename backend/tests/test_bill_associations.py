import json
import pytest
from app.database import Database
from app.bills import BillService
from app.bill_associations import BillAssociationService
from app.bill_posting import BillPostingService
from app.models import (
    Bill,
    BillLedger,
    ImportBatch,
    ImportRow,
    Transaction,
    Entry,
    BillAssociation,
)
from app.services import AccountService, ReportService
from app.domain import Clock, DomainError


@pytest.fixture
def db(tmp_path):
    db = Database(tmp_path / "db")
    db.initialize()
    return db


def seed(db, wx_posted=False, bank_posted=True, bank_amount=10000):
    with db.write() as s:
        for provider, amount in [("wechat", 10000), ("cmb", bank_amount)]:
            batch = ImportBatch(
                filename=provider + ".csv",
                digest=provider,
                created_at=Clock.now(),
                metadata_json=json.dumps({"parser": provider}),
            )
            s.add(batch)
            s.flush()
            key = provider + ":test"
            facts = dict(
                occurred_at="2026-09-01 12:00:00",
                amount_minor=amount,
                currency="CNY",
                flow="OUT",
                settlement="COMPLETED",
                counterparty="商户",
                description="商品",
                payment_hint="招商银行(1234)",
            )
            labels = dict(
                category_path=["支出", "购物"],
                status="CLASSIFIED",
                tags=[],
                classified_by="Codex",
            )
            s.add(
                Bill(
                    id=key,
                    facts=json.dumps(facts),
                    classification=json.dumps(labels),
                    revision=1,
                    saved_at=Clock.now(),
                )
            )
            s.add(
                ImportRow(
                    batch_id=batch.id,
                    line=1,
                    source_key=key,
                    status="REVIEW",
                    data=json.dumps(
                        {
                            "order_id": provider + "-123",
                            "source_key": key,
                            "line": 1,
                            "amount": amount,
                            "direction": "支出",
                            "status": "交易成功",
                            "note": "商品",
                            "method": "招商银行(1234)",
                            "review_reason": (
                                "银行卡渠道" if provider == "wechat" else ""
                            ),
                            **facts,
                        }
                    ),
                    decision=json.dumps({"account_id": 5}),
                )
            )
            s.add(BillLedger(bill_id=key, status="PENDING", reason=""))
            s.flush()
        for key, posted in [("wechat:test", wx_posted), ("cmb:test", bank_posted)]:
            if posted:
                BillPostingService(db).post_resolved(
                    s,
                    s.get(Bill, key),
                    s.get(BillLedger, key),
                    dict(kind="EXPENSE", account_id=5),
                )
    return BillAssociationService(db)


def balance(db):
    return next(a["balance"] for a in AccountService(db).list() if a["id"] == 5)


@pytest.mark.parametrize(
    "wx,bank,expected",
    [
        (False, True, -10000),
        (True, True, -10000),
        (True, False, -10000),
        (False, False, 0),
    ],
)
def test_link_once_one_detail_and_one_journal(db, wx, bank, expected):
    service = seed(db, wx, bank)
    result = service.link("wechat:test", "cmb:test", "同银行卡同商户同订单确认")
    rows = BillService(db).list()
    assert len(rows) == 1 and rows[0]["source_count"] == 2
    assert len(rows[0]["related_sources"]) == 1
    assert balance(db) == expected
    assert service.link("wechat:test", "cmb:test", "重复确认")["already_linked"]
    assert balance(db) == expected and ReportService(db).integrity()["ok"]
    with db.read() as s:
        assert s.query(Transaction).filter_by(
            kind="EXPENSE", status="POSTED"
        ).count() == int(wx or bank)
        assert s.query(Entry).join(Transaction).filter(
            Transaction.status == "POSTED",
            Transaction.kind == "EXPENSE",
            Entry.account_id == 5,
        ).count() == int(wx or bank)
    if not wx and not bank:
        BillPostingService(db).resolve(
            result["target_id"], dict(kind="EXPENSE", account_id=5)
        )
        assert balance(db) == -10000
        with db.read() as s:
            assert all(r.transaction_id for r in s.query(ImportRow))
    BillPostingService(db).reverse("wechat:test")
    assert balance(db) == 0 and ReportService(db).integrity()["ok"]


def test_amount_mismatch_rejected_atomically(db):
    service = seed(db, bank_amount=9999)
    with pytest.raises(DomainError):
        service.link("wechat:test", "cmb:test", "金额不符")
    assert len(BillService(db).list()) == 2 and balance(db) == -9999
    with db.read() as s:
        assert s.query(BillAssociation).count() == 0


def test_linked_voucher_cannot_be_posted_independently(db):
    service = seed(db)
    service.link("wechat:test", "cmb:test", "同一付款")
    with pytest.raises(DomainError, match="已关联"):
        BillPostingService(db).resolve(
            "wechat:test", dict(kind="EXPENSE", account_id=5)
        )
    with db.write() as s:
        with pytest.raises(DomainError, match="已关联"):
            BillPostingService(db).post_auto(s, "wechat:test", None)
    assert balance(db) == -10000


def test_cancel_linked_source_batch_does_not_own_bank_posting(db):
    service = seed(db)
    service.link("wechat:test", "cmb:test", "同一付款")
    from app.models import BillImportRun
    from app.import_workflow import BillImportWorkflow

    with db.write() as s:
        for provider in ("wechat", "cmb"):
            batch = s.query(ImportBatch).filter_by(filename=provider + ".csv").one()
            run = BillImportRun(
                batch_id=batch.id,
                filename=batch.filename,
                created_at=Clock.now(),
                status="IMPORTED",
                result="{}",
                summary="{}",
            )
            s.add(run)
            s.flush()
            s.get(BillLedger, provider + ":test").owner_run_id = run.id
            if provider == "wechat":
                source_run = run.id
    BillImportWorkflow(db).cancel(source_run)
    assert balance(db) == -10000 and ReportService(db).integrity()["ok"]


def test_cancel_pending_primary_marks_both_ledgers_revoked(db):
    service = seed(db, bank_posted=False)
    service.link("wechat:test", "cmb:test", "同一付款")
    BillPostingService(db).reverse("cmb:test")
    with db.read() as s:
        assert s.get(BillLedger, "wechat:test").status == "REVERSED"
        assert s.get(BillLedger, "cmb:test").status == "REVERSED"
    assert balance(db) == 0


def test_linked_original_order_id_search_finds_primary(db):
    service = seed(db)
    service.link("wechat:test", "cmb:test", "同一付款")
    rows = BillService(db).list({"q": "wechat-123"})
    assert len(rows) == 1 and rows[0]["id"] == "cmb:test"
