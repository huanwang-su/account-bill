import json
import pytest
from app.bill_posting import BillPostingService
from app.bills import BillDocument
from app.database import Database
from app.domain import DomainError
from app.import_workflow import BillImportWorkflow
from app.models import Bill, BillLedger, Entry, Transaction, Account
from app.services import AccountService, ReportService, TransactionService
from test_import_workflow import prepared, classify_run
from test_ledger import statement, payload


@pytest.fixture
def flow(tmp_path):
    db = Database(tmp_path / "posting.sqlite3")
    db.initialize()
    return BillImportWorkflow(db)


def balances(flow):
    return {a["id"]: a["balance"] for a in AccountService(flow.db).list()}


def test_single_reversal_preserves_detail_and_never_reposts(flow):
    initial = balances(flow)
    run = prepared(flow, ["a"])
    assert flow.commit(run)["posted"] == 1
    bill = flow.bills.list()[0]
    assert bill["ledger_status"] == "POSTED"
    assert bill["transaction_id"]
    assert ReportService(flow.db).summary()["expense"] == 8000
    assert flow.posting.reverse(bill["id"])["reversed"]
    assert not flow.posting.reverse(bill["id"])["reversed"]
    assert flow.bills.list()[0]["ledger_status"] == "REVERSED"
    assert balances(flow) == initial
    again = prepared(flow, ["a"])
    assert flow.commit(again)["posted"] == 0
    assert balances(flow) == initial
    with flow.db.read() as s:
        assert s.query(Transaction).count() == 2
        assert s.query(Bill).count() == 1


def test_batch_cancel_owns_only_new_or_adopted_records(flow):
    first = prepared(flow, ["a"])
    flow.commit(first)
    second = prepared(flow, ["a", "b"])
    result = flow.commit(second)
    assert result["posted"] == 1 and result["duplicates"] == 1
    assert flow.cancel(second)["reversed_details"] == 1
    assert flow.cancel(second)["already_cancelled"]
    assert ReportService(flow.db).summary()["expense"] == 8000
    assert len(ReportService(flow.db).list()) == 1
    flow.cancel(first)
    assert all(a["balance"] == 0 for a in AccountService(flow.db).list())
    assert all(b["ledger_status"] == "REVERSED" for b in flow.bills.list())
    with pytest.raises(DomainError):
        flow.commit(second)
    assert len(flow.detail(second)["artifacts"]) == 3


def test_pending_can_be_resolved_once_and_cancelled(flow):
    raw = (
        statement(["a"]).decode("gb18030").replace("账户余额", "账户余额&优惠").encode()
    )
    run = flow.stage(raw, "mixed.csv")["run_id"]
    flow.classify(run, classify_run(flow, run).model_dump_json().encode())
    assert flow.commit(run)["pending"] == 1
    bill = flow.bills.list()[0]
    p = payload(flow.db, amount="50")
    flow.posting.resolve(bill["id"], p)
    assert flow.bills.list()[0]["facts"]["amount_minor"] == 8000
    assert ReportService(flow.db).summary()["expense"] == 5000
    with pytest.raises(DomainError):
        flow.posting.resolve(bill["id"], p)
    flow.cancel(run)
    assert ReportService(flow.db).summary()["expense"] == 0
    with pytest.raises(DomainError):
        flow.posting.resolve(bill["id"], p)


def test_unposted_and_unprocessed_batch_cancellation(flow):
    run = prepared(flow, ["a"])
    flow.cancel(run)
    with pytest.raises(DomainError):
        flow.commit(run)
    assert flow.bills.list() == []
    raw = statement(["b"]).decode("gb18030").replace("账户余额", "未知账户").encode()
    pending = flow.stage(raw, "unknown.csv")["run_id"]
    flow.classify(pending, classify_run(flow, pending).model_dump_json().encode())
    flow.commit(pending)
    bill = flow.bills.list()[0]
    flow.posting.reverse(bill["id"])
    assert flow.bills.list()[0]["ledger_status"] == "REVERSED"
    with flow.db.read() as s:
        assert s.query(Transaction).count() == 0


def test_manual_detail_and_replacement_share_batch_ownership(flow):
    service = TransactionService(flow.db)
    tx = service.post(payload(flow.db))
    bill = flow.bills.list()[0]
    assert bill["id"].startswith("manual:") and bill["transaction_id"] == tx["id"]
    service.reverse(tx["id"])
    assert flow.bills.list()[0]["ledger_status"] == "REVERSED"
    run = prepared(flow, ["a"])
    flow.commit(run)
    imported = next(b for b in flow.bills.list() if b["ledger_status"] == "POSTED")
    replacement = service.replace(
        imported["transaction_id"], payload(flow.db, amount="25")
    )
    with flow.db.read() as s:
        assert (
            s.query(BillLedger)
            .filter_by(transaction_id=replacement["id"])
            .one()
            .owner_run_id
            == run
        )
    flow.cancel(run)
    assert ReportService(flow.db).summary()["expense"] == 0
    assert all(a["balance"] == 0 for a in AccountService(flow.db).list())


def test_external_refund_blocks_whole_batch_cancel(flow):
    run = prepared(flow, ["a", "b"])
    flow.commit(run)
    first = flow.bills.list()[0]
    service = TransactionService(flow.db)
    refund = service.post(
        payload(flow.db, kind="REFUND", related_id=first["transaction_id"], amount="10")
    )
    before = balances(flow)
    with pytest.raises(DomainError, match="先撤销关联退款"):
        flow.cancel(run)
    assert balances(flow) == before
    assert flow.detail(run)["status"] == "IMPORTED"
    service.reverse(refund["id"])
    flow.cancel(run)
    assert all(a["balance"] == 0 for a in AccountService(flow.db).list())


def test_uncounted_never_posts_even_if_classified_and_zero_not_posted(flow):
    raw = (
        statement(["a"])
        .decode("gb18030")
        .replace("支出,80.00", "不计收支,80.00")
        .encode()
    )
    run = flow.stage(raw, "uncounted.csv")["run_id"]
    flow.classify(run, classify_run(flow, run).model_dump_json().encode())
    assert flow.commit(run)["posted"] == 0
    assert flow.detail(run)["rows"][0]["facts"]["flow"] == "UNSPECIFIED"
    assert flow.bills.list() == []
    zero = statement(["z"]).decode("gb18030").replace("80.00", "0.00").encode()
    ignored = flow.stage(zero, "zero.csv")["run_id"]
    flow.classify(ignored, classify_run(flow, ignored).model_dump_json().encode())
    assert flow.commit(ignored)["ignored"] == 1


def test_classification_updates_posted_categories_without_changing_balances(flow):
    run = prepared(flow, ["a"])
    flow.commit(run)
    before = balances(flow)
    d = flow.bills.export().model_dump()
    d["bills"][0]["classification"]["category_path"] = ["支出", "居家", "水电"]
    d["bills"][0]["classification"]["tags"] = ["已确认"]
    flow.bills.save(BillDocument.read(json.dumps(d)))
    tx = ReportService(flow.db).list()[0]
    assert tx["tags"] == ["已确认"]
    assert any(e["category"] == "水电" for e in tx["entries"])
    assert balances(flow) == before
    d = flow.bills.export().model_dump()
    d["bills"][0]["classification"]["category_path"] = ["收入", "工资"]
    with pytest.raises(DomainError):
        flow.bills.save(BillDocument.read(json.dumps(d)))
    assert balances(flow) == before
