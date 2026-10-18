"""Common periods, independent attention/exclusion lists and transfer curves."""

import json
from fastapi.testclient import TestClient
from app.main import LedgerApplication
from app.analysis_settings import AnalysisSettingsService
from app.single_account_analysis import SingleAccountAnalysisService
from app.financial_analysis import FinancialAnalysisService
from app.models import AnalysisSettings
from test_analysis_settings import configured_ledger


def configure(db, **patch):
    config = AnalysisSettingsService(db).get()
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
    return AnalysisSettingsService(db).save(dict(values, **patch))


def test_attention_and_exclusions_are_independent_and_overview_accounts_are_linkable(
    configured_ledger,
):
    db, ids = configured_ledger
    config = configure(
        db,
        single_account_ids=[5, ids["wealth"]],
        single_excluded_account_ids=[6],
        exclude_investment_accounts=False,
    )
    assert config["single_excluded_account_ids"] == [6]
    result = FinancialAnalysisService(db).analyze()
    assert result["account_scope"]["excluded_account_ids"] == [6]
    assert any(
        5 in [entry["account_id"] for entry in row["entries"]]
        for row in result["transactions"]
    )
    report = SingleAccountAnalysisService(db).analyze("2026-10-01", "2026-10-03")
    assert set(report["configured_account_ids"]) == {5, 6, ids["wealth"]}
    assert {row["id"] for row in report["accounts"]} == {5, 6, ids["wealth"]}
    direct = SingleAccountAnalysisService(db).analyze(
        "2026-10-01", "2026-10-03", ids["wealth"]
    )
    assert direct["accounts"][0]["id"] == ids["wealth"]
    for account in report["accounts"]:
        assert (
            sum(row["transfer_in"] for row in account["trend"])
            == account["transfer_in"]
        )
        assert (
            sum(row["transfer_out"] for row in account["trend"])
            == account["transfer_out"]
        )
        assert all(
            row["transfer_in"] >= 0 and row["transfer_out"] >= 0
            for row in account["trend"]
        )
        assert sum(row["income"] for row in account["trend"]) == account["income"]
        assert (
            account["income"]
            - account["expense"]
            + account["refunds"]
            + account["transfer_net"]
            + account["valuation_profit"]
            + account["adjustments"]
            == account["change"]
        )
    configure(db, single_account_ids=[5, 6, ids["wealth"]])
    assert AnalysisSettingsService(db).get()["single_excluded_account_ids"] == [
        6
    ], "Adding attention never broadens exclusions"


def test_old_single_account_mask_is_read_without_rewriting_saved_data(
    configured_ledger,
):
    db, _ = configured_ledger
    config = configure(db, single_account_ids=[5, 6], single_excluded_account_ids=[6])
    with db.write() as session:
        row = session.get(AnalysisSettings, 1)
        data = json.loads(row.content)
        del data["single_excluded_account_ids"]
        row.content = json.dumps(data)
        before = row.content
    restored = AnalysisSettingsService(db).get()
    assert restored["single_excluded_account_ids"] == [5, 6]
    assert restored["revision"] == config["revision"]
    with db.read() as session:
        assert session.get(AnalysisSettings, 1).content == before


def test_period_presets_apply_to_every_range_endpoint_and_keep_narrow_drilldowns(
    configured_ledger,
):
    db, _ = configured_ledger
    configure(db, single_account_ids=[5])
    with TestClient(LedgerApplication(db.path).app) as client:
        period = client.get("/api/reports/period").json()
        assert (period["start"], period["end"], period["latest_data_date"]) == (
            "2026-10-01",
            "2026-10-31",
            "2026-10-03",
        )
        for preset in ("1m", "3m", "6m", "1y"):
            resolved = client.get(
                "/api/reports/period", params={"period": preset}
            ).json()
            assert resolved["start"] < resolved["end"] == "2026-10-03"
        for endpoint in (
            "analysis",
            "income",
            "expenses",
            "fund-flows",
            "fund-boundaries",
            "investments",
            "single-accounts",
            "counterparties",
        ):
            extra = {"account_id": 5} if endpoint == "counterparties" else {}
            preset = client.get(
                f"/api/reports/{endpoint}", params=dict(extra, period="latest_month")
            )
            explicit = client.get(
                f"/api/reports/{endpoint}",
                params=dict(extra, start="2026-10-01", end="2026-10-31"),
            )
            assert preset.status_code == explicit.status_code == 200, (
                endpoint,
                preset.text,
            )
            assert preset.json() == explicit.json(), endpoint
        for endpoint in ("/api/transactions", "/api/bills", "/api/reports/summary"):
            assert (
                client.get(endpoint, params={"period": "latest_month"}).json()
                == client.get(
                    endpoint, params={"start": "2026-10-01", "end": "2026-10-31"}
                ).json()
            )
        narrowed = client.get(
            "/api/reports/analysis",
            params=dict(period="latest_month", start="2026-10-02", end="2026-10-02"),
        ).json()
        assert all(
            row["occurred_at"].startswith("2026-10-02")
            for row in narrowed["transactions"]
        )
        assert (
            client.get(
                "/api/reports/period",
                params=dict(period="custom", start="2026-09-28", end="2026-10-02"),
            ).json()["start"]
            == "2026-09-28"
        )
        for params in (
            {"period": "bad"},
            {"period": "custom"},
            {"period": "bad", "start": "2026-10-01", "end": "2026-10-03"},
        ):
            assert client.get("/api/reports/analysis", params=params).status_code == 400
