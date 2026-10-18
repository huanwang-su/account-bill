import pytest
from fastapi.testclient import TestClient

from app.analysis_settings import AnalysisSettingsService
from app.balance_sheet import BalanceSheetService
from app.domain import DomainError
from app.expense_analysis import ExpenseAnalysisService
from app.main import LedgerApplication
from app.overview import OverviewService
from app.services import AccountService
from test_household_expenses import household


def test_overview_day_and_cumulative_details_match_drawn_amounts(household):
    db, _ = household
    service = OverviewService(db)
    snapshot = service.snapshot("2026-10-03")
    cumulative = 0
    all_ids = set()
    for point in snapshot["household"]["trend"]:
        details = service.details("expense", "2026-10-03", point["day"])
        assert details["start"] == details["end"] == point["day"]
        assert details["amount"] == point["expense"]
        assert details["amount"] == sum(
            row["amount"] for row in details["transactions"]
        )
        assert all(
            row["occurred_at"].startswith(point["day"])
            for row in details["transactions"]
        )
        assert all(
            row["kind"] in ("EXPENSE", "REFUND") for row in details["transactions"]
        )
        assert not all_ids.intersection(row["id"] for row in details["transactions"])
        all_ids.update(row["id"] for row in details["transactions"])
        cumulative += point["expense"]
        running = service.details("expense", "2026-10-03", point["day"], True)
        assert running["start"] == "2026-10-01"
        assert running["amount"] == cumulative
        assert all(
            "2026-10-01" <= row["occurred_at"][:10] <= point["day"]
            for row in running["transactions"]
        )
    assert cumulative == snapshot["household"]["expense"]
    assert any(
        row["amount"] < 0
        for row in service.details("expense", "2026-10-03", "2026-10-02")[
            "transactions"
        ]
    )


def test_overview_details_keep_own_scope_when_analysis_accounts_are_hidden(household):
    db, _ = household
    service = OverviewService(db)
    before = service.snapshot("2026-10-03")["household"]["expense"]
    AnalysisSettingsService(db).save(dict(revision=0, expense_excluded_account_ids=[5]))
    detail = service.details("expense", "2026-10-03", "2026-10-03", True)
    assert detail["amount"] == before
    assert (
        detail["amount"]
        != ExpenseAnalysisService(db).analyze(
            dict(start="2026-10-01", end="2026-10-03")
        )["expense"]
    )
    assert any(
        any(entry["account_id"] == 5 for entry in row["entries"])
        for row in detail["transactions"]
    )


def test_overview_group_details_use_direct_ownership_and_signed_components(household):
    db, ids = household
    accounts = AccountService(db)
    for name, amount, role in [
        ("直属银行", "50", "ASSET"),
        ("直属透支", "-10", "ASSET"),
        ("直属信用卡", "-40", "LIABILITY"),
    ]:
        key = accounts.save(
            dict(name=name, kind="银行卡", role=role, group_id=ids["family"])
        )["id"]
        accounts.opening(key, dict(amount=amount, occurred_at="2026-09-28"))
    service = OverviewService(db)
    snapshot = service.snapshot("2026-10-03")
    balance = BalanceSheetService(db).snapshot("2026-10-03")
    for group in snapshot["groups"]:
        for section, field in [
            ("assets", "asset_amount"),
            ("liabilities", "liability_amount"),
        ]:
            details = service.details(section, "2026-10-03", group_id=group["id"] or 0)
            assert details["amount"] == group[section]
            assert all(row["group_id"] == group["id"] for row in details["accounts"])
            assert details["amount"] == sum(
                row["analysis_amount"] for row in details["accounts"]
            )
            assert {row["id"] for row in details["accounts"]} == {
                row["id"]
                for row in balance["accounts"]
                if row["group_id"] == group["id"] and row[field] != 0
            }
    assert (
        service.details("assets", "2026-10-03", group_id=ids["family"])["amount"]
        == 4000
    )
    assert (
        service.details("liabilities", "2026-10-03", group_id=ids["family"])["amount"]
        == 4000
    )
    assert service.details("assets", "2026-10-03", group_id=0)["accounts"] == []


@pytest.mark.parametrize(
    "params",
    [
        dict(section="invalid"),
        dict(section="expense"),
        dict(section="expense", day="2026-09-30"),
        dict(section="expense", day="2026-10-04"),
        dict(section="expense", day="bad"),
        dict(section="assets"),
        dict(section="assets", group_id=-1),
        dict(section="liabilities", group_id=99999),
    ],
)
def test_invalid_overview_detail_scope_is_rejected(household, params):
    db, _ = household
    with pytest.raises(DomainError):
        OverviewService(db).details(as_of="2026-10-03", **params)


def test_overview_detail_http_route_is_read_only(tmp_path):
    app = LedgerApplication(tmp_path / "api.db")
    with TestClient(app.app) as client:
        params = dict(section="expense", as_of="2026-10-03", day="2026-10-02")
        response = client.get("/api/reports/overview/details", params=params)
        assert response.status_code == 200
        assert response.json()["transactions"] == []
        assert response.json()["amount"] == 0
        assert (
            client.get(
                "/api/reports/overview/details",
                params=dict(section="assets", as_of="2026-10-03", group_id=0),
            ).status_code
            == 200
        )
        assert (
            client.get(
                "/api/reports/overview/details",
                params=dict(section="expense", as_of="2026-10-03", day="2026-10-04"),
            ).status_code
            == 400
        )
