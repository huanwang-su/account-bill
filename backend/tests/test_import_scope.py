import json
import pytest
from app.bills import BillDocument, BillFacts
from app.database import Database
from app.import_workflow import BillImportWorkflow
from app.models import Bill, ImportRow
from app.source_observations import SourceObservationReconciler
from test_ledger import statement
from test_bills import classify


def test_cutoff_inclusive_keeps_original_and_excludes_earlier_postings(tmp_path):
    db = Database(tmp_path / "scope.sqlite3")
    db.initialize()
    workflow = BillImportWorkflow(db)
    raw = statement(["before", "boundary", "after"]).decode("gb18030")
    times = ["2026-09-27 23:59:59", "2026-09-28 00:00:00", "2026-09-28 00:00:01"]
    for time in times:
        raw = raw.replace("2026-09-10 12:00:00", time, 1)
    raw = raw.encode("gb18030")
    run = workflow.stage(raw, "scope.csv", start_at="2026-09-28 00:00:00")
    detail = workflow.detail(run["run_id"])
    assert detail["summary"]["source_count"] == 3
    assert detail["summary"]["excluded_before_start"] == 1
    assert detail["summary"]["normalized_count"] == 2
    original = next(a for a in detail["artifacts"] if a["stage"] == "ORIGINAL")
    assert workflow.download(original["id"])[1] == raw
    normalized = next(a for a in detail["artifacts"] if a["stage"] == "NORMALIZED")
    doc = BillDocument.read(workflow.download(normalized["id"])[1])
    assert [r.facts.occurred_at for r in doc.bills] == times[1:]
    workflow.classify(run["run_id"], classify(doc).model_dump_json().encode())
    assert workflow.commit(run["run_id"])["posted"] == 2
    with db.read() as session:
        first = session.query(ImportRow).order_by(ImportRow.id).first()
        assert first.status == "IGNORED" and session.get(Bill, first.source_key) is None
    # The same original can subsequently be imported without the time restriction.
    replay = workflow.stage(raw, "scope.csv")
    detail = workflow.detail(replay["run_id"])
    artifact = next(a for a in detail["artifacts"] if a["stage"] == "NORMALIZED")
    doc = BillDocument.read(workflow.download(artifact["id"])[1])
    workflow.classify(replay["run_id"], classify(doc).model_dump_json().encode())
    assert workflow.commit(replay["run_id"])["created"] == 1


def test_ignored_provider_status_refresh_is_archived_without_reopening_bill(tmp_path):
    db = Database(tmp_path / "ignored.sqlite3")
    db.initialize()
    workflow = BillImportWorkflow(db)
    raw = (
        statement(["ignored"])
        .decode("gb18030")
        .replace("支出,80.00", "不计收支,80.00")
        .encode("gb18030")
    )
    first = workflow.stage(raw, "first.csv")
    workflow.commit(first["run_id"])
    # Some old installations retained an ignored Bill; its facts stay immutable.
    with db.write() as session:
        doc = workflow.artifacts.document(session, first["run_id"], "NORMALIZED")
        session.add(
            Bill(
                id=doc.bills[0].id,
                facts=doc.bills[0].facts.model_dump_json(),
                classification="null",
                revision=0,
                saved_at="2026-09-10 12:00:00",
            )
        )
    revised = raw.decode("gb18030").replace("交易成功", "交易关闭").encode("gb18030")
    run = workflow.stage(revised, "latest.csv")
    assert not run["error"]
    detail = workflow.detail(run["run_id"])
    assert detail["summary"]["source_observation_count"] == 1
    assert any(a["stage"] == "SOURCE_OBSERVATIONS" for a in detail["artifacts"])
    assert workflow.commit(run["run_id"])["created"] == 0


@pytest.mark.parametrize(
    "provider,old,updates",
    [
        ("alipay", {"settlement": "AWAITING_RECEIPT"}, {"settlement": "COMPLETED"}),
        ("alipay_pouch", {"description": "拿铁"}, {"description": "已退款 - 拿铁"}),
        (
            "wechat",
            {
                "description": "亲属卡交易",
                "counterparty": "家人",
                "payment_hint": "零钱",
            },
            {
                "description": "商户消费 · 订单1",
                "counterparty": "商家",
                "payment_hint": "亲属卡(家人)",
            },
        ),
    ],
)
def test_later_annotations_preserve_facts_but_amount_conflict_stays_visible(
    tmp_path, provider, old, updates
):
    db = Database(tmp_path / "observations.sqlite3")
    db.initialize()
    facts = dict(
        occurred_at="2026-10-01 12:00:00",
        amount_minor=1000,
        currency="CNY",
        flow="OUT",
        settlement="COMPLETED",
        counterparty="店铺",
        description="商品",
        payment_hint="余额",
    )
    facts.update(old)
    with db.write() as session:
        session.add(
            Bill(
                id="existing",
                facts=json.dumps(facts),
                classification="null",
                revision=0,
                saved_at="2026-10-01 12:00:00",
            )
        )
    observed = {**facts, **updates}
    with db.read() as session:
        doc = BillDocument(bills=[dict(id="existing", facts=observed)])
        changes = SourceObservationReconciler.reconcile(session, provider, doc)
        assert len(changes) == 1 and changes[0]["observed"] == observed
        assert doc.bills[0].facts.model_dump() == facts
        conflict = {**observed, "amount_minor": 999}
        doc.bills[0].facts = BillFacts(**conflict)
        assert SourceObservationReconciler.reconcile(session, provider, doc) == []
        assert doc.bills[0].facts.amount_minor == 999
