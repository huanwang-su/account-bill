import uuid
import pytest
from app.database import Database
from app.services import AccountService, CatalogService, TransactionService
from app.securities import SecuritiesValuationService
from app.investment_analysis import InvestmentAnalysisService
from app.account_config import AccountMergeService
from app.domain import DomainError


@pytest.fixture
def portfolio(tmp_path):
    db = Database(tmp_path / "db")
    db.initialize()
    accounts = AccountService(db)
    bank = next(a for a in accounts.list() if a["id"] == 6)
    accounts.save({**bank, "kind": "银行卡"}, 6)
    a = accounts.save(dict(name="合成证券甲", kind="证券", role="ASSET"))["id"]
    b = accounts.save(dict(name="合成证券乙", kind="证券", role="ASSET"))["id"]
    values = SecuritiesValuationService(db)
    tx = TransactionService(db)

    def value(account, actual, day):
        return values.update(
            account,
            dict(actual=actual, occurred_at=day, idempotency_key=str(uuid.uuid4())),
        )

    def transfer(source, target, amount, day):
        return tx.post(
            dict(
                kind="TRANSFER",
                account_id=source,
                to_account_id=target,
                amount=amount,
                occurred_at=day,
                idempotency_key=str(uuid.uuid4()),
            )
        )

    value(a, "1000", "2026-09-01")
    value(b, "2000", "2026-09-01")
    first = value(a, "1100", "2026-09-02")
    value(b, "2200", "2026-09-02")
    transfer(5, a, "500", "2026-09-03")
    value(a, "1650", "2026-09-03")
    transfer(b, 5, "200", "2026-09-04")
    transfer(a, b, "100", "2026-09-05")
    value(a, "1500", "2026-09-06")
    value(b, "2200", "2026-09-06")
    cats = CatalogService(db).categories()
    income = next(c["id"] for c in cats if c["name"] == "理财收益")
    tx.post(
        dict(
            kind="INCOME",
            account_id=a,
            amount="10",
            category_id=income,
            occurred_at="2026-09-07",
            counterparty="合成分红",
            idempotency_key="dividend",
        )
    )
    tx.post(
        dict(
            kind="EXPENSE",
            account_id=b,
            amount="5",
            category_id=1,
            occurred_at="2026-09-08",
            counterparty="合成费用",
            idempotency_key="fee",
        )
    )
    tx.post(
        dict(
            kind="TRANSFER",
            account_id=5,
            to_account_id=a,
            amount="500",
            occurred_at="2026-10-01",
            idempotency_key="future",
        )
    )
    return db, a, b, first["transaction_id"]


def test_all_securities_exclude_bank_principal_and_internal_transfers(portfolio):
    db, a, b, _ = portfolio
    result = InvestmentAnalysisService(db).analyze(end="2026-09-30", grain="day")
    assert result["account_count"] == 2 and result["beginning"] == 0
    assert result["opening_added"] == 300000 and result["ending"] == 370500
    assert (result["capital_in"], result["capital_out"], result["capital_net"]) == (
        50000,
        20000,
        30000,
    )
    assert result["internal_in"] == result["internal_out"] == 10000
    assert result["internal_net"] == 0 and result["internal_volume"] == 10000
    assert (
        result["valuation_profit"] == 40000
        and result["other_profit"] == 500
        and result["profit"] == 40500
    )
    assert result["gain"] == 46000 and result["loss"] == 5500
    assert result["reconciled"] and result["missing_opening_ids"] == []
    assert len(result["transfers"]) == 3 and len(result["profits"]) == 7
    assert sum(r["profit"] for r in result["trend"]) == 40500
    assert result["trend"][-1]["assets"] == 370500
    assert result["trend"][-1]["cumulative_profit"] == 40500


def test_single_and_all_conserve_profit_and_securities_internal_net(portfolio):
    db, a, b, _ = portfolio
    service = InvestmentAnalysisService(db)
    ra = service.analyze(a, start="2026-09-02", end="2026-09-30")
    rb = service.analyze(b, start="2026-09-02", end="2026-09-30")
    both = service.analyze(start="2026-09-02", end="2026-09-30")
    assert (
        ra["beginning"] == 100000 and ra["ending"] == 151000 and ra["profit"] == 11000
    )
    assert ra["internal_net"] == -10000 and ra["capital_net"] == 50000
    assert (
        rb["beginning"] == 200000 and rb["ending"] == 219500 and rb["profit"] == 29500
    )
    assert rb["internal_net"] == 10000 and rb["capital_net"] == -20000
    assert all(
        ra[k] + rb[k] == both[k]
        for k in (
            "beginning",
            "ending",
            "profit",
            "valuation_profit",
            "capital_net",
            "internal_net",
        )
    )
    assert both["opening_added"] == 0 and both["trend"][0]["assets"] == 370500


def test_date_bounds_reversal_and_merge_never_duplicate(portfolio):
    db, a, b, first = portfolio
    service = InvestmentAnalysisService(db)
    day = service.analyze(end="2026-09-01")
    assert day["ending"] == 300000 and day["profit"] == 0
    period = service.analyze(start="2026-09-03", end="2026-09-05")
    assert (
        period["beginning"] == 330000
        and period["ending"] == 365000
        and period["profit"] == 5000
    )
    with pytest.raises(DomainError, match="已有证券估值"):
        TransactionService(db).reverse(first)
    values = SecuritiesValuationService(db)
    replay = [
        row
        for row in values.history(a)
        if not row["baseline"] and row["transaction_id"] != first
    ]
    for row in replay:
        values.cancel(a, row["id"])
    TransactionService(db).reverse(first)
    for row in replay[::-1]:
        values.update(
            a,
            dict(
                actual=str(row["actual"] / 100),
                occurred_at=row["occurred_at"],
                idempotency_key="rebuilt:" + str(row["id"]),
            ),
        )
    reversed = service.analyze(end="2026-09-30")
    assert (
        reversed["profit"] == 40500
        and reversed["ending"] == 370500
        and reversed["reconciled"]
    )
    AccountMergeService(db).merge(dict(source_id=b, target_id=a))
    merged = service.analyze(b, end="2026-09-30")
    assert (
        merged["account_count"] == 1
        and merged["profit"] == 40500
        and merged["ending"] == 370500
    )
    assert merged["internal_net"] == 0 and merged["internal_volume"] == 0


def test_missing_baseline_inactive_account_and_read_only(portfolio):
    db, a, b, _ = portfolio
    accounts = AccountService(db)
    unknown = accounts.save(dict(name="未设期初证券", kind="证券", role="ASSET"))["id"]
    TransactionService(db).post(
        dict(
            kind="TRANSFER",
            account_id=5,
            to_account_id=unknown,
            amount="50",
            occurred_at="2026-09-03",
            idempotency_key="unknown",
        )
    )
    account = next(r for r in accounts.list() if r["id"] == b)
    accounts.save({**account, "active": False}, b)
    before = [(r["id"], r["balance"]) for r in accounts.list()]
    result = InvestmentAnalysisService(db).analyze(end="2026-09-30")
    assert unknown in result["missing_opening_ids"]
    assert any(r["id"] == b and not r["active"] for r in result["accounts"])
    assert before == [(r["id"], r["balance"]) for r in accounts.list()]
    assert result["profit"] == 40500 and result["reconciled"]


def test_empty_and_invalid_selection(tmp_path):
    db = Database(tmp_path / "empty")
    db.initialize()
    accounts = AccountService(db)
    bank = next(a for a in accounts.list() if a["id"] == 6)
    accounts.save({**bank, "kind": "银行卡"}, 6)
    service = InvestmentAnalysisService(db)
    result = service.analyze()
    assert (
        result["account_count"] == result["profit"] == result["ending"] == 0
        and result["trend"] == []
    )
    future = AccountService(db).save(
        dict(name="未来证券基准", kind="证券", role="ASSET")
    )["id"]
    SecuritiesValuationService(db).update(
        future,
        dict(actual="0", occurred_at="2026-12-01", idempotency_key="future-zero"),
    )
    assert InvestmentAnalysisService(db).analyze(end="2026-11-30")[
        "missing_opening_ids"
    ] == [future]
    for kwargs in (
        dict(account_id=1),
        dict(account_id=5),
        dict(account_id=99999),
        dict(start="bad"),
        dict(start="2026-10-01", end="2026-09-01"),
        dict(grain="year"),
    ):
        with pytest.raises(DomainError):
            service.analyze(**kwargs)


@pytest.mark.parametrize("ordinary_kind", ["银行卡", "微信", "支付宝"])
def test_ordinary_account_returns_are_excluded_even_with_investment_categories(
    portfolio, ordinary_kind
):
    db, a, b, _ = portfolio
    accounts = AccountService(db)
    account = next(r for r in accounts.list() if r["id"] == 5)
    accounts.save({**account, "kind": ordinary_kind}, 5)
    catalog = CatalogService(db)
    categories = catalog.categories()
    income = next(c["id"] for c in categories if c["name"] == "理财收益")
    loss = next(c["id"] for c in categories if c["name"] == "投资亏损")
    salary = next(c["id"] for c in categories if c["name"] == "工资")
    interest = catalog.save_category(
        dict(name="存款利息", kind="INCOME", parent_id=income)
    )["id"]
    transactions = TransactionService(db)
    service = InvestmentAnalysisService(db)
    before = service.analyze(end="2026-09-30")

    def post(kind, amount, category, **extras):
        return transactions.post(
            dict(
                kind=kind,
                amount=amount,
                category_id=category,
                account_id=5,
                occurred_at="2026-09-10",
                idempotency_key=str(uuid.uuid4()),
                **extras
            )
        )["id"]

    post("INCOME", "100", interest)
    post("INCOME", "500", salary)
    fee = post("EXPENSE", "8", loss)
    post("REFUND", "2", loss, related_id=fee)
    post(
        "EXPENSE",
        "100",
        loss,
        items=[dict(category_id=loss, amount="30"), dict(category_id=1, amount="70")],
    )
    all_accounts = service.analyze(end="2026-09-30")
    assert all_accounts == before
    assert all_accounts["profit"] == 40500 and all_accounts["ending"] == 370500
    assert {r["id"] for r in all_accounts["available_accounts"]} == {a, b}
    with pytest.raises(DomainError, match="证券或理财"):
        service.analyze(5, end="2026-09-30")


def test_wealth_account_type_is_included_without_classifying_bank_balance(tmp_path):
    db = Database(tmp_path / "db")
    db.initialize()
    AccountService(db).opening(6, dict(amount="1000", occurred_at="2026-09-01"))
    categories = CatalogService(db).categories()
    income = next(c["id"] for c in categories if c["name"] == "理财收益")
    transactions = TransactionService(db)
    transactions.post(
        dict(
            kind="TRANSFER",
            account_id=5,
            to_account_id=6,
            amount="300",
            occurred_at="2026-09-02",
            idempotency_key="funding",
        )
    )
    transactions.post(
        dict(
            kind="INCOME",
            account_id=6,
            amount="10",
            category_id=income,
            occurred_at="2026-09-03",
            idempotency_key="yield",
        )
    )
    transactions.post(
        dict(
            kind="EXPENSE",
            account_id=6,
            amount="2",
            category_id=1,
            occurred_at="2026-09-04",
            idempotency_key="fee",
        )
    )
    result = InvestmentAnalysisService(db).analyze(end="2026-09-30")
    assert result["account_count"] == 1 and result["asset_account_count"] == 1
    assert (
        result["profit"] == 800
        and result["ending"] == 130800
        and result["capital_net"] == 30000
    )
    assert result["income_only_count"] == 0 and result["reconciled"]
    assert result["accounts"][0]["kind"] == "理财"
