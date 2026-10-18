import uuid
import json
import pytest
from app.database import Database
from app.models import Entry, ImportRow
from app.services import (
    AccountService,
    CatalogService,
    TransactionService,
    ReportService,
)
from app.account_config import AccountMergeService
from app.balance_sheet import BalanceSheetService
from app.investment_analysis import InvestmentAnalysisService
from app.import_workflow import BillImportWorkflow
from app.bills import BillClassification
from app.account_matching import AlipayAccountResolver
from app.domain import DomainError


@pytest.fixture
def bank_bundle(tmp_path):
    db = Database(tmp_path / "bank.sqlite3")
    db.initialize()
    accounts = AccountService(db)
    default = next(a for a in accounts.list() if a["id"] == 6)
    accounts.save({**default, "kind": "银行卡"}, 6)

    def new(name, kind, role="ASSET"):
        return accounts.save(dict(name=name, kind=kind, role=role))["id"]

    cash = new("招商银行", "招商银行")
    fund = new("招商基金", "理财")
    card = new("招商信用卡", "信用卡", "LIABILITY")
    for key, amount in [(cash, "1000"), (fund, "2000"), (card, "-100")]:
        accounts.opening(key, dict(amount=amount, occurred_at="2026-09-01"))
    return db, cash, fund, card


def post(db, kind, account, amount, category=None, to=None):
    return TransactionService(db).post(
        dict(
            kind=kind,
            account_id=account,
            amount=amount,
            category_id=category,
            to_account_id=to,
            occurred_at="2026-09-02",
            idempotency_key=str(uuid.uuid4()),
        )
    )


def merge_all(db, cash, fund, card):
    service = AccountMergeService(db)
    service.merge(dict(source_id=fund, target_id=cash))
    service.merge(dict(source_id=card, target_id=cash))


def test_one_net_account_preserves_gross_balance_sheet_and_original_entries(
    bank_bundle,
):
    db, cash, fund, card = bank_bundle
    before = BalanceSheetService(db).snapshot("2026-09-30")
    with db.read() as session:
        entries = [(e.id, e.account_id, e.amount) for e in session.query(Entry)]
    merge_all(db, cash, fund, card)
    rows = {a["id"]: a for a in AccountService(db).list()}
    assert rows[cash]["balance"] == 290000
    assert rows[card]["merged_into_id"] == cash and rows[card]["role"] == "LIABILITY"
    assert rows[fund]["merged_into_id"] == cash
    after = BalanceSheetService(db).snapshot("2026-09-30")
    assert (after["assets"], after["liabilities"], after["net_assets"]) == (
        before["assets"],
        before["liabilities"],
        before["net_assets"],
    )
    row = next(a for a in after["accounts"] if a["id"] == cash)
    assert row["asset_amount"] == 300000 and row["liability_amount"] == 10000
    with db.read() as session:
        assert entries == [(e.id, e.account_id, e.amount) for e in session.query(Entry)]
    assert ReportService(db).integrity()["ok"]


def test_wealth_uses_fund_component_and_new_funding_keeps_component_identity(
    bank_bundle,
):
    db, cash, fund, card = bank_bundle
    merge_all(db, cash, fund, card)
    with db.read() as session:
        assert AlipayAccountResolver().resolve(session, "", "招商基金").id == fund
    cats = CatalogService(db).categories()
    salary = next(c["id"] for c in cats if c["name"] == "工资")
    gain = next(c["id"] for c in cats if c["name"] == "理财收益")
    food = next(c["id"] for c in cats if c["name"] == "餐饮")
    post(db, "INCOME", cash, "500", salary)
    post(db, "EXPENSE", card, "20", food)
    post(db, "TRANSFER", cash, "300", to=fund)
    post(db, "INCOME", fund, "10", gain)
    post(db, "INCOME", cash, "2", gain)
    result = InvestmentAnalysisService(db).analyze(end="2026-09-30")
    assert result["account_count"] == result["ending"] == result["profit"] == 0
    assert result["available_accounts"] == []
    with pytest.raises(DomainError, match="证券或理财"):
        InvestmentAnalysisService(db).analyze(account_id=cash, end="2026-09-30")
    with pytest.raises(DomainError, match="证券或理财"):
        InvestmentAnalysisService(db).analyze(account_id=fund, end="2026-09-30")
    assert {a["id"]: a for a in AccountService(db).list()}[cash]["balance"] == 339200
    with db.read() as session:
        assert (
            sum(e.amount for e in session.query(Entry).filter_by(account_id=card))
            == -12000
        )
        assert (
            sum(e.amount for e in session.query(Entry).filter_by(account_id=fund))
            == 231000
        )
    AccountMergeService(db).unmerge(card)
    assert InvestmentAnalysisService(db).analyze(end="2026-09-30")["account_count"] == 0
    AccountMergeService(db).unmerge(fund)
    remaining = InvestmentAnalysisService(db).analyze(account_id=fund, end="2026-09-30")
    assert (
        remaining["ending"] == 231000
        and remaining["profit"] == 1000
        and remaining["reconciled"]
    )


def test_imported_credit_payment_retains_liability_component(bank_bundle):
    db, cash, fund, card = bank_bundle
    merge_all(db, cash, fund, card)
    raw = (
        "支付宝账户：synthetic\n交易时间,交易分类,交易对方,商品说明,收/支,金额,收/付款方式,交易状态,交易订单号\n"
        "2026-09-03 12:00:00,餐饮美食,测试餐厅,午餐,支出,12.00,测试信用卡,交易成功,credit-payment\n"
    ).encode()
    flow = BillImportWorkflow(db)
    run = flow.stage(raw, "synthetic.csv")
    with db.write() as session:
        row = session.query(ImportRow).filter_by(batch_id=run["id"]).one()
        decision = json.loads(row.decision)
        decision["account_id"] = card
        row.decision = json.dumps(decision)
        doc = flow.artifacts.document(session, run["run_id"], "NORMALIZED")
        doc.bills[0].classification = BillClassification(
            category_path=["支出", "餐饮"], status="CLASSIFIED", classified_by="test"
        )
    flow.classify(run["run_id"], doc.model_dump_json().encode())
    assert flow.commit(run["run_id"])["posted"] == 1
    with db.read() as session:
        assert (
            sum(e.amount for e in session.query(Entry).filter_by(account_id=card))
            == -11200
        )
    result = InvestmentAnalysisService(db).analyze(end="2026-09-30")
    assert result["account_count"] == result["ending"] == result["profit"] == 0
    assert result["reconciled"]
