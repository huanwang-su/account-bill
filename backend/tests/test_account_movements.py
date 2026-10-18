import uuid
import pytest
from app.account_config import AccountGroupService, AccountMergeService
from app.account_movements import AccountMovementService
from app.balance_sheet import BalanceSheetService
from app.database import Database
from app.domain import Clock, DomainError
from app.financial_analysis import FinancialAnalysisService
from app.models import Entry, Transaction
from app.securities import SecuritiesValuationService
from app.services import (
    AccountService,
    CatalogService,
    ReportService,
    TransactionService,
)


@pytest.fixture
def movement_ledger(tmp_path, monkeypatch):
    monkeypatch.setattr(Clock, "now", staticmethod(lambda: "2026-10-18 12:00:00"))
    db = Database(tmp_path / "movements.db")
    db.initialize()
    groups = AccountGroupService(db)
    family = groups.save(dict(name="变动家庭"))["id"]
    mine = groups.save(dict(name="甲", parent_id=family))["id"]
    peer_group = groups.save(dict(name="乙", parent_id=family))["id"]
    accounts = AccountService(db)

    def account(name, group, opening=None, role="ASSET", kind="银行卡"):
        key = accounts.save(dict(name=name, role=role, kind=kind, group_id=group))["id"]
        if opening is not None:
            accounts.opening(key, dict(amount=opening, occurred_at="2026-09-20"))
        return key

    bank = account("主卡", mine, "1000")
    peer = account("另一成员", peer_group, "200")
    credit = account("信用卡", mine, "-300", "LIABILITY", "信用卡")
    wealth = account("证券", mine, "500", kind="证券")
    initial = account("期内期初", mine)
    inactive = account("已停用", mine, "50")
    external = account("商户账户", mine, "9999", "EXTERNAL")
    catalog = CatalogService(db)
    food = next(c["id"] for c in catalog.categories() if c["name"] == "餐饮")
    housing = next(c["id"] for c in catalog.categories() if c["name"] == "住房")
    salary = next(c["id"] for c in catalog.categories() if c["name"] == "工资")
    catalog.save_tag(dict(name="专项", scope="TRANSACTION"))
    tx = TransactionService(db)

    def post(kind, key, amount, when, category=None, **extra):
        return tx.post(
            dict(
                kind=kind,
                account_id=key,
                amount=amount,
                occurred_at=when,
                category_id=category or (salary if kind == "INCOME" else food),
                idempotency_key=str(uuid.uuid4()),
                **extra,
            )
        )["id"]

    post("EXPENSE", bank, "50", "2026-09-30 23:59:59")
    post("INCOME", bank, "100", "2026-10-01 00:00:00")
    payment = post(
        "EXPENSE", bank, "200", "2026-10-02", tags=["专项"], counterparty="标签商户"
    )
    post("REFUND", bank, "30", "2026-10-03", related_id=payment)
    internal = post("TRANSFER", bank, "70", "2026-10-04", to_account_id=peer)
    post("EXPENSE", credit, "40", "2026-10-05")
    repayment = post("TRANSFER", bank, "20", "2026-10-06", to_account_id=credit)
    valuation = SecuritiesValuationService(db)
    valuation.update(
        wealth, dict(actual="580", occurred_at="2026-10-07", idempotency_key="gain")
    )
    valuation.update(
        wealth, dict(actual="560", occurred_at="2026-10-08", idempotency_key="loss")
    )
    accounts.opening(initial, dict(amount="12", occurred_at="2026-10-09"))
    cancelled = post("EXPENSE", bank, "15", "2026-10-10")
    tx.reverse(cancelled)
    post(
        "EXPENSE",
        bank,
        "100",
        "2026-10-11",
        items=[
            dict(amount="60", category_id=food),
            dict(amount="40", category_id=housing),
        ],
    )
    post("EXPENSE", bank, "10", "2026-10-18 23:59:59")
    post("INCOME", bank, "999", "2026-10-19 00:00:00")
    accounts.save(
        {**next(a for a in accounts.list() if a["id"] == inactive), "active": False},
        inactive,
    )
    return db, dict(
        family=family,
        mine=mine,
        peer_group=peer_group,
        bank=bank,
        peer=peer,
        credit=credit,
        wealth=wealth,
        initial=initial,
        inactive=inactive,
        external=external,
        food=food,
        salary=salary,
        internal=internal,
        repayment=repayment,
        cancelled=cancelled,
    )


def period(ids, **extra):
    return dict(start="2026-10-01", end="2026-10-18", group_id=ids["family"], **extra)


def assert_reconciles(result):
    for row in result["accounts"]:
        assert row["reconciled"]
        assert (
            row["opening_balance"] + row["inflow"] - row["outflow"]
            == row["ending_balance"]
        )
        assert row["net_change"] == row["inflow"] - row["outflow"]
        assert row["operating_change"] == row["net_change"] - row["opening_added"]
        assert (
            row["operating_change"]
            == row["operating_inflow"] - row["operating_outflow"]
        )
        assert row["net_change"] == row["asset_change"] - row["liability_change"]
        assert (
            sum(value["net_change"] for value in row["breakdown"]) == row["net_change"]
        )
        assert sum(value["inflow"] for value in row["breakdown"]) == row["inflow"]
        assert sum(value["outflow"] for value in row["breakdown"]) == row["outflow"]
        assert row["transaction_ids"] == sorted(set(row["transaction_ids"]))
    totals = result["totals"]
    assert totals["reconciled"]
    assert totals["opening_balance"] + totals["net_change"] == totals["ending_balance"]
    for key in AccountMovementService.AMOUNTS:
        assert sum(row[key] for row in result["accounts"]) == totals[key]


def test_complete_period_balances_types_and_transfer_cancellation(movement_ledger):
    db, ids = movement_ledger
    result = AccountMovementService(db).analyze(period(ids))
    assert_reconciles(result)
    rows = {row["id"]: row for row in result["accounts"]}
    bank = rows[ids["bank"]]
    assert (
        bank["opening_balance"],
        bank["inflow"],
        bank["outflow"],
        bank["ending_balance"],
        bank["net_change"],
    ) == (95000, 14500, 41500, 68000, -27000)
    assert rows[ids["peer"]]["net_change"] == 7000
    assert rows[ids["credit"]]["net_change"] == -2000
    assert rows[ids["credit"]]["ending_balance"] == -32000
    assert rows[ids["initial"]]["opening_balance"] == 0
    assert rows[ids["initial"]]["ending_balance"] == 1200
    assert rows[ids["initial"]]["opening_added"] == 1200
    assert rows[ids["initial"]]["operating_change"] == 0
    assert rows[ids["initial"]]["operating_inflow"] == 0
    assert (
        not rows[ids["inactive"]]["active"] and rows[ids["inactive"]]["net_change"] == 0
    )
    assert ids["external"] not in rows
    valuation = {row["kind"]: row for row in rows[ids["wealth"]]["breakdown"]}
    assert valuation["VALUATION"]["inflow"] == 8000
    assert valuation["VALUATION"]["outflow"] == 2000
    assert "INCOME" not in valuation and "EXPENSE" not in valuation
    assert rows[ids["initial"]]["breakdown"][0]["kind"] == "OPENING"
    assert rows[ids["wealth"]]["operating_change"] == 6000
    assert result["totals"]["opening_added"] == 1200
    assert result["totals"]["operating_change"] == -16000
    kinds = {row["kind"]: row for row in bank["breakdown"]}
    assert kinds["REFUND"]["inflow"] == 3000
    assert kinds["REVERSAL"]["inflow"] == 1500
    assert kinds["TRANSFER"]["outflow"] == 9000
    assert (
        result["totals"]["opening_balance"],
        result["totals"]["ending_balance"],
        result["totals"]["net_change"],
    ) == (140000, 125200, -14800)
    opening = BalanceSheetService(db).snapshot("2026-09-30", ids["family"])
    ending = BalanceSheetService(db).snapshot("2026-10-18", ids["family"])
    assert result["totals"]["opening_assets"] == opening["assets"]
    assert result["totals"]["opening_liabilities"] == opening["liabilities"]
    assert result["totals"]["ending_assets"] == ending["assets"]
    assert result["totals"]["ending_liabilities"] == ending["liabilities"]
    assert (
        result["totals"]["net_change"] == ending["net_assets"] - opening["net_assets"]
    )


@pytest.mark.parametrize(
    "extra",
    [
        {"category_id": 0},
        {"tag": "专项"},
        {"q": "标签商户"},
        {"kind": "TRANSFER"},
        {"min_amount": "500"},
        {"max_amount": "1"},
        {"account_tag": "不存在的账户标签"},
    ],
)
def test_transaction_filters_are_explicitly_ignored_by_complete_balances(
    movement_ledger, extra
):
    db, ids = movement_ledger
    base = AccountMovementService(db).analyze(period(ids))
    if "category_id" in extra:
        extra = dict(category_id=ids["food"], exact_category=True)
    result = FinancialAnalysisService(db).analyze(
        dict(
            period(ids),
            exclude_investment_accounts=False,
            exclude_single_accounts=False,
            **extra,
        )
    )
    movements = result["account_movements"]
    assert movements["accounts"] == base["accounts"]
    assert movements["totals"] == base["totals"]
    assert set(extra) <= set(movements["ignored_filters"])
    assert movements["basis"] == "complete_account_period"
    if extra.get("tag") == "专项":
        assert result["expense"] == 20000 and result["count"] == 1
        assert movements["totals"]["net_change"] == -14800
    if extra.get("kind") == "TRANSFER":
        assert result["count"] == 0 and movements["totals"]["net_change"] != 0


def test_account_group_scopes_are_intersections_and_non_funding_scope_is_empty(
    movement_ledger,
):
    db, ids = movement_ledger
    service = AccountMovementService(db)
    whole = service.analyze(period(ids))
    mine = service.analyze(dict(period(ids), group_id=ids["mine"]))
    peer = service.analyze(dict(period(ids), group_id=ids["peer_group"]))
    assert (
        mine["totals"]["net_change"] + peer["totals"]["net_change"]
        == whole["totals"]["net_change"]
    )
    one = service.analyze(period(ids, account_id=ids["bank"]))
    assert [row["id"] for row in one["accounts"]] == [ids["bank"]]
    assert one["totals"]["net_change"] == -27000
    assert (
        service.analyze(
            dict(period(ids), account_id=ids["bank"], group_id=ids["peer_group"])
        )["accounts"]
        == []
    )
    for account_id in (1, ids["external"]):
        empty = service.analyze(period(ids, account_id=account_id))
        assert empty["accounts"] == [] and empty["totals"]["net_change"] == 0


def test_canonical_merge_nets_each_internal_transaction_once(movement_ledger):
    db, ids = movement_ledger
    AccountMergeService(db).merge(dict(source_id=ids["peer"], target_id=ids["bank"]))
    result = AccountMovementService(db).analyze(period(ids, account_id=ids["peer"]))
    assert_reconciles(result)
    assert result["applied_filters"]["account_id"] == ids["bank"]
    row = result["accounts"][0]
    assert row["id"] == ids["bank"] and row["merged_source_count"] == 1
    assert (row["opening_balance"], row["ending_balance"], row["net_change"]) == (
        115000,
        95000,
        -20000,
    )
    assert (row["inflow"], row["outflow"]) == (14500, 34500)
    transfer = next(value for value in row["breakdown"] if value["kind"] == "TRANSFER")
    assert ids["internal"] in transfer["transaction_ids"]
    assert transfer["inflow"] == 0 and transfer["outflow"] == 2000
    zero = AccountMovementService(db).analyze(
        dict(
            start="2026-10-04",
            end="2026-10-04",
            account_id=ids["bank"],
        )
    )
    assert_reconciles(zero)
    same_account = zero["accounts"][0]
    assert (
        same_account["inflow"]
        == same_account["outflow"]
        == same_account["net_change"]
        == 0
    )
    assert same_account["transaction_ids"] == [ids["internal"]]
    assert same_account["transaction_count"] == zero["totals"]["transaction_count"] == 1
    assert same_account["breakdown"][0]["kind"] == "TRANSFER"
    assert same_account["breakdown"][0]["transaction_count"] == 1


def test_composite_preserves_gross_assets_debt_and_net_movements(movement_ledger):
    db, ids = movement_ledger
    merges = AccountMergeService(db)
    merges.merge(dict(source_id=ids["credit"], target_id=ids["bank"]))
    merges.merge(dict(source_id=ids["wealth"], target_id=ids["bank"]))
    result = AccountMovementService(db).analyze(period(ids, account_id=ids["bank"]))
    assert_reconciles(result)
    row = result["accounts"][0]
    assert row["composite"] and row["merged_source_count"] == 2
    assert (
        row["opening_assets"],
        row["opening_liabilities"],
        row["opening_balance"],
    ) == (145000, 30000, 115000)
    assert (row["ending_assets"], row["ending_liabilities"], row["ending_balance"]) == (
        124000,
        32000,
        92000,
    )
    assert (row["inflow"], row["outflow"], row["net_change"]) == (22500, 45500, -23000)
    transfer = next(value for value in row["breakdown"] if value["kind"] == "TRANSFER")
    assert transfer["outflow"] == 7000 and transfer["inflow"] == 0
    assert ids["repayment"] in transfer["transaction_ids"]
    full = AccountMovementService(db).analyze(period(ids))
    sheet = BalanceSheetService(db).snapshot("2026-10-18", ids["family"])
    assert full["totals"]["ending_assets"] == sheet["assets"]
    assert full["totals"]["ending_liabilities"] == sheet["liabilities"]


def test_date_and_timestamp_boundaries_and_unbounded_history(movement_ledger):
    db, ids = movement_ledger
    service = AccountMovementService(db)
    timestamp = service.analyze(
        dict(
            period(ids),
            start="2026-10-01 12:00:00",
            end="2026-10-18 23:59:58",
            account_id=ids["bank"],
        )
    )
    assert_reconciles(timestamp)
    assert (
        timestamp["accounts"][0]["opening_balance"],
        timestamp["accounts"][0]["ending_balance"],
    ) == (105000, 69000)
    zoned = service.analyze(
        dict(
            period(ids),
            start="2026-09-30T16:00:00+00:00",
            end="2026-10-18T15:59:59+00:00",
        )
    )
    assert zoned["accounts"] == service.analyze(period(ids))["accounts"]
    history = service.analyze(dict(group_id=ids["family"]))
    assert history["start"] == "2026-09-20" and history["end"] == "2026-10-19"
    assert history["start_unbounded"] and history["end_unbounded"]
    assert history["totals"]["opening_balance"] == 0
    before = service.analyze(dict(group_id=ids["family"], end="2026-09-19"))
    assert before["totals"]["ending_balance"] == 0
    assert set(before["missing_opening_ids"]) == {
        row["id"] for row in before["accounts"]
    }
    for extra in (
        {"start": "bad"},
        {"start": "2026-02-30"},
        {"start": "2026-10-19", "end": "2026-10-18"},
    ):
        with pytest.raises(DomainError):
            service.analyze(dict(period(ids), **extra))


def test_reversal_in_another_period_uses_ledger_dates_not_effective_status(
    movement_ledger,
):
    db, ids = movement_ledger
    with db.write() as session:
        reversal = (
            session.query(Transaction).filter_by(reversal_of=ids["cancelled"]).one()
        )
        reversal.occurred_at = "2026-10-20 00:00:00"
    service = AccountMovementService(db)
    original = service.analyze(
        dict(start="2026-10-10", end="2026-10-10", account_id=ids["bank"])
    )
    assert original["totals"]["net_change"] == -1500
    assert_reconciles(original)
    restored = service.analyze(
        dict(start="2026-10-20", end="2026-10-20", account_id=ids["bank"])
    )
    assert restored["totals"]["net_change"] == 1500
    assert restored["accounts"][0]["breakdown"][0]["kind"] == "REVERSAL"
    assert_reconciles(restored)


def test_analysis_does_not_write_journals_and_preserves_original_income_scope(
    movement_ledger,
):
    db, ids = movement_ledger
    with db.read() as session:
        entries = [
            (e.id, e.account_id, e.category_id, e.amount) for e in session.query(Entry)
        ]
        transactions = [
            (t.id, t.status, t.occurred_at) for t in session.query(Transaction)
        ]
    report = FinancialAnalysisService(db).analyze(
        period(ids, tag="专项", category_id=ids["food"])
    )
    assert report["count"] == 1 and report["expense"] == 20000
    assert_reconciles(report["account_movements"])
    with db.read() as session:
        assert entries == [
            (e.id, e.account_id, e.category_id, e.amount) for e in session.query(Entry)
        ]
        assert transactions == [
            (t.id, t.status, t.occurred_at) for t in session.query(Transaction)
        ]
    assert ReportService(db).integrity()["ok"]
