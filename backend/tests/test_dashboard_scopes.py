import json
import pytest
from app.analysis_settings import AnalysisSettingsService
from app.financial_analysis import FinancialAnalysisService
from app.fund_flows import FundFlowService
from app.fund_boundaries import FundBoundaryService
from app.overview import OverviewService
from app.overview_period import OverviewPeriod
from app.domain import DomainError
from test_fund_flows import flow_ledger, filters


def configure(db, **values):
    config = AnalysisSettingsService(db).get()
    allowed = {
        key: config[key]
        for key in (
            "revision",
            "exclude_investment_accounts",
            "income_excluded_account_ids",
            "expense_excluded_account_ids",
            "single_account_ids",
            "single_account_modes",
        )
    }
    return AnalysisSettingsService(db).save(dict(allowed, **values))


def test_shared_exclusions_cover_financial_balances_and_boundary_views(flow_ledger):
    db, ids = flow_ledger
    configure(db, single_account_ids=[ids["bank"]])
    request = dict(
        filters(ids),
        exclude_investment_accounts="true",
        exclude_single_accounts="true",
        excluded_account_ids=json.dumps([ids["credit"]]),
    )
    financial = FinancialAnalysisService(db).analyze(request)
    excluded = set(financial["account_scope"]["excluded_account_ids"])
    assert {ids["bank"], ids["wealth"], ids["credit"]} <= excluded
    assert all(
        not excluded.intersection(
            e["account_id"]
            for e in row["entries"]
            if e["role"] in ("ASSET", "LIABILITY")
        )
        for row in financial["transactions"]
    )
    assert not excluded.intersection(
        row["id"] for row in financial["account_movements"]["accounts"]
    )
    funds = FundFlowService(db).analyze(request)
    boundary = FundBoundaryService(db).analyze(request)
    assert not excluded.intersection(funds["scope_account_ids"])
    assert boundary["summary"]["account_ids"] == funds["scope_account_ids"]
    # Hidden accounts remain real counterparties across the visible scope boundary.
    assert any(row["transaction_id"] == ids["boundary"] for row in boundary["flows"])
    assert not any(row["group_id"] == ids["mine"] for row in boundary["account_scopes"])


def test_filters_can_be_switched_off_and_explicit_empty_is_not_default_exclusion(
    flow_ledger,
):
    db, ids = flow_ledger
    base = FinancialAnalysisService(db).analyze(filters(ids))
    explicit = FinancialAnalysisService(db).analyze(
        dict(
            filters(ids),
            exclude_investment_accounts="false",
            exclude_single_accounts="false",
            excluded_account_ids="[]",
        )
    )
    assert explicit["income"] == base["income"]
    assert explicit["expense"] == base["expense"]
    assert explicit["account_scope"]["excluded_account_ids"] == []
    assert any(
        row["id"] == ids["wealth"] for row in explicit["account_movements"]["accounts"]
    )


def test_dashboard_full_month_core_reports_and_independent_attention_accounts(
    flow_ledger,
):
    db, ids = flow_ledger
    configure(
        db,
        single_account_ids=[ids["peer"], ids["wealth"]],
        single_excluded_account_ids=[ids["bank"]],
    )
    request = dict(
        period="latest_month",
        exclude_investment_accounts="true",
        exclude_single_accounts="true",
        excluded_account_ids=json.dumps([ids["peer"]]),
    )
    data = OverviewService(db).snapshot(filters=request)
    assert (data["period"]["start"], data["period"]["end"]) == (
        "2026-10-01",
        "2026-10-31",
    )
    assert data["income_report"]["income"] == data["household"]["income"]
    assert (
        data["household"]["net"]
        == data["income_report"]["income"] - data["household"]["expense"]
    )
    assert data["assets"] == data["balance_sheet"]["assets"]
    assert data["liabilities"] == data["balance_sheet"]["liabilities"]
    assert data["investment_report"]["account_count"] > 0
    assert {row["id"] for row in data["single_accounts"]["accounts"]} == {
        ids["peer"],
        ids["wealth"],
    }
    assert set(data["single_accounts"]["configured_account_ids"]) == {
        ids["peer"],
        ids["wealth"],
    }
    assert {row["id"] for row in data["balance_sheet"]["accounts"]} >= {
        ids["bank"],
        ids["wealth"],
        ids["peer"],
    }
    for section in ("expense", "income", "investment"):
        detail = OverviewService(db).details(
            section,
            day="2026-10-31",
            cumulative=True,
            filters=dict(
                request, period="custom", start="2026-10-01", end="2026-10-31"
            ),
        )
        expected = (
            data["household"]["expense"]
            if section == "expense"
            else (
                data["income_report"]["income"]
                if section == "income"
                else data["investment_report"]["profit"]
            )
        )
        assert detail["amount"] == expected
        assert detail["amount"] == sum(row["amount"] for row in detail["transactions"])


def test_overview_and_single_analysis_share_attention_accounts(flow_ledger):
    db, ids = flow_ledger
    saved = configure(
        db,
        single_account_ids=[ids["peer"]],
        single_excluded_account_ids=[ids["bank"]],
    )
    assert "overview_account_ids" not in saved
    overview = OverviewService(db).snapshot(filters={"period": "latest_month"})
    assert [row["id"] for row in overview["single_accounts"]["accounts"]] == [
        ids["peer"]
    ]
    configure(db, single_account_ids=[], single_account_modes={})
    assert (
        OverviewService(db).snapshot(filters={"period": "latest_month"})[
            "single_accounts"
        ]["accounts"]
        == []
    )
    assert AnalysisSettingsService(db).get()["single_excluded_account_ids"] == [
        ids["bank"]
    ]


def test_overview_period_presets_follow_latest_data_and_validate_custom_ranges(
    flow_ledger,
):
    db, _ = flow_ledger
    latest = OverviewPeriod(db).projection()["latest_data_date"]
    for preset in ("1m", "3m", "6m", "1y"):
        result = OverviewPeriod(db, {"period": preset}).projection()
        assert result["end"] == latest
        assert result["start"] < result["end"]
    custom = OverviewPeriod(
        db, dict(period="custom", start="2026-09-28", end="2026-10-18")
    )
    assert custom.projection()["start"] == "2026-09-28"
    for request in [
        dict(period="bad"),
        dict(period="custom"),
        dict(period="custom", start="2026-10-20", end="2026-10-01"),
    ]:
        with pytest.raises(DomainError):
            OverviewPeriod(db, request)


@pytest.mark.parametrize(
    "extra",
    [
        {"exclude_single_accounts": "maybe"},
        {"exclude_investment_accounts": "maybe"},
        {"excluded_account_ids": "bad"},
        {"excluded_account_ids": "[true]"},
        {"excluded_account_ids": "[999999]"},
    ],
)
def test_invalid_account_filters_rejected(flow_ledger, extra):
    db, ids = flow_ledger
    for service in (
        FinancialAnalysisService(db),
        FundFlowService(db),
        FundBoundaryService(db),
    ):
        with pytest.raises(DomainError):
            service.analyze(dict(filters(ids), **extra))
