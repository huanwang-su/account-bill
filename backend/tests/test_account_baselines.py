import json
import pytest
from app.account_baselines import AccountBaselineService
from app.account_config import AccountGraph, AccountMergeService
from app.database import Database
from app.domain import DomainError
from app.models import Entry, Reconciliation, Transaction
from app.securities import SecuritiesValuationService
from app.services import (
    AccountService,
    CatalogService,
    ReportService,
    TransactionService,
)


@pytest.fixture
def db(tmp_path):
    database = Database(tmp_path / "baseline.sqlite3")
    database.initialize()
    return database


def account(db, name="银行卡", kind="银行"):
    return AccountService(db).save(dict(name=name, kind=kind, role="ASSET"))["id"]


def request(amount="1000.00", **extra):
    return dict(
        amount=amount,
        occurred_at="2026-09-28 00:00:00",
        note="用户确认的9月28日期初资产截图",
        idempotency_key="test-baseline",
        **extra
    )


def balance(db, key, when=None):
    with db.read() as session:
        return AccountGraph(session).balances(session, when)[1].get(key, 0)


def expense(db, key, amount, when):
    category = next(
        c["id"]
        for c in CatalogService(db).categories()
        if c["name"] == "未知用途" and c["kind"] == "EXPENSE"
    )
    return TransactionService(db).post(
        dict(
            kind="EXPENSE",
            account_id=key,
            amount=amount,
            occurred_at=when,
            category_id=category,
            idempotency_key="expense:" + when,
        )
    )


def test_snapshot_offsets_earlier_history_without_income_and_is_idempotent(db):
    key = account(db, "资金账户")
    expense(db, key, "20.00", "2026-09-20 12:00:00")
    expense(db, key, "30.00", "2026-10-01 12:00:00")
    with db.read() as session:
        old = [(e.id, e.amount) for e in session.query(Entry)]
    service = AccountBaselineService(db)
    result = service.apply(key, request())
    assert result["adjustment_minor"] == 102000
    assert balance(db, key, "2026-09-28 00:00:00") == 100000
    assert balance(db, key) == 97000
    assert service.apply(key, request())["already_applied"]
    with db.read() as session:
        assert set(old).issubset({(e.id, e.amount) for e in session.query(Entry)})
        assert session.query(Reconciliation).count() == 1
    summary = ReportService(db).summary()
    assert summary["income"] == 0 and summary["expense"] == 5000
    assert ReportService(db).integrity()["ok"]
    with pytest.raises(DomainError):
        service.apply(key, request("999.00"))


def test_explicit_relocation_keeps_later_balance_without_doubling(db):
    key = account(db, "建设银行")
    AccountService(db).opening(
        key, dict(amount="65040", occurred_at="2026-10-17 10:00:00")
    )
    with db.read() as session:
        opening = session.query(Transaction).filter_by(kind="OPENING").one().id
    service = AccountBaselineService(db)
    with pytest.raises(DomainError, match="前移"):
        service.apply(key, request("65040"))
    service.apply(key, request("65040", relocate_opening_ids=[opening]))
    assert balance(db, key, "2026-09-28 00:00:00") == 6504000
    assert balance(db, key) == 6504000
    with db.read() as session:
        assert session.get(Transaction, opening).status == "POSTED"
        assert session.query(Transaction).count() == 3
    assert ReportService(db).summary()["income"] == 0


def test_merged_account_baseline_counts_both_sources_once(db):
    a, b = account(db, "测试微信"), account(db, "测试零钱通")
    expense(db, a, "20", "2026-09-20 12:00:00")
    expense(db, b, "30", "2026-09-21 12:00:00")
    AccountMergeService(db).merge(dict(source_id=b, target_id=a))
    AccountBaselineService(db).apply(a, request("7000"))
    assert balance(db, a) == 700000
    assert balance(db, a, "2026-09-28 00:00:00") == 700000


def test_explicit_zero_valuation_correction_is_audited_without_investment_loss(db):
    key = account(db, "华安证券", "证券")
    old = SecuritiesValuationService(db).update(
        key,
        dict(
            actual="0",
            occurred_at="2026-10-17 12:00:00",
            idempotency_key="zero",
            note="误填",
        ),
    )
    service = AccountBaselineService(db)
    with pytest.raises(DomainError, match="更正范围"):
        service.apply(key, request("35694"))
    service.apply(key, request("35694", correct_zero_valuation_ids=[old["id"]]))
    assert balance(db, key) == 3569400
    history = SecuritiesValuationService(db).history(key)
    assert [h["actual"] for h in history] == [3569400, 3569400]
    assert sum(h["change"] for h in history) == 0
    with db.read() as session:
        audit = json.loads(session.query(Reconciliation).one().note)
        assert audit["previous_valuations"][0]["actual"] == 0
        assert session.query(Transaction).filter_by(kind="EXPENSE").count() == 0


def test_nonzero_later_valuation_cannot_be_silently_rewritten(db):
    key = account(db, "证券", "证券")
    old = SecuritiesValuationService(db).update(
        key,
        dict(
            actual="500", occurred_at="2026-10-17 12:00:00", idempotency_key="nonzero"
        ),
    )
    with pytest.raises(DomainError, match="零余额"):
        AccountBaselineService(db).apply(
            key,
            request(
                "35694",
                relocate_opening_ids=[old["transaction_id"]],
                correct_zero_valuation_ids=[old["id"]],
            ),
        )
    assert balance(db, key) == 50000
