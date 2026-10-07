import uuid
import pytest
from app.database import Database
from app.services import (
    AccountService,
    CatalogService,
    TransactionService,
    ReportService,
)
from app.securities import SecuritiesValuationService
from app.counterparty_analysis import CounterpartyAnalysisService
from app.account_config import AccountMergeService
from app.models import Entry, AccountValuation, Transaction, Category
from app.domain import DomainError


@pytest.fixture
def ledger(tmp_path):
    db = Database(tmp_path / "db")
    db.initialize()
    accounts = AccountService(db)
    stock = accounts.save(dict(name="合成证券", kind="证券", role="ASSET"))["id"]
    return db, stock


def value(db, stock, actual, day, key=None):
    return SecuritiesValuationService(db).update(
        stock,
        dict(actual=actual, occurred_at=day, idempotency_key=key or str(uuid.uuid4())),
    )


def balance(db, account):
    return next(a["balance"] for a in AccountService(db).list() if a["id"] == account)


def test_first_balance_is_opening_then_gain_loss_and_zero_audit(ledger):
    db, stock = ledger
    first = value(db, stock, "1000", "2026-09-01")
    assert first["baseline"] and first["change"] == 0
    assert balance(db, stock) == 100000
    assert ReportService(db).summary()["income"] == 0
    gain = value(db, stock, "1200", "2026-09-02")
    loss = value(db, stock, "900", "2026-09-03")
    same = value(db, stock, "900", "2026-09-04")
    assert (gain["change"], loss["change"], same["change"]) == (20000, -30000, 0)
    assert same["transaction_id"] is None
    assert balance(db, stock) == 90000
    summary = ReportService(db).summary()
    assert (summary["income"], summary["expense"], summary["net"]) == (
        20000,
        30000,
        -10000,
    )
    assert len(SecuritiesValuationService(db).history(stock)) == 4
    with db.read() as s:
        assert s.get(Transaction, gain["transaction_id"]).kind == "INCOME"
        assert s.get(Transaction, loss["transaction_id"]).kind == "EXPENSE"
        assert sum(e.amount for e in s.query(Entry)) == 0
    TransactionService(db).reverse(loss["transaction_id"])
    assert balance(db, stock) == 120000
    assert SecuritiesValuationService(db).history(stock)[1]["status"] == "REVERSED"


def test_transferred_principal_is_not_gain_and_retry_is_idempotent(ledger):
    db, stock = ledger
    value(db, stock, "1000", "2026-09-01")
    TransactionService(db).post(
        dict(
            kind="TRANSFER",
            account_id=5,
            to_account_id=stock,
            amount="300",
            occurred_at="2026-09-02",
            idempotency_key="capital",
        )
    )
    result = value(db, stock, "1350", "2026-09-03", "same-update")
    assert result["calculated"] == 130000 and result["change"] == 5000
    assert value(db, stock, "1350", "2026-09-03", "same-update") == result
    with db.read() as s:
        assert s.query(AccountValuation).count() == 2
        assert s.query(Transaction).count() == 3
    with pytest.raises(DomainError, match="不同"):
        value(db, stock, "1400", "2026-09-03", "same-update")
    with pytest.raises(DomainError, match="早于"):
        value(db, stock, "1300", "2026-09-02")
    assert balance(db, stock) == 135000
    TransactionService(db).post(
        dict(
            kind="EXPENSE",
            account_id=5,
            category_id=1,
            amount="1",
            occurred_at="2026-09-04",
            idempotency_key="valuation:reserved",
        )
    )
    with pytest.raises(DomainError, match="其他交易"):
        value(db, stock, "1400", "2026-09-04", "reserved")
    assert balance(db, stock) == 135000


def test_valuation_guards_and_failed_update_rolls_back(ledger):
    db, stock = ledger
    with pytest.raises(DomainError, match="证券"):
        value(db, 5, "100", "2026-09-01")
    with pytest.raises(DomainError, match="负数"):
        value(db, stock, "-1", "2026-09-01")
    with pytest.raises(DomainError, match="自有资产"):
        AccountService(db).save(dict(name="错误证券", kind="证券", role="LIABILITY"))
    TransactionService(db).post(
        dict(
            kind="TRANSFER",
            account_id=5,
            to_account_id=stock,
            amount="10",
            occurred_at="2026-09-01",
            idempotency_key="no-opening",
        )
    )
    with pytest.raises(DomainError, match="补全期初"):
        value(db, stock, "20", "2026-09-02")
    AccountService(db).opening(stock, dict(amount="100", occurred_at="2026-08-01"))
    with db.write() as s:
        s.query(Category).filter_by(
            name="理财收益", kind="INCOME", merged_into_id=None
        ).one().active = False
    with pytest.raises(DomainError, match="启用"):
        value(db, stock, "120", "2026-09-03")
    with db.read() as s:
        assert s.query(AccountValuation).count() == 0
    assert balance(db, stock) == 11000


def test_counterparty_signed_refunds_transfers_and_split_count(ledger):
    db, stock = ledger
    transactions = TransactionService(db)
    category = next(
        c["id"] for c in CatalogService(db).categories() if c["name"] == "工资"
    )

    def tx(kind, amount, account=5, **extra):
        return transactions.post(
            dict(
                kind=kind,
                amount=amount,
                account_id=account,
                category_id=category if kind == "INCOME" else 1,
                occurred_at="2026-09-02",
                counterparty="  合成交易方  ",
                idempotency_key=str(uuid.uuid4()),
                **extra
            )
        )["id"]

    AccountService(db).opening(5, dict(amount="1000", occurred_at="2026-09-01"))
    tx("INCOME", "500")
    expense = tx("EXPENSE", "120")
    tx("REFUND", "20", related_id=expense)
    tx("TRANSFER", "50", to_account_id=6)
    tx("TRANSFER", "30", account=6, to_account_id=5)
    revoked = tx("EXPENSE", "10")
    transactions.reverse(revoked)
    tx(
        "EXPENSE",
        "30",
        items=[dict(amount="10", category_id=1), dict(amount="20", category_id=2)],
    )
    result = CounterpartyAnalysisService(db).analyze(5)
    assert (result["incoming"], result["outgoing"], result["net"], result["count"]) == (
        55000,
        20000,
        35000,
        6,
    )
    assert result["party_count"] == 1
    assert (
        result["parties"][0]["incoming_count"] == 3
        and result["parties"][0]["outgoing_count"] == 3
    )
    assert len(result["parties"][0]["transactions"]) == 6
    assert (
        CounterpartyAnalysisService(db).analyze(5, dict(start="2026-09-03"))["count"]
        == 0
    )
    assert (
        CounterpartyAnalysisService(db).analyze(5, dict(q="不存在"))["party_count"] == 0
    )


def test_counterparty_valuations_separate_from_principal_and_blank_transfer_named(
    ledger,
):
    db, stock = ledger
    value(db, stock, "1000", "2026-09-01")
    TransactionService(db).post(
        dict(
            kind="TRANSFER",
            account_id=5,
            to_account_id=stock,
            amount="300",
            occurred_at="2026-09-02",
            idempotency_key="deposit",
        )
    )
    value(db, stock, "1400", "2026-09-03")
    result = CounterpartyAnalysisService(db).analyze(stock)
    assert (
        result["incoming"] == 30000 and result["net"] == 30000 and result["count"] == 1
    )
    assert result["valuation_gain"] == 10000 and result["valuation_count"] == 1
    assert result["parties"][0]["counterparty"] == "支付宝余额"
    assert result["valuations"][0]["counterparty"] == "证券估值"


def test_merge_internal_movements_cancel_and_old_entries_count_once(ledger):
    db, stock = ledger
    TransactionService(db).post(
        dict(
            kind="TRANSFER",
            account_id=5,
            to_account_id=6,
            amount="300",
            occurred_at="2026-09-02",
            idempotency_key="internal",
        )
    )
    TransactionService(db).post(
        dict(
            kind="EXPENSE",
            account_id=6,
            amount="30",
            category_id=1,
            counterparty="合成商户",
            occurred_at="2026-09-02",
            idempotency_key="shop",
        )
    )
    AccountMergeService(db).merge(dict(source_id=6, target_id=5))
    result = CounterpartyAnalysisService(db).analyze(6)
    assert (
        result["account_id"] == 5
        and result["count"] == 1
        and result["outgoing"] == 3000
    )
    with pytest.raises(DomainError):
        CounterpartyAnalysisService(db).analyze(1)


def test_valuation_merged_sources_and_zero_initial_balance(ledger):
    db, stock = ledger
    initial = value(db, stock, "0", "2026-09-01")
    assert initial["baseline"] and initial["transaction_id"] is None
    source = AccountService(db).save(dict(name="旧证券", kind="证券", role="ASSET"))[
        "id"
    ]
    value(db, source, "100", "2026-09-01")
    AccountMergeService(db).merge(dict(source_id=source, target_id=stock))
    result = value(db, stock, "110", "2026-09-02")
    assert result["calculated"] == 10000 and result["change"] == 1000
    assert balance(db, stock) == 11000
    assert len(SecuritiesValuationService(db).history(stock)) == 3
