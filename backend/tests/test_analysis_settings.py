from sqlalchemy import text
import pytest
from fastapi.testclient import TestClient
from app.database import Database
from app.domain import DomainError, Clock
from app.analysis_settings import AnalysisSettingsService
from app.single_account_analysis import SingleAccountAnalysisService
from app.income_analysis import IncomeAnalysisService
from app.expense_analysis import ExpenseAnalysisService
from app.overview import OverviewService
from app.account_config import AccountMergeService
from app.services import (
    AccountService,
    CatalogService,
    TransactionService,
    ReportService,
)
from app.securities import SecuritiesValuationService
from app.main import LedgerApplication


def payload(config, **patch):
    return {
        **{
            key: config[key]
            for key in (
                "revision",
                "exclude_investment_accounts",
                "income_excluded_account_ids",
                "expense_excluded_account_ids",
                "single_account_ids",
            )
        },
        **patch,
    }


@pytest.fixture
def configured_ledger(tmp_path, monkeypatch):
    monkeypatch.setattr(Clock, "now", staticmethod(lambda: "2026-10-03 12:00:00"))
    db = Database(tmp_path / "db")
    db.initialize()
    accounts = AccountService(db)
    for key in (5, 6):
        row = next(a for a in accounts.list() if a["id"] == key)
        accounts.save({**row, "kind": "银行卡"}, key)
    wealth = accounts.save(dict(name="分析证券", kind="证券", role="ASSET"))["id"]
    accounts.opening(5, dict(amount="1000", occurred_at="2026-09-28"))
    accounts.opening(6, dict(amount="500", occurred_at="2026-09-28"))
    values = SecuritiesValuationService(db)
    values.update(
        wealth,
        dict(actual="100", occurred_at="2026-09-28", idempotency_key="initial-value"),
    )
    cats = CatalogService(db).categories()
    cat = lambda name: next(c["id"] for c in cats if c["name"] == name)
    tx = TransactionService(db)

    def post(kind, amount, key=5, day="2026-10-01", **kw):
        return tx.post(
            dict(
                kind=kind,
                amount=amount,
                account_id=key,
                category_id=cat("工资" if kind == "INCOME" else "买菜"),
                occurred_at=day,
                idempotency_key=kind + amount + str(key) + day,
                **kw
            )
        )["id"]

    post("INCOME", "200")
    original = post("EXPENSE", "50")
    post("REFUND", "10", related_id=original)
    post("TRANSFER", "300", to_account_id=wealth)
    post("TRANSFER", "20", key=6, to_account_id=5)
    post("INCOME", "40", key=6)
    cancelled = post("EXPENSE", "99")
    tx.reverse(cancelled)
    values.update(
        wealth, dict(actual="415", occurred_at="2026-10-03", idempotency_key="gain")
    )
    return db, dict(wealth=wealth)


def test_saved_scopes_persist_and_overview_is_independent(configured_ledger):
    db, ids = configured_ledger
    settings = AnalysisSettingsService(db)
    defaults = settings.get()
    assert defaults["revision"] == 0 and defaults["single_account_ids"] == []
    assert ids["wealth"] in defaults["effective_income_excluded_account_ids"]
    snapshot = OverviewService(db).snapshot("2026-10-03")["household"]
    saved = settings.save(
        payload(
            defaults,
            income_excluded_account_ids=[5],
            expense_excluded_account_ids=[6],
            exclude_single_accounts=False,
            single_account_ids=[5, ids["wealth"]],
        )
    )
    restored = AnalysisSettingsService(Database(db.path)).get()
    assert restored == saved
    assert IncomeAnalysisService(db).analyze()["income"] == 4000
    assert ExpenseAnalysisService(db).analyze()["expense"] == 4000
    assert OverviewService(db).snapshot("2026-10-03")["household"] == snapshot
    # Default follows newly added wealth accounts, without rewriting the preferences.
    other = AccountService(db).save(dict(name="新增理财", role="ASSET", kind="理财"))[
        "id"
    ]
    assert other in settings.get()["effective_expense_excluded_account_ids"]
    saved = settings.save(
        payload(
            settings.get(),
            exclude_investment_accounts=False,
            income_excluded_account_ids=[],
            expense_excluded_account_ids=[],
        )
    )
    assert saved["effective_income_excluded_account_ids"] == []
    assert IncomeAnalysisService(db).analyze()["income"] == 25500
    with pytest.raises(DomainError, match="配置已被修改"):
        settings.save(payload(defaults))
    assert ReportService(db).integrity()["ok"]


def test_single_account_picker_places_followed_accounts_before_excluded(configured_ledger):
    db, ids = configured_ledger
    settings = AnalysisSettingsService(db)
    settings.save(
        payload(
            settings.get(),
            single_account_ids=[ids["wealth"], 6],
            single_excluded_account_ids=[5, 6],
        )
    )
    service = SingleAccountAnalysisService(db)
    result = service.analyze("2026-10-01", "2026-10-03")
    assert [row["id"] for row in result["accounts"]] == [6, ids["wealth"], 5]
    assert [row["is_followed"] for row in result["accounts"]] == [True, True, False]
    assert result["configured_account_ids"] == sorted([5, 6, ids["wealth"]])
    assert len({row["id"] for row in result["accounts"]}) == 3
    assert service.analyze("2026-10-01", "2026-10-03", 5)["accounts"][0]["is_followed"] is False
    settings.save(
        payload(
            settings.get(),
            single_account_ids=[5],
            single_excluded_account_ids=[6, ids["wealth"]],
        )
    )
    refreshed = service.analyze("2026-10-01", "2026-10-03")["accounts"]
    assert [row["id"] for row in refreshed] == [5, 6, ids["wealth"]]
    assert [row["is_followed"] for row in refreshed] == [True, False, False]


def test_followed_metadata_refreshes_all_account_choice_sources(configured_ledger):
    from app.report_scope import ReportAccountScope

    db, ids = configured_ledger
    service = AccountService(db)
    before = service.list()
    assert not any(row["is_followed"] for row in before)
    settings = AnalysisSettingsService(db)
    for selected in ([6, ids["wealth"]], [5], []):
        settings.save(payload(settings.get(), single_account_ids=selected))
        accounts = service.list()
        assert [row["id"] for row in accounts] == [row["id"] for row in before]
        assert {row["id"] for row in accounts if row["is_followed"]} == set(selected)
        assert [row["balance"] for row in accounts] == [row["balance"] for row in before]
        with db.read() as session:
            assert ReportAccountScope(session, {}).projection()["followed_account_ids"] == selected


def test_configured_single_accounts_reconcile_transfers_profit_and_refunds(
    configured_ledger,
):
    db, ids = configured_ledger
    settings = AnalysisSettingsService(db)
    settings.save(
        payload(
            settings.get(),
            income_excluded_account_ids=[5],
            expense_excluded_account_ids=[5],
            single_account_ids=[5, 6, ids["wealth"]],
        )
    )
    result = SingleAccountAnalysisService(db).analyze("2026-10-01", "2026-10-03")
    rows = {r["id"]: r for r in result["accounts"]}
    bank = rows[5]
    assert (bank["opening_balance"], bank["ending_balance"], bank["change"]) == (
        100000,
        88000,
        -12000,
    )
    assert (bank["income"], bank["expense"], bank["refunds"], bank["net"]) == (
        20000,
        5000,
        1000,
        16000,
    )
    assert (bank["transfer_in"], bank["transfer_out"], bank["valuation_profit"]) == (
        2000,
        30000,
        0,
    )
    wealth = rows[ids["wealth"]]
    assert (
        wealth["opening_balance"],
        wealth["ending_balance"],
        wealth["income"],
        wealth["transfer_in"],
        wealth["valuation_profit"],
    ) == (10000, 41500, 0, 30000, 1500)
    assert all(r["reconciled"] for r in rows.values())
    for r in rows.values():
        assert sum(t["account_change"] for t in r["transactions"]) == r["change"]
        assert r["trend"][-1]["balance"] == r["ending_balance"]
    # When baseline is inside the period, it is an opening adjustment, not profit.
    wider = SingleAccountAnalysisService(db).analyze(
        "2026-09-28", "2026-10-03", ids["wealth"]
    )["accounts"][0]
    assert wider["valuation_profit"] == 1500 and wider["adjustments"] == 10000
    assert wider["reconciled"]
    # Not automatically affected by the family income/expense exclusion lists.
    assert bank["income"] > 0 and bank["expense"] > 0
    assert bank["counterparties"]["count"] == 5
    with pytest.raises(DomainError, match="先在分析配置"):
        SingleAccountAnalysisService(db).analyze(account_id=7)


def test_merge_configuration_deduplicates_and_removing_list_preserves_entries(
    configured_ledger,
):
    db, ids = configured_ledger
    settings = AnalysisSettingsService(db)
    settings.save(
        payload(
            settings.get(), single_account_ids=[5, 6], income_excluded_account_ids=[6]
        )
    )
    AccountMergeService(db).merge(dict(source_id=6, target_id=5))
    config = settings.get()
    assert config["single_account_ids"] == [5]
    assert 5 in config["effective_income_excluded_account_ids"]
    result = SingleAccountAnalysisService(db).analyze("2026-10-01", "2026-10-03")[
        "accounts"
    ][0]
    assert result["reconciled"]
    assert result["transfer_in"] == 0  # Transfer between merged sources cancels out.
    assert result["ending_balance"] == 140000
    assert result["opening_balance"] == 150000
    with db.read() as session:
        before = [
            tuple(row)
            for row in session.execute(
                text("SELECT id,account_id,amount FROM entries ORDER BY id")
            )
        ]
    settings.save(
        payload(config, single_account_ids=[], single_excluded_account_ids=[])
    )
    assert SingleAccountAnalysisService(db).analyze()["accounts"] == []
    with db.read() as session:
        assert before == [
            tuple(row)
            for row in session.execute(
                text("SELECT id,account_id,amount FROM entries ORDER BY id")
            )
        ]


def test_category_drilldown_exposes_exact_transaction_membership(configured_ledger):
    db, _ = configured_ledger
    settings = AnalysisSettingsService(db)
    settings.save(payload(settings.get(), single_account_ids=[5]))
    categories = CatalogService(db).categories()
    category = lambda name: next(c["id"] for c in categories if c["name"] == name)
    split_id = TransactionService(db).post(
        dict(
            kind="EXPENSE",
            account_id=5,
            amount="75",
            occurred_at="2026-10-02",
            idempotency_key="linked-split-detail",
            items=[
                dict(category_id=category("买菜"), amount="30"),
                dict(category_id=category("日常用餐"), amount="25"),
                dict(category_id=category("日用品"), amount="20"),
            ],
        )
    )["id"]
    account = SingleAccountAnalysisService(db).analyze("2026-10-01", "2026-10-03")[
        "accounts"
    ][0]
    transactions = {row["id"]: row for row in account["transactions"]}
    food = next(row for row in account["categories"] if row["id"] == category("餐饮"))
    shopping = next(
        row for row in account["categories"] if row["id"] == category("购物")
    )
    assert (food["amount"], food["count"]) == (10500, 2)
    assert food["transaction_ids"].count(split_id) == 1
    assert shopping["transaction_ids"] == [split_id]
    assert shopping["amount"] == 2000
    for row in account["categories"]:
        assert row["transaction_ids"] == sorted(set(row["transaction_ids"]))
        assert row["count"] == len(row["transaction_ids"])
        assert all(
            transactions[key]["kind"] == row["kind"] for key in row["transaction_ids"]
        )
    assert account["reconciled"]
    assert ReportService(db).integrity()["ok"]


def test_settings_api_validation_and_backup(tmp_path):
    app = LedgerApplication(tmp_path / "api.db")
    headers = {"X-Ledger-Client": "local-web"}
    with TestClient(app.app) as client:
        config = client.get("/api/analysis-settings").json()
        assert client.get("/api/reports/single-accounts").json()["accounts"] == []
        for patch in (
            dict(single_account_ids=[1]),
            dict(single_account_ids=[999999]),
            dict(single_account_ids=[True]),
            dict(single_account_ids=[-1]),
            dict(single_account_ids=["5"]),
            dict(exclude_investment_accounts="yes"),
            dict(extra=True),
        ):
            assert (
                client.put(
                    "/api/analysis-settings",
                    json=payload(config, **patch),
                    headers=headers,
                ).status_code
                == 400
            )
        saved = client.put(
            "/api/analysis-settings",
            json=payload(config, single_account_ids=[5]),
            headers=headers,
        )
        assert saved.status_code == 200
        assert (
            client.put(
                "/api/analysis-settings", json=payload(config), headers=headers
            ).status_code
            == 400
        )
        assert (
            client.get(
                "/api/reports/single-accounts", params={"start": "bad"}
            ).status_code
            == 400
        )
        assert (
            client.get(
                "/api/reports/single-accounts", params={"account_id": 6}
            ).status_code
            == 400
        )
        copy = tmp_path / "backup.db"
        app.db.backup(copy)
        assert AnalysisSettingsService(Database(copy)).get()["single_account_ids"] == [
            5
        ]
        from manage import BackupManager

        restored = tmp_path / "restored.db"
        BackupManager().restore(copy, restored)
        assert AnalysisSettingsService(Database(restored)).get()[
            "single_account_ids"
        ] == [5]


def test_liability_account_repayment_is_transfer_not_income(configured_ledger):
    db, ids = configured_ledger
    account = AccountService(db).save(
        dict(name="测试贷款", role="LIABILITY", kind="贷款")
    )["id"]
    AccountService(db).opening(account, dict(amount="-500", occurred_at="2026-09-28"))
    TransactionService(db).post(
        dict(
            kind="TRANSFER",
            account_id=5,
            to_account_id=account,
            amount="100",
            occurred_at="2026-10-02",
            idempotency_key="repay-test",
        )
    )
    settings = AnalysisSettingsService(db)
    settings.save(payload(settings.get(), single_account_ids=[account]))
    result = SingleAccountAnalysisService(db).analyze("2026-10-01", "2026-10-03")[
        "accounts"
    ][0]
    assert result["opening_balance"] == -50000 and result["ending_balance"] == -40000
    assert (
        result["transfer_in"] == 10000
        and result["income"] == 0
        and result["reconciled"]
    )


def test_per_account_modes_control_analysis_and_keep_balances(configured_ledger):
    db, ids = configured_ledger
    settings = AnalysisSettingsService(db)
    modes = {"5": "cashflow", "6": "counterparties", str(ids["wealth"]): "both"}
    saved = settings.save(
        payload(
            settings.get(),
            single_account_ids=[5, 6, ids["wealth"]],
            single_account_modes=modes,
        )
    )
    assert saved["single_account_modes"] == modes
    result = SingleAccountAnalysisService(db).analyze("2026-10-01", "2026-10-03")
    accounts = {r["id"]: r for r in result["accounts"]}
    assert (
        accounts[5]["analysis_mode"] == "cashflow"
        and accounts[5]["counterparties"] is None
    )
    assert accounts[5]["categories"]
    assert (
        accounts[6]["analysis_mode"] == "counterparties"
        and accounts[6]["categories"] == []
    )
    assert accounts[6]["counterparties"]["count"] > 0
    assert accounts[ids["wealth"]]["analysis_mode"] == "both"
    assert accounts[ids["wealth"]]["counterparties"] is not None
    for row in accounts.values():
        assert row["reconciled"]
        assert sum(day["income"] for day in row["trend"]) == row["income"]
        assert (
            sum(day["expense"] for day in row["trend"])
            == row["expense"] - row["refunds"]
        )
    # Older clients can change other settings without clearing selected modes.
    assert (
        settings.save(payload(settings.get(), income_excluded_account_ids=[5]))[
            "single_account_modes"
        ]
        == modes
    )
    AccountMergeService(db).merge(dict(source_id=6, target_id=5))
    assert settings.get()["single_account_modes"]["5"] == "both"


def test_analysis_mode_validation_and_legacy_default(tmp_path):
    app = LedgerApplication(tmp_path / "modes.db")
    headers = {"X-Ledger-Client": "local-web"}
    with TestClient(app.app) as client:
        config = client.get("/api/analysis-settings").json()
        for modes in (
            {"5": "unknown"},
            {"6": "cashflow"},
            {"05": "cashflow"},
            {"abc": "both"},
            [],
            {"5": True},
        ):
            response = client.put(
                "/api/analysis-settings",
                json=payload(
                    config, single_account_ids=[5], single_account_modes=modes
                ),
                headers=headers,
            )
            assert response.status_code == 400, (modes, response.text)
        saved = client.put(
            "/api/analysis-settings",
            json=payload(config, single_account_ids=[5]),
            headers=headers,
        ).json()
        assert saved["single_account_modes"] == {"5": "both"}
        result = client.get("/api/reports/single-accounts").json()
        assert result["accounts"][0]["analysis_mode"] == "both"
