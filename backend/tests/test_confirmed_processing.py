import json
import pytest
from app.database import Database
from app.models import Bill, BillLedger, Transaction, Entry
from app.services import ReportService
from app.confirmed_transfers import ConfirmedTransferService
from app.classification_policy import ClassificationPolicyService
from app.import_workflow import BillImportWorkflow
from app.bills import BillClassification, BillService
from app.domain import DomainError
from app.refund_matching import RefundMatchService
from test_processing_policy import staged, decisions, balance


@pytest.fixture
def db(tmp_path):
    d = Database(tmp_path / "db")
    d.initialize()
    return d


def refund_income(db):
    service = ClassificationPolicyService(db)
    data = service.get()
    data.pop("updated_at")
    data["unmatched_refund_income"] = True
    service.save(data)


def test_unmatched_refund_is_income_and_later_matching_never_doubles_cash(db):
    refund_income(db)
    flow, run, _ = staged(db, (30,))
    assert flow.commit(run)["posted"] == 2
    summary = ReportService(db).summary()
    assert (
        summary["income"] == 3000
        and summary["expense"] == 10000
        and balance(db) == -7000
    )
    refund = next(
        r for r in flow.bills.list() if r["facts"]["settlement"] == "REFUNDED"
    )
    assert (
        refund["classification"]["category_path"] == ["退款"]
        and refund["transaction_kind"] == "INCOME"
    )
    exported = BillService(db).export()
    next(r for r in exported.bills if r.id == refund["id"]).classification.note = (
        "已按退款收入入账"
    )
    BillService(db).save(exported)
    result = RefundMatchService(db).apply(run, decisions(db, run))
    assert result["reversed_transactions"] == 2
    assert balance(db) == -7000
    summary = ReportService(db).summary()
    assert summary["income"] == 0 and summary["expense"] == 7000
    assert ReportService(db).integrity()["ok"]
    flow.cancel(run)
    assert balance(db) == 0


def test_unmatched_refund_income_requires_saved_policy_and_refund_identity(db):
    flow, run, doc = staged(db, (30,))
    flow.commit(run)
    refund = next(r for r in doc.bills if r.facts.flow == "IN")
    with pytest.raises(DomainError, match="退款类型"):
        flow.posting.resolve(refund.id, dict(kind="INCOME", account_id=5))
    assert balance(db) == -10000
    refund_income(db)
    assert ClassificationPolicyService(db).reprocess()["posted"] == 1
    assert balance(db) == -7000
    assert ClassificationPolicyService(db).reprocess()["posted"] == 0
    flow.posting.reverse(refund.id)
    assert balance(db) == -10000


def transfers(db, mirror=True):
    text = "支付宝账户：test\n交易时间,交易分类,交易对方,商品说明,收/支,金额,收/付款方式,交易状态,交易订单号\n2026-09-01 12:00:00,转账,小荷包,自动攒,收入,100,余额宝,交易成功,in\n"
    if mirror:
        text += "2026-09-01 12:00:00,转账,自己,自动攒,支出,100,账户余额,交易成功,out\n2026-09-01 12:00:00,转账,自己,银行凭证,支出,100,账户余额,交易成功,bank\n"
    flow = BillImportWorkflow(db)
    run = flow.stage(text.encode(), "transfer.csv")["run_id"]
    with db.read() as s:
        doc = flow.artifacts.document(s, run, "NORMALIZED")
    for r in doc.bills:
        r.classification = BillClassification(
            category_path=["资金往来", "内部转账"],
            status="CLASSIFIED",
            classified_by="测试",
        )
    flow.classify(run, doc.model_dump_json().encode())
    flow.commit(run)
    rows = flow.bills.list({"batch_id": flow.detail(run)["batch_id"]})
    primary = next(r["id"] for r in rows if r["facts"]["flow"] == "IN")
    sources = [r["id"] for r in rows if r["facts"]["flow"] == "OUT"]
    return (
        flow,
        run,
        dict(
            bill_id=primary,
            source_ids=sources,
            account_id=5,
            to_account_id=6,
            note="用户明确出资账户及订单对应，两份付款凭证是同一笔扣款",
        ),
    )


def test_three_vouchers_confirm_one_transfer_and_revoke_from_any_source(db):
    flow, run, data = transfers(db)
    with db.read() as s:
        original = {b.id: b.facts for b in s.query(Bill)}
    service = ConfirmedTransferService(db)
    result = service.confirm(data)
    assert not result["already_confirmed"]
    assert service.confirm(data)["already_confirmed"]
    rows = flow.bills.list()
    assert len(rows) == 1 and rows[0]["source_count"] == 3
    assert balance(db, 5) == -10000 and balance(db, 6) == 10000
    summary = ReportService(db).summary()
    assert summary["income"] == summary["expense"] == 0
    with db.read() as s:
        assert s.query(Transaction).count() == 1 and s.query(Entry).count() == 2
        assert original == {b.id: b.facts for b in s.query(Bill)}
    flow.posting.reverse(data["source_ids"][0])
    assert balance(db, 5) == balance(db, 6) == 0 and ReportService(db).integrity()["ok"]
    with pytest.raises(DomainError):
        service.confirm(data)


def test_single_voucher_transfer_does_not_require_mirror_bill(db):
    flow, run, data = transfers(db, False)
    ConfirmedTransferService(db).confirm(data)
    assert balance(db, 5) == -10000 and balance(db, 6) == 10000
    assert len(flow.bills.list()) == 1
    flow.cancel(run)
    assert balance(db, 5) == balance(db, 6) == 0


def test_confirm_transfer_rejects_account_or_amount_conflict_atomically(db):
    flow, run, data = transfers(db)
    data["to_account_id"] = 7
    with pytest.raises(DomainError, match="账户与凭证"):
        ConfirmedTransferService(db).confirm(data)
    assert balance(db) == 0
    data["to_account_id"] = 6
    with db.write() as s:
        source = s.get(Bill, data["source_ids"][0])
        facts = json.loads(source.facts)
        facts["amount_minor"] += 1
        source.facts = json.dumps(facts)
    with pytest.raises(DomainError, match="金额、币种"):
        ConfirmedTransferService(db).confirm(data)
    with db.read() as s:
        assert s.query(Transaction).count() == 0
