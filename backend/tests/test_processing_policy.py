import json
import pytest
from app.database import Database
from app.models import (
    Bill,
    BillLedger,
    ImportRow,
    Account,
    BillNetting,
    BillImportArtifact,
    TransferMatch,
)
from app.bills import BillDocument, BillService, BillClassification
from app.import_workflow import BillImportWorkflow
from app.refund_matching import RefundMatchService
from app.transfer_matching import TransferMatchService
from app.classification_policy import ClassificationPolicyService
from app.services import AccountService, ReportService
from app.domain import DomainError


@pytest.fixture
def db(tmp_path):
    db = Database(tmp_path / "db")
    db.initialize()
    return db


def source(refunds=(30, 20), payment=100):
    lines = [
        "支付宝账户：test",
        "交易时间,交易分类,交易对方,商品说明,收/支,金额,收/付款方式,交易状态,交易订单号",
        f"2026-09-01 12:00:00,餐饮,餐厅,午餐,支出,{payment},账户余额,交易成功,pay",
    ]
    for i, amount in enumerate(refunds):
        lines.append(
            f"2026-09-02 12:00:0{i},餐饮,餐厅,退款午餐,收入,{amount},账户余额,退款成功,refund{i}"
        )
    return ("\n".join(lines) + "\n").encode()


def staged(db, refunds=(30, 20), payment=100):
    flow = BillImportWorkflow(db)
    run = flow.stage(source(refunds, payment), "a.csv")["run_id"]
    with db.read() as s:
        doc = flow.artifacts.document(s, run, "NORMALIZED")
    for r in doc.bills:
        r.classification = BillClassification(
            category_path=["退款"] if r.facts.flow == "IN" else ["支出", "餐饮"],
            tags=[],
            status="CLASSIFIED",
            classified_by="Codex",
        )
    doc = BillDocument.read(doc.model_dump_json())
    flow.classify(run, doc.model_dump_json().encode())
    return flow, run, doc


def decisions(db, run, selected=None):
    c = RefundMatchService(db).candidates(run)
    decisions = []
    for i, r in enumerate(c["refunds"]):
        match = selected is None or i in selected
        decisions.append(
            dict(
                refund_id=r["refund"]["id"],
                payment_id=r["payments"][0]["id"] if match else None,
                decision="MATCHED" if match else "UNMATCHED",
                note="同订单同商户",
                matched_by="Codex",
            )
        )
    return json.dumps(
        dict(run_id=run, candidates_digest=c["candidates_digest"], decisions=decisions)
    ).encode()


def balance(db, key=5):
    return next(a["balance"] for a in AccountService(db).list() if a["id"] == key)


@pytest.mark.parametrize("before", [True, False])
def test_multiple_partial_refunds_net_once_and_keep_history(db, before):
    flow, run, doc = staged(db)
    if not before:
        flow.commit(run)
        assert balance(db) == -10000
    with db.read() as s:
        archives = [(a.id, a.content) for a in s.query(BillImportArtifact)]
    data = decisions(db, run)
    result = RefundMatchService(db).apply(run, data)
    if before:
        flow.commit(run)
    assert result["partial_payments"] == 1
    assert balance(db) == -5000
    rows = flow.bills.list()
    assert len(rows) == 1 and rows[0]["effective_amount_minor"] == 5000
    assert (
        rows[0]["facts"]["amount_minor"] == 10000
        and rows[0]["refund_amount_minor"] == 5000
    )
    assert ReportService(db).summary()["expense"] == 5000
    assert RefundMatchService(db).apply(run, data)["already_matched_pairs"] == 2
    assert balance(db) == -5000 and ReportService(db).integrity()["ok"]
    with db.read() as s:
        assert archives == [
            (a.id, a.content)
            for a in s.query(BillImportArtifact).filter(
                BillImportArtifact.id.in_([a[0] for a in archives])
            )
        ]
    repeat = flow.stage(source(), "repeat.csv")["run_id"]
    with db.read() as s:
        repeated = flow.artifacts.document(s, repeat, "NORMALIZED")
    for r in repeated.bills:
        r.classification = next(v.classification for v in doc.bills if v.id == r.id)
    flow.classify(repeat, repeated.model_dump_json().encode())
    flow.commit(repeat)
    assert balance(db) == -5000
    flow.posting.reverse(rows[0]["id"])
    assert balance(db) == 0 and ReportService(db).integrity()["ok"]


def test_incremental_refund_reposts_net_then_full_zero(db):
    flow, run, doc = staged(db, (30, 70))
    flow.commit(run)
    service = RefundMatchService(db)
    service.apply(run, decisions(db, run, {0}))
    assert balance(db) == -7000 and ReportService(db).integrity()["ok"]
    service.apply(run, decisions(db, run))
    assert balance(db) == 0 and flow.bills.list() == []
    assert ReportService(db).integrity()["ok"]


def test_overrefund_is_atomic(db):
    flow, run, _ = staged(db, (80, 30))
    flow.commit(run)
    with pytest.raises(DomainError, match="累计退款"):
        RefundMatchService(db).apply(run, decisions(db, run))
    assert balance(db) == -10000 and len(flow.bills.list()) == 3
    with db.read() as s:
        assert s.query(BillNetting).count() == 0


def test_different_refund_account_rejected(db):
    flow, run, _ = staged(db, (30,))
    flow.commit(run)
    with db.write() as s:
        row = (
            s.query(ImportRow)
            .filter_by(batch_id=1)
            .order_by(ImportRow.id.desc())
            .first()
        )
        value = json.loads(row.decision)
        value["account_id"] = 7
        row.decision = json.dumps(value)
    with pytest.raises(DomainError, match="账户"):
        RefundMatchService(db).apply(run, decisions(db, run))
    assert balance(db) == -10000


def pair(db, ambiguous=False):
    flow = BillImportWorkflow(db)
    raw = (
        "支付宝账户：test\n交易时间,交易分类,交易对方,商品说明,收/支,金额,收/付款方式,交易状态,交易订单号\n2026-09-01 12:00:00,转账,自己,转账,支出,100,账户余额,交易成功,out\n2026-09-01 12:00:00,转账,自己,转账,收入,100,余额宝,交易成功,in\n"
        + (
            "2026-09-01 12:00:00,转账,自己,转账,收入,100,余额宝,交易成功,in2\n"
            if ambiguous
            else ""
        )
    ).encode()
    run = flow.stage(raw, "pair.csv")["run_id"]
    with db.write() as s:
        s.get(Account, 5).number = "1234567890123456"
        s.get(Account, 6).number = "9876543210987654"
        for row in s.query(ImportRow):
            data = json.loads(row.data)
            data["counterparty_account"] = (
                "9876543210987654"
                if data["direction"] == "支出"
                else "1234567890123456"
            )
            row.data = json.dumps(data)
    with db.read() as s:
        doc = flow.artifacts.document(s, run, "NORMALIZED")
    for r in doc.bills:
        r.classification = BillClassification(
            category_path=["资金往来", "同名转账"],
            tags=[],
            status="NEEDS_REVIEW",
            classified_by="Codex",
        )
    flow.classify(run, doc.model_dump_json().encode())
    return flow, run


def test_transfer_one_detail_both_balances_dedup_reversal(db):
    flow, run = pair(db)
    result = flow.commit(run)
    assert result["internal_transfers"] == 1
    assert balance(db, 5) == -10000 and balance(db, 6) == 10000
    rows = flow.bills.list()
    assert len(rows) == 1 and rows[0]["transaction_kind"] == "TRANSFER"
    assert rows[0]["account_ids"] == [5, 6] and len(rows[0]["related_sources"]) == 1
    assert ReportService(db).summary()["expense"] == 0
    assert TransferMatchService(db).auto()["matched"] == 0
    with db.read() as s:
        incoming = s.query(TransferMatch).one().incoming_id
    flow.posting.reverse(incoming)
    assert balance(db, 5) == balance(db, 6) == 0
    assert ReportService(db).integrity()["ok"]


def test_transfer_ambiguous_same_day_never_guessed(db):
    flow, run = pair(db, True)
    assert flow.commit(run)["internal_transfers"] == 0
    assert len(flow.bills.list()) == 3 and balance(db) == 0


def test_transfer_batch_cancel_reverses_both_sides(db):
    flow, run = pair(db)
    flow.commit(run)
    flow.cancel(run)
    assert balance(db, 5) == balance(db, 6) == 0 and ReportService(db).integrity()["ok"]


def test_policy_scope_not_bypass_amount_accounts_or_fund_nature(db):
    flow, run, _ = staged(db, ())
    with db.read() as s:
        doc = flow.artifacts.document(s, run, "CLASSIFIED")
    doc.bills[0].classification.status = "NEEDS_REVIEW"
    doc.bills[0].classification.review_scope = "TRANSACTION"
    flow.classify(run, doc.model_dump_json().encode())
    flow.commit(run)
    service = ClassificationPolicyService(db)
    assert service.reprocess()["pending"] == 1
    current = BillService(db).export()
    current.bills[0].classification.review_scope = "CATEGORY"
    BillService(db).save(current)
    values = service.get()
    values.pop("updated_at")
    values["allow_broad_categories"] = False
    service.save(values)
    assert service.reprocess()["pending"] == 1
    values = service.get()
    values.pop("updated_at")
    values["allow_broad_categories"] = True
    service.save(values)
    assert service.reprocess()["posted"] == 1 and balance(db) == -10000
    assert BillService(db).export().ai_reference["allow_broad_categories"]


def test_saved_policy_snapshot_and_revision_conflict(db):
    service = ClassificationPolicyService(db)
    initial = service.get()
    initial.pop("updated_at")
    initial["reference"] = "商超允许宽泛分类；个人转账需判断资金性质。"
    saved = service.save(initial)
    flow = BillImportWorkflow(db)
    run = flow.stage(source((), 100), "reference.csv")["run_id"]
    with db.read() as s:
        snapshot = flow.artifacts.document(s, run, "NORMALIZED")
    assert snapshot.ai_reference["reference"] == saved["reference"]
    with pytest.raises(DomainError, match="已被修改"):
        service.save(initial)
    assert flow.bills.list() == []


def test_posted_transfer_mirrors_replace_wrong_income_expense(db):
    flow, run = pair(db)
    # Stage both as ordinary financial events to reproduce historic separate posting.
    with db.read() as s:
        doc = flow.artifacts.document(s, run, "CLASSIFIED")
    for r in doc.bills:
        r.classification = BillClassification(
            category_path=(
                ["支出", "其他"] if r.facts.flow == "OUT" else ["收入", "其他"]
            ),
            status="CLASSIFIED",
            classified_by="Codex",
        )
    flow.classify(run, doc.model_dump_json().encode())
    # Commit now corrects mirrors even when this step initially posted them as ordinary events.
    result = flow.commit(run)
    assert (
        result["created"] == 1
        and result["posted"] == 1
        and result["linked_bills"] == 1
    )
    assert ReportService(db).summary()["expense"] == 0
    assert ReportService(db).summary()["income"] == 0
    assert balance(db, 5) == -10000 and balance(db, 6) == 10000
    assert ReportService(db).integrity()["ok"]
    flow.cancel(run)
    assert balance(db, 5) == balance(db, 6) == 0


def test_manually_changed_actual_account_not_overwritten_by_netting(db):
    flow, run, _ = staged(db, (30,))
    with db.read() as s:
        doc = flow.artifacts.document(s, run, "CLASSIFIED")
    doc.bills[0].classification.status = "NEEDS_REVIEW"
    doc.bills[0].classification.review_scope = "ACCOUNT"
    flow.classify(run, doc.model_dump_json().encode())
    flow.commit(run)
    flow.posting.resolve(
        doc.bills[0].id, dict(kind="EXPENSE", account_id=7, category_id=1)
    )
    with pytest.raises(DomainError, match="账户"):
        RefundMatchService(db).apply(run, decisions(db, run))
    assert balance(db, 7) == -10000 and balance(db, 5) == 0
    assert ReportService(db).integrity()["ok"]
