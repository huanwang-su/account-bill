import uuid
import pytest
from fastapi.testclient import TestClient
from app.database import Database
from app.balance_sheet import BalanceSheetService
from app.account_config import AccountGroupService, AccountMergeService
from app.services import (
    AccountService,
    TransactionService,
    ReportService,
    CatalogService,
)
from app.main import LedgerApplication
from app.models import Entry, Transaction


@pytest.fixture
def ledger(tmp_path):
    db = Database(tmp_path / "db")
    db.initialize()
    groups = AccountGroupService(db)
    family = groups.save(dict(name="家庭"))["id"]
    mine = groups.save(dict(name="成员甲", parent_id=family))["id"]
    spouse = groups.save(dict(name="成员乙", parent_id=family))["id"]
    accounts = AccountService(db)

    def account(name, group, amount, role="ASSET"):
        key = accounts.save(dict(name=name, group_id=group, role=role))["id"]
        if amount is not None:
            accounts.opening(key, dict(amount=amount, occurred_at="2026-09-01"))
        return key

    bank = account("主账户", mine, "1000")
    merged = account("合并来源", mine, "200")
    spouse_bank = account("另一成员账户", spouse, "400")
    credit = account("信用卡", mine, "-300", "LIABILITY")
    account("信用卡预付款", spouse, "50", "LIABILITY")
    external = account("商户", mine, "9999", "EXTERNAL")
    unknown = account("未设置期初", mine, None)
    AccountMergeService(db).merge(dict(source_id=merged, target_id=bank))
    accounts.save(
        dict(name="信用卡", role="LIABILITY", group_id=mine, active=False), credit
    )
    service = TransactionService(db)
    income_category = next(
        c["id"] for c in CatalogService(db).categories() if c["name"] == "工资"
    )

    def post(key, amount, when, kind="EXPENSE", **kwargs):
        return service.post(
            dict(
                account_id=key,
                amount=amount,
                occurred_at=when,
                kind=kind,
                category_id=1 if kind == "EXPENSE" else income_category,
                idempotency_key=str(uuid.uuid4()),
                **kwargs
            )
        )["id"]

    post(bank, "100", "2026-09-10 23:59:59")
    post(bank, "50", "2026-09-10", "TRANSFER", to_account_id=spouse_bank)
    revoked = post(bank, "30", "2026-09-09")
    service.reverse(revoked)
    post(unknown, "20", "2026-09-10")
    post(bank, "200", "2026-09-20", "INCOME")
    return db, dict(
        family=family,
        mine=mine,
        spouse=spouse,
        bank=bank,
        spouse_bank=spouse_bank,
        credit=credit,
        merged=merged,
        external=external,
        unknown=unknown,
    )


def test_position_cutoff_signs_reversal_and_no_double_count(ledger):
    db, ids = ledger
    sheet = BalanceSheetService(db).snapshot("2026-09-10", ids["family"])
    assert sheet["assets"] == 148000
    assert sheet["liabilities"] == 25000
    assert sheet["net_assets"] == 123000
    rows = {a["id"]: a for a in sheet["accounts"]}
    assert rows[ids["bank"]]["amount"] == 105000
    assert rows[ids["bank"]]["merged_source_count"] == 1
    assert rows[ids["credit"]]["amount"] == 30000
    assert not rows[ids["credit"]]["active"]
    assert rows[ids["unknown"]]["amount"] == -2000
    assert sheet["missing_opening_ids"] == [ids["unknown"]]
    assert ids["merged"] not in rows and ids["external"] not in rows
    assert all(a["role"] in ("ASSET", "LIABILITY") for a in rows.values())
    assert (
        BalanceSheetService(db).snapshot("2026-09-09", ids["family"])["assets"]
        == 160000
    )
    before = BalanceSheetService(db).snapshot("2026-08-31", ids["family"])
    assert before["assets"] == before["liabilities"] == 0
    assert set(before["missing_opening_ids"]) == set(rows)


def test_family_is_sum_of_disjoint_members_and_matches_account_balances(ledger):
    db, ids = ledger
    service = BalanceSheetService(db)
    mine = service.snapshot("2026-09-30", ids["mine"])
    spouse = service.snapshot("2026-09-30", ids["spouse"])
    family = service.snapshot("2026-09-30", ids["family"])
    for metric in ("assets", "liabilities", "net_assets"):
        assert mine[metric] + spouse[metric] == family[metric]
    assert mine["net_assets"] == 93000
    assert spouse["net_assets"] == 50000
    assert family["net_assets"] == 143000
    balances = {a["id"]: a["balance"] for a in AccountService(db).list()}
    assert all(a["balance"] == balances[a["id"]] for a in family["accounts"])
    assert family["net_assets"] == sum(balances[a["id"]] for a in family["accounts"])
    assert ReportService(db).integrity()["ok"]


def test_merged_account_reports_incomplete_opening_and_snapshot_is_read_only(ledger):
    db, ids = ledger
    AccountMergeService(db).merge(dict(source_id=ids["unknown"], target_id=ids["bank"]))
    with db.read() as session:
        before = [(e.id, e.account_id, e.amount) for e in session.query(Entry)]
        transactions = [(t.id, t.status) for t in session.query(Transaction)]
    sheet = BalanceSheetService(db).snapshot("2026-09-30", ids["family"])
    assert sheet["missing_opening_ids"] == [ids["bank"]]
    assert sheet["net_assets"] == 143000
    with db.read() as session:
        assert before == [(e.id, e.account_id, e.amount) for e in session.query(Entry)]
        assert transactions == [(t.id, t.status) for t in session.query(Transaction)]


def test_balance_sheet_api_rejects_invalid_filters(tmp_path):
    app = LedgerApplication(tmp_path / "api.db")
    with TestClient(app.app) as client:
        assert (
            client.get("/api/reports/balance-sheet?as_of=2026-09-10").status_code == 200
        )
        for value in ("2026-02-30", "2026-09-10T12:00:00", "not-a-date"):
            assert (
                client.get(
                    "/api/reports/balance-sheet", params={"as_of": value}
                ).status_code
                == 400
            )
        assert (
            client.get("/api/reports/balance-sheet?group_id=999999").status_code == 400
        )
        assert client.get("/api/reports/balance-sheet?group_id=abc").status_code == 422
