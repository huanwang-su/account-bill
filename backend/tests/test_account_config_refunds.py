import json
import pytest
from app.database import Database
from app.models import Account, Entry, Bill, BillDisposition, BillLedger, RefundMatch
from app.domain import DomainError
from app.services import AccountService, TransactionService, ReportService
from app.account_config import AccountMergeService, AccountGroupService
from app.account_matching import AlipayAccountResolver
from app.bills import BillDocument, BillClassification
from app.import_workflow import BillImportWorkflow
from app.refund_matching import RefundMatchService
from test_ledger import statement


@pytest.fixture
def db(tmp_path):
    db = Database(tmp_path / "db")
    db.initialize()
    return db


def post(db, key, account, amount="10.00", kind="EXPENSE"):
    return TransactionService(db).post(
        dict(
            kind=kind,
            account_id=account,
            category_id=1 if kind == "EXPENSE" else 14,
            amount=amount,
            occurred_at="2026-09-01 12:00:00",
            idempotency_key=key,
        )
    )


def test_merge_conserves_balances_entries_and_import_routes(db):
    post(db, "balance", 5)
    post(db, "fund", 6, "20.00")
    with db.read() as s:
        before = [(e.id, e.account_id, e.amount) for e in s.query(Entry)]
    merge = AccountMergeService(db)
    preview = merge.preview(6, 5)
    assert preview["combined_balance"] == -3000
    merge.merge({"source_id": 6, "target_id": 5})
    accounts = {a["id"]: a for a in AccountService(db).list()}
    assert (
        accounts[5]["balance"] == -3000
        and accounts[6]["balance"] == 0
        and not accounts[6]["active"]
    )
    assert ReportService(db).summary({"account_id": 5})["expense"] == 3000
    with db.read() as s:
        assert before == [(e.id, e.account_id, e.amount) for e in s.query(Entry)]
        assert AlipayAccountResolver().resolve(s, "", "余额宝").id == 5
    post(db, "new-via-source", 6, "5.00")
    assert {a["id"]: a for a in AccountService(db).list()}[5]["balance"] == -3500
    assert (
        ReportService(db).list({"account_id": 5})[0]["entries"][-1]["account_id"] == 5
    )
    merge.unmerge(6)
    accounts = {a["id"]: a for a in AccountService(db).list()}
    assert accounts[5]["balance"] == -1500 and accounts[6]["balance"] == -2000
    assert ReportService(db).integrity()["ok"]


def test_merge_chain_cycle_and_roles_guard(db):
    service = AccountMergeService(db)
    service.merge(dict(source_id=6, target_id=5))
    service.merge(dict(source_id=5, target_id=7))
    with pytest.raises(DomainError):
        service.merge(dict(source_id=7, target_id=6))
    with pytest.raises(DomainError):
        service.merge(dict(source_id=1, target_id=7))
    with pytest.raises(DomainError):
        TransactionService(db).post(
            dict(
                kind="TRANSFER",
                account_id=6,
                to_account_id=7,
                amount="10",
                occurred_at="2026-09-01",
                idempotency_key="self",
            )
        )
    assert service.merge(dict(source_id=5, target_id=7))["already_merged"]


def test_groups_parent_aggregation_report_scope_and_no_duplicate(db):
    service = AccountGroupService(db)
    family = service.save(dict(name="家庭"))["id"]
    mine = service.save(dict(name="我的", parent_id=family))["id"]
    wife = service.save(dict(name="老婆", parent_id=family))["id"]
    service.assign(mine, [5, 6])
    service.assign(wife, [7])
    post(db, "mine", 5)
    post(db, "fund", 6, "20")
    post(db, "wife", 7, "5")
    AccountMergeService(db).merge(dict(source_id=6, target_id=5))
    groups = {g["id"]: g for g in service.list()}
    assert groups[family]["balance"] == -3500 and groups[family]["account_count"] == 2
    assert groups[mine]["balance"] == -3000 and groups[wife]["balance"] == -500
    assert ReportService(db).summary({"group_id": family})["expense"] == 3500
    assert ReportService(db).summary({"group_id": mine})["expense"] == 3000
    with pytest.raises(DomainError):
        service.save(dict(name="家庭", parent_id=mine), family)
    with pytest.raises(DomainError):
        service.assign(mine, [1])
    with pytest.raises(DomainError):
        service.assign(wife, [6])


def refund_csv():
    return (
        "支付宝账户：test\n交易时间,交易分类,交易对方,商品说明,收/支,金额,收/付款方式,交易状态,交易订单号\n"
        "2026-09-01 12:00:00,餐饮美食,餐厅,午餐,支出,30.00,账户余额,交易成功,pay\n"
        "2026-09-02 12:00:00,餐饮美食,餐厅,退款午餐,收入,30.00,账户余额,退款成功,refund\n"
        "2026-09-02 13:00:00,餐饮美食,餐厅,部分退款,收入,1.00,账户余额,退款成功,partial\n"
    ).encode()


def classify(flow, run):
    with flow.db.read() as s:
        doc = flow.artifacts.document(s, run, "NORMALIZED")
    value = doc.model_dump()
    for r in value["bills"]:
        r["classification"] = dict(
            category_path=(
                ["退款", "餐饮"]
                if r["facts"]["settlement"] == "REFUNDED"
                else ["支出", "餐饮"]
            ),
            tags=[],
            status="CLASSIFIED",
            note="分类",
            classified_by="Codex",
        )
    flow.classify(run, json.dumps(value).encode())


def review(db, run, match=True):
    service = RefundMatchService(db)
    candidates = service.candidates(run)
    decisions = []
    for r in candidates["refunds"]:
        matched = match and bool(r["payments"]) and r["payments"][0]["facts"]["amount_minor"] == r["refund"]["facts"]["amount_minor"]
        decisions.append(
            dict(
                refund_id=r["refund"]["id"],
                payment_id=r["payments"][0]["id"] if matched else None,
                decision="MATCHED" if matched else "UNMATCHED",
                note="同说明且单笔金额完全一致" if matched else "无等额付款",
                matched_by="Codex",
            )
        )
    return dict(
        schema_version="local-ledger.refund-matches.v1",
        run_id=run,
        candidates_digest=candidates["candidates_digest"],
        decisions=decisions,
    )


def test_refund_matching_before_import_ignores_pair_only(db):
    flow = BillImportWorkflow(db)
    run = flow.stage(refund_csv(), "statement.csv")["run_id"]
    service = RefundMatchService(db)
    candidates = service.candidates(run)
    assert len(candidates["refunds"]) == 2
    assert [len(r["payments"]) for r in candidates["refunds"]] == [1, 1]
    result = service.apply(run, json.dumps(review(db, run)).encode())
    assert result["matched_pairs"] == 1
    with db.read() as s:
        assert s.query(Bill).count() == 0
    # Classification reflects authoritative ignored state after the match.
    with db.read() as s:
        doc = flow.artifacts.document(s, run, "REFUND_PROCESSED").model_dump()
    for r in doc["bills"]:
        if r["bill_status"] == "NORMAL":
            r["classification"] = dict(
                category_path=["退款", "旧子分类"],
                tags=[],
                status="NEEDS_REVIEW",
                note="部分退款",
                classified_by="Codex",
            )
    flow.classify(run, json.dumps(doc).encode())
    result = flow.commit(run)
    assert (
        result["ignored_bills"] == 2
        and result["created"] == 1
        and result["pending"] == 1
    )
    assert flow.bills.list()[0]["classification"]["category_path"] == ["退款"]
    assert (
        service.apply(run, json.dumps(review(db, run)).encode())[
            "already_matched_pairs"
        ]
        == 1
    )
    assert len(flow.detail(run)["matched_refund_pairs"]) == 1


def test_refund_matching_after_posting_reverses_and_keeps_files(db):
    flow = BillImportWorkflow(db)
    run = flow.stage(refund_csv(), "statement.csv")["run_id"]
    classify(flow, run)
    flow.commit(run)
    assert ReportService(db).summary()["expense"] == 3000
    original_artifacts = flow.detail(run)["artifacts"]
    service = RefundMatchService(db)
    result = service.apply(run, json.dumps(review(db, run)).encode())
    assert (
        result["reversed_transactions"] == 1
        and ReportService(db).summary()["expense"] == 0
    )
    assert len(flow.bills.list()) == 1
    assert flow.detail(run)["artifacts"][:3] == original_artifacts
    with db.read() as s:
        assert s.query(Bill).count() == 3 and s.query(RefundMatch).count() == 1
    assert ReportService(db).integrity()["ok"]
    # A new upload of the same source cannot reactivate the neutralized pair.
    repeated = flow.stage(refund_csv(), "again.csv")["run_id"]
    with db.read() as s:
        doc = flow.artifacts.document(s, repeated, "NORMALIZED").model_dump()
    for r in doc["bills"]:
        r.pop("bill_status")
        r["classification"] = dict(
            category_path=(
                ["退款"] if r["facts"]["settlement"] == "REFUNDED" else ["支出", "餐饮"]
            ),
            tags=[],
            status="CLASSIFIED",
            note="重导",
            classified_by="Codex",
        )
    flow.classify(repeated, json.dumps(doc).encode())
    result = flow.commit(repeated)
    assert result["ignored_bills"] == 2 and result["created"] == result["posted"] == 0


def test_refund_match_rejects_cross_file_unequal_and_duplicate_payment(db):
    flow = BillImportWorkflow(db)
    run = flow.stage(refund_csv(), "a.csv")["run_id"]
    service = RefundMatchService(db)
    decision = review(db, run)
    decision["decisions"][1].update(
        payment_id=decision["decisions"][0]["payment_id"], decision="MATCHED"
    )
    with pytest.raises(DomainError):
        service.apply(run, json.dumps(decision).encode())
    assert not flow.detail(run)["matched_refund_pairs"]
    decision = review(db, run)
    decision["run_id"] = 999
    with pytest.raises(DomainError):
        service.apply(run, json.dumps(decision).encode())
    decision = review(db, run)
    decision["decisions"][0]["payment_id"] = "other-file-id"
    with pytest.raises(DomainError):
        service.apply(run, json.dumps(decision).encode())
    with db.read() as s:
        assert s.query(BillDisposition).count() == 0


def test_group_scope_covers_manual_details_after_merge(db):
    from app.bills import BillService

    group = AccountGroupService(db).save(dict(name="我"))["id"]
    AccountGroupService(db).assign(group, [5, 6])
    post(db, "manual-from-fund", 6)
    AccountMergeService(db).merge(dict(source_id=6, target_id=5))
    bills = BillService(db).list(dict(group_id=group))
    assert (
        len(bills) == 1
        and bills[0]["account_id"] == 5
        and bills[0]["account_ids"] == [5]
    )


def test_unmatched_refund_uses_single_category_and_preserves_direction(db):
    flow = BillImportWorkflow(db)
    run = flow.stage(refund_csv(), "r.csv")["run_id"]
    classify(flow, run)
    flow.commit(run)
    refund = next(r for r in flow.bills.list() if r["facts"]["amount_minor"] == 100)
    flow.posting.resolve(refund["id"], dict(kind="REFUND", account_id=5, amount="1.00"))
    updated = next(r for r in flow.bills.list() if r["id"] == refund["id"])
    assert updated["classification"]["category_path"] == ["退款"]
    tx = next(
        t for t in ReportService(db).list() if t["id"] == updated["transaction_id"]
    )
    assert next(e for e in tx["entries"] if e["category_id"])["category"] == "退款"
    assert ReportService(db).summary()["expense"] == 2900


def test_merged_wallet_rename_keeps_both_provider_hints(db):
    AccountMergeService(db).merge(dict(source_id=6, target_id=5))
    original = next(a for a in AccountService(db).list() if a["id"] == 5)
    AccountService(db).save({**original, "name": "支付宝"}, 5)
    with db.read() as session:
        assert AlipayAccountResolver().resolve(session, "", "账户余额").id == 5
        assert AlipayAccountResolver().resolve(session, "", "余额宝").id == 5


def test_manual_refund_also_uses_single_category(db):
    from app.bills import BillService

    tx = TransactionService(db).post(
        dict(
            kind="REFUND",
            account_id=5,
            category_id=1,
            amount="5",
            occurred_at="2026-09-01",
            idempotency_key="manual-refund",
        )
    )
    detail = next(r for r in BillService(db).list() if r["transaction_id"] == tx["id"])
    assert detail["facts"]["settlement"] == "REFUNDED"
    assert detail["classification"]["category_path"] == ["退款"]
    entry = next(e for e in ReportService(db).list()[0]["entries"] if e["category_id"])
    assert entry["category"] == "退款"


def test_repeat_download_preserves_refund_ignore_status(db):
    flow = BillImportWorkflow(db)
    run = flow.stage(refund_csv(), "original.csv")["run_id"]
    classify(flow, run)
    flow.commit(run)
    RefundMatchService(db).apply(run, json.dumps(review(db, run)).encode())
    repeated = flow.stage(refund_csv(), "same.csv")["run_id"]
    with db.read() as session:
        doc = flow.artifacts.document(session, repeated, "NORMALIZED")
    assert sum(r.bill_status == "IGNORED" for r in doc.bills) == 2
    assert flow.detail(repeated)["summary"]["ignored_bill_count"] == 2
    for r in doc.bills:
        if r.bill_status == "NORMAL":
            r.classification = BillClassification(
                **{
                    "category_path": ["退款"],
                    "tags": [],
                    "status": "NEEDS_REVIEW",
                    "note": "部分退款",
                    "classified_by": "Codex",
                }
            )
    flow.classify(repeated, doc.model_dump_json().encode())
    assert flow.commit(repeated)["posted"] == 0
