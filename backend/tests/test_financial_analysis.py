import uuid
import pytest
from fastapi.testclient import TestClient
from app.database import Database
from app.services import (
    AccountService,
    CatalogService,
    TransactionService,
    ReportService,
)
from app.account_config import AccountGroupService, AccountMergeService
from app.financial_analysis import FinancialAnalysisService
from app.domain import DomainError
from app.main import LedgerApplication


@pytest.fixture
def ledger(tmp_path):
    db = Database(tmp_path / "db")
    db.initialize()
    # These conservation tests explicitly compare the complete ledger.
    from app.analysis_settings import AnalysisSettingsService

    AnalysisSettingsService(db).save(
        dict(
            revision=0, exclude_investment_accounts=False, exclude_single_accounts=False
        )
    )
    categories = CatalogService(db).categories()
    category = lambda name: next(c["id"] for c in categories if c["name"] == name)
    groups = AccountGroupService(db)
    family = groups.save(dict(name="分析家庭"))["id"]
    mine = groups.save(dict(name="成员甲", parent_id=family))["id"]
    other = groups.save(dict(name="成员乙", parent_id=family))["id"]
    groups.assign(mine, [5])
    groups.assign(other, [6])
    AccountService(db).opening(5, dict(amount="5000", occurred_at="2026-08-01"))
    transactions = TransactionService(db)

    def post(amount, when, kind="EXPENSE", account=5, name="日常用餐", **kwargs):
        return transactions.post(
            dict(
                kind=kind,
                amount=amount,
                occurred_at=when,
                account_id=account,
                category_id=category(name),
                idempotency_key=str(uuid.uuid4()),
                **kwargs
            )
        )["id"]

    post("12", "2026-09-01")
    post("23", "2026-09-03", name="买菜")
    rent = post("500", "2026-09-03", name="住房")
    post("1000", "2026-09-01", "INCOME", name="工资")
    post("250", "2026-10-01", "INCOME", account=6, name="红包收入")
    post("2000", "2026-09-02", "TRANSFER", to_account_id=6)
    revoked = post("500", "2026-09-04")
    transactions.reverse(revoked)
    post(
        "70",
        "2026-09-03",
        items=[
            dict(amount="20", category_id=category("买菜")),
            dict(amount="50", category_id=category("日用品")),
        ],
    )
    return db, dict(
        family=family, mine=mine, other=other, food=category("餐饮"), rent=rent
    )


def test_analysis_matches_reports_and_excludes_non_cashflow(ledger):
    db, ids = ledger
    result = FinancialAnalysisService(db).analyze(large_amount="500")
    assert (result["income"], result["expense"], result["net"], result["count"]) == (
        125000,
        60500,
        64500,
        6,
    )
    summary = ReportService(db).summary()
    assert all(result[k] == summary[k] for k in ("income", "expense", "net"))
    assert sum(c["amount"] for c in result["categories"]["income"]) == result["income"]
    assert (
        sum(c["amount"] for c in result["categories"]["expense"]) == result["expense"]
    )
    assert (
        next(c for c in result["categories"]["expense"] if c["name"] == "餐饮")[
            "amount"
        ]
        == 5500
    )
    assert result["large_count"] == 2
    assert [r["amount"] for r in result["large_transactions"]] == [100000, 50000]
    assert result["large_share"] == 2 / 6
    assert len(result["trend"]) == 31
    assert result["trend"][1] == dict(period="2026-09-02", income=0, expense=0, net=0)


def test_parent_filter_split_amount_and_daily_monthly_conservation(ledger):
    db, ids = ledger
    service = FinancialAnalysisService(db)
    filtered = service.analyze(
        dict(category_id=ids["food"]), level=2, large_amount="25"
    )
    assert filtered["expense"] == 5500 and filtered["count"] == 3
    assert (
        filtered["large_count"] == 0
    )  # Split's whole 70 does not override selected 20.
    assert {c["name"]: c["amount"] for c in filtered["categories"]["expense"]} == {
        "餐饮 / 日常用餐": 1200,
        "餐饮 / 买菜": 4300,
    }
    bounded = service.analyze(dict(start="2026-09-02", end="2026-09-05"))
    assert bounded["income"] == 0 and bounded["expense"] == 59300
    assert len(bounded["trend"]) == 4
    monthly = service.analyze(grain="month")
    assert [r["period"] for r in monthly["trend"]] == ["2026-09", "2026-10"]
    assert sum(r["income"] for r in monthly["trend"]) == monthly["income"]
    assert sum(r["expense"] for r in monthly["trend"]) == monthly["expense"]


def test_group_and_merge_analysis_never_duplicate_transactions(ledger):
    db, ids = ledger
    service = FinancialAnalysisService(db)
    family = service.analyze(dict(group_id=ids["family"]))
    mine = service.analyze(dict(group_id=ids["mine"]))
    other = service.analyze(dict(group_id=ids["other"]))
    assert mine["income"] + other["income"] == family["income"]
    assert mine["expense"] + other["expense"] == family["expense"]
    AccountMergeService(db).merge(dict(source_id=6, target_id=5))
    merged = service.analyze(dict(group_id=ids["mine"]))
    assert all(
        merged[key] == family[key] for key in ("income", "expense", "net", "count")
    )


def test_exact_category_drilldown_matches_parent_direct_amount_and_split(ledger):
    db, ids = ledger
    categories = CatalogService(db).categories()
    grocery = next(row["id"] for row in categories if row["name"] == "买菜")
    tx = TransactionService(db)
    direct = tx.post(
        dict(
            kind="EXPENSE",
            account_id=5,
            category_id=ids["food"],
            amount="9",
            occurred_at="2026-09-03",
            idempotency_key="direct-parent-detail",
        )
    )["id"]
    split = tx.post(
        dict(
            kind="EXPENSE",
            account_id=5,
            amount="20",
            occurred_at="2026-09-03",
            idempotency_key="direct-parent-split-detail",
            items=[
                dict(category_id=ids["food"], amount="7"),
                dict(category_id=grocery, amount="13"),
            ],
        )
    )["id"]
    service = FinancialAnalysisService(db)
    parent = service.analyze(dict(category_id=ids["food"]), level=2)
    displayed = next(
        row for row in parent["categories"]["expense"] if row["id"] == ids["food"]
    )
    assert displayed["amount"] == 1600
    for exact in (True, "true", "1"):
        detail = service.analyze(
            dict(category_id=ids["food"], exact_category=exact), level=2
        )
        assert detail["expense"] == displayed["amount"]
        assert {row["id"]: row["amount"] for row in detail["transactions"]} == {
            direct: 900,
            split: 700,
        }
    assert (
        service.analyze(dict(category_id=ids["food"], exact_category="false"))[
            "expense"
        ]
        == parent["expense"]
    )
    assert ReportService(db).integrity()["ok"]


def test_refund_adjustments_are_signed_not_another_expense(ledger):
    db, ids = ledger
    TransactionService(db).post(
        dict(
            kind="REFUND",
            related_id=ids["rent"],
            account_id=5,
            amount="50",
            occurred_at="2026-09-05",
            idempotency_key="refund-test",
        )
    )
    result = FinancialAnalysisService(db).analyze()
    assert result["expense"] == 55500 and result["refund_count"] == 1
    assert sum(c["amount"] for c in result["categories"]["expense"]) == 55500
    assert any(
        c["amount"] == -5000 and c["share"] == 0
        for c in result["categories"]["expense"]
    )
    assert result["trend"][4]["expense"] == -5000


def test_empty_and_invalid_analysis_inputs(tmp_path):
    app = LedgerApplication(tmp_path / "api.db")
    with TestClient(app.app) as client:
        response = client.get("/api/reports/analysis").json()
        assert response["income"] == response["expense"] == response["count"] == 0
        assert response["trend"] == response["large_transactions"] == []
        assert response["categories"] == dict(income=[], expense=[])
        for params in (
            dict(grain="hour"),
            dict(level=3),
            dict(large_amount="-1"),
            dict(large_amount="0.001"),
            dict(group_id=999999),
        ):
            assert client.get("/api/reports/analysis", params=params).status_code == 400
