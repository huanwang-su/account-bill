"""Persisted defaults are shared while explicit, temporary overrides remain local."""

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text
from app.analysis_settings import AnalysisSettingsService
from app.financial_analysis import FinancialAnalysisService
from app.income_analysis import IncomeAnalysisService
from app.expense_analysis import ExpenseAnalysisService
from app.fund_flows import FundFlowService
from app.overview import OverviewService
from app.main import LedgerApplication
from app.domain import DomainError
from test_analysis_settings import configured_ledger
from test_fund_flows import flow_ledger


def save(db, **changes):
    service = AnalysisSettingsService(db)
    config = service.get()
    values = {
        key: value
        for key, value in config.items()
        if key
        not in (
            "updated_at",
            "effective_income_excluded_account_ids",
            "effective_expense_excluded_account_ids",
        )
    }
    return service.save(dict(values, **changes))


def test_thresholds_persist_reset_and_do_not_cross_income_expense(configured_ledger):
    db, _ = configured_ledger
    saved = save(
        db,
        large_income_threshold_minor=15000,
        large_expense_threshold_minor=4000,
        exclude_investment_accounts=False,
        exclude_single_accounts=False,
    )
    report = FinancialAnalysisService(db).analyze()
    assert (
        report["large_income_amount_minor"],
        report["large_expense_amount_minor"],
    ) == (15000, 4000)
    assert {row["id"] for row in report["large_transactions"]} == {
        row["id"]
        for row in report["transactions"]
        if row["amount"] >= (15000 if row["kind"] == "INCOME" else 4000)
    }
    assert IncomeAnalysisService(db).analyze()["large_amount_minor"] == 15000
    assert ExpenseAnalysisService(db).analyze()["large_amount_minor"] == 4000
    temporary = FinancialAnalysisService(db).analyze(large_income_amount="250.01")
    assert (
        temporary["large_income_amount_minor"],
        temporary["large_expense_amount_minor"],
    ) == (25001, 4000)
    assert (
        IncomeAnalysisService(db).analyze(large_amount="30")["large_amount_minor"]
        == 3000
    )
    assert (
        ExpenseAnalysisService(db).analyze(large_amount="25.10")["large_amount_minor"]
        == 2510
    )
    assert AnalysisSettingsService(db).get() == saved
    assert FinancialAnalysisService(db).analyze()["large_income_amount_minor"] == 15000
    # Older clients cannot silently discard new settings on an unrelated save.
    kept = AnalysisSettingsService(db).save(
        dict(revision=saved["revision"], single_account_ids=[5])
    )
    assert kept["large_income_threshold_minor"] == 15000
    assert kept["large_expense_threshold_minor"] == 4000
    assert kept["exclude_single_accounts"] is False
    client = TestClient(LedgerApplication(db.path).app)
    api = client.get("/api/reports/analysis").json()
    assert (api["large_income_amount_minor"], api["large_expense_amount_minor"]) == (
        15000,
        4000,
    )
    assert client.get("/api/reports/income").json()["large_amount_minor"] == 15000
    assert client.get("/api/reports/expenses").json()["large_amount_minor"] == 4000


def test_all_reports_use_saved_exclusion_defaults_and_explicit_off(configured_ledger):
    db, ids = configured_ledger
    save(
        db,
        single_account_ids=[5],
        single_excluded_account_ids=[5],
        exclude_investment_accounts=True,
        exclude_single_accounts=True,
    )
    expected = {5, ids["wealth"]}
    report = FinancialAnalysisService(db).analyze()
    assert set(report["account_scope"]["excluded_account_ids"]) == expected
    assert set(IncomeAnalysisService(db).analyze()["excluded_account_ids"]) == expected
    assert set(ExpenseAnalysisService(db).analyze()["excluded_account_ids"]) == expected
    assert expected.isdisjoint(
        row["id"] for row in report["account_movements"]["accounts"]
    )
    assert (
        set(report["account_movements"]["account_scope"]["excluded_account_ids"])
        == expected
    )
    assert expected.isdisjoint(FundFlowService(db).analyze()["scope_account_ids"])
    overview = OverviewService(db).snapshot(filters=dict(period="latest_month"))
    assert set(overview["account_scope"]["excluded_account_ids"]) == expected
    assert expected <= {
        row["id"] for row in overview["balance_sheet"]["accounts"]
    }, "Stock assets stay complete"
    explicit = dict(
        exclude_investment_accounts=False,
        exclude_single_accounts=False,
        excluded_account_ids="[]",
    )
    assert (
        FinancialAnalysisService(db).analyze(explicit)["account_scope"][
            "excluded_account_ids"
        ]
        == []
    )
    assert (
        FundFlowService(db).analyze(explicit)["account_scope"]["excluded_account_ids"]
        == []
    )
    save(db, exclude_investment_accounts=False, exclude_single_accounts=False)
    assert (
        FinancialAnalysisService(db).analyze()["account_scope"]["excluded_account_ids"]
        == []
    )
    assert IncomeAnalysisService(db).analyze()["excluded_account_ids"] == []
    assert ExpenseAnalysisService(db).analyze()["excluded_account_ids"] == []
    assert OverviewService(db).snapshot()["account_scope"]["excluded_account_ids"] == []


@pytest.mark.parametrize(
    "field,value",
    [
        ("large_income_threshold_minor", 0),
        ("large_expense_threshold_minor", -1),
        ("large_income_threshold_minor", 1.5),
        ("large_expense_threshold_minor", True),
        ("large_income_threshold_minor", 100000000000001),
        ("exclude_single_accounts", "false"),
        ("exclude_investment_accounts", 0),
    ],
)
def test_invalid_defaults_are_rejected_without_saving(configured_ledger, field, value):
    db, _ = configured_ledger
    before = AnalysisSettingsService(db).get()
    with pytest.raises(DomainError):
        save(db, **{field: value})
    assert AnalysisSettingsService(db).get() == before


def test_filtered_negative_position_reconciles_assets_and_debt(flow_ledger):
    db, ids = flow_ledger
    with db.read() as session:
        before = list(
            session.execute(
                text("SELECT id, account_id, amount FROM entries ORDER BY id")
            )
        )
    result = FinancialAnalysisService(db).analyze(
        dict(
            start="2026-10-01",
            end="2026-10-18",
            excluded_account_ids=f'[{ids["bank"]}, {ids["peer"]}, {ids["third"]}]',
        )
    )
    movement = result["account_movements"]
    totals = movement["totals"]
    assert totals["ending_balance"] < 0
    assert (
        totals["ending_assets"] - totals["ending_liabilities"]
        == totals["ending_balance"]
    )
    assert (
        totals["opening_balance"] + totals["opening_added"] + totals["operating_change"]
        == totals["ending_balance"]
    )
    assert movement["account_scope"]["excluded_account_ids"]
    assert totals["reconciled"]
    with db.read() as session:
        assert before == list(
            session.execute(
                text("SELECT id, account_id, amount FROM entries ORDER BY id")
            )
        )
