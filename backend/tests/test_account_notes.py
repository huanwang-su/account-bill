from app.database import Database
from app.services import AccountService, ReportService, TransactionService
from app.balance_sheet import BalanceSheetService


def test_loan_opening_and_principal_repayment_do_not_become_expense(tmp_path):
    db = Database(tmp_path / "loans.sqlite3")
    db.initialize()
    accounts = AccountService(db)
    mortgage = dict(
        name="房贷",
        role="LIABILITY",
        kind="房贷",
        note="每月还款 20,635 元；还款至 2030 年 8 月。",
    )
    loan = accounts.save(mortgage)["id"]
    accounts.opening(loan, dict(amount="-921152", occurred_at="2026-10-18"))
    # A caller changing group assignments without sending a note must keep it.
    accounts.save({k: v for k, v in mortgage.items() if k != "note"}, loan)
    assert (
        next(a for a in accounts.list() if a["id"] == loan)["note"] == mortgage["note"]
    )
    before = BalanceSheetService(db).snapshot("2026-10-18")
    assert before["liabilities"] == 92115200
    assert ReportService(db).summary()["expense"] == 0
    cash = accounts.save(dict(name="还款银行卡", role="ASSET"))["id"]
    accounts.opening(cash, dict(amount="10000", occurred_at="2026-10-18"))
    TransactionService(db).post(
        dict(
            kind="TRANSFER",
            account_id=cash,
            to_account_id=loan,
            amount="1000",
            occurred_at="2026-10-19",
            idempotency_key="principal-repayment",
        )
    )
    assert BalanceSheetService(db).snapshot("2026-10-19")["liabilities"] == 92015200
    assert ReportService(db).summary()["expense"] == 0
    assert ReportService(db).integrity()["ok"]
