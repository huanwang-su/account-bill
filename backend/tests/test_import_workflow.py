import json
import sqlite3
from concurrent.futures import ThreadPoolExecutor
import pytest
from app.bills import BillDocument, BillService
from app.database import Database
from app.domain import DomainError
from app.import_workflow import BillImportWorkflow
from app.importers import ImportService
from app.models import Bill, BillClassificationHistory, Transaction
from test_ledger import statement
from test_bills import classify


@pytest.fixture
def flow(tmp_path):
    db = Database(tmp_path / "workflow.sqlite3")
    db.initialize()
    return BillImportWorkflow(db)


def staged(flow, ids):
    result = flow.stage(statement(ids), "账单.csv")
    assert not result["error"]
    return result["run_id"]


def classify_run(flow, run_id):
    detail = flow.detail(run_id)
    artifact = next(a for a in detail["artifacts"] if a["stage"] == "NORMALIZED")
    return classify(BillDocument.read(flow.download(artifact["id"])[1]))


def prepared(flow, ids):
    run_id = staged(flow, ids)
    content = classify_run(flow, run_id).model_dump_json(indent=2).encode()
    flow.classify(run_id, content, "AI已分类.json")
    return run_id


def test_stages_preserve_exact_bytes_and_wait_for_commit(flow):
    raw = statement(["a", "a", "b"])
    run_id = flow.stage(raw, "原始账单.csv")["run_id"]
    assert flow.bills.list() == []
    detail = flow.detail(run_id)
    assert detail["summary"]["repeated_in_file"] == 1
    assert {a["stage"] for a in detail["artifacts"]} == {"ORIGINAL", "NORMALIZED"}
    assert flow.download(detail["artifacts"][0]["id"])[1] == raw
    classified = classify_run(flow, run_id).model_dump_json(indent=2).encode()
    flow.classify(run_id, classified, "AI已分类.json")
    assert flow.bills.list() == []
    latest = flow.detail(run_id)["artifacts"][-1]
    assert flow.download(latest["id"])[1] == classified
    result = flow.commit(run_id)
    assert result == {
        "created": 2,
        "duplicates": 0,
        "total": 2,
        "already_imported": False,
        "internal_transfers": 0,
        "linked_bills": 0,
        "posted": 2,
        "pending": 0,
        "ignored": 0,
        "ignored_bills": 0,
        "existing": 0,
    }
    assert {b["source_transaction_id"] for b in flow.bills.list()} == {"a", "b"}
    assert flow.commit(run_id)["already_imported"]
    with flow.db.read() as s:
        assert s.query(Transaction).count() == 2
        assert s.query(BillClassificationHistory).count() == 2


def test_repeat_files_overlap_and_manual_edits_are_idempotent(flow):
    first = prepared(flow, ["a", "b"])
    flow.commit(first)
    doc = flow.bills.export().model_dump()
    doc["bills"][0]["classification"]["tags"] = ["人工修正"]
    flow.bills.save(BillDocument.read(json.dumps(doc)))
    before = flow.bills.export().model_dump()
    second = prepared(flow, ["a", "b"])
    assert first != second
    assert flow.commit(second)["duplicates"] == 2
    assert flow.bills.export().model_dump() == before
    third = prepared(flow, ["b", "c"])
    assert flow.commit(third)["created"] == 1
    assert len(flow.bills.list()) == 3
    assert len(flow.list()) == 3
    assert all(len(r["artifacts"]) == 3 for r in flow.list())
    # Pre-upgrade/exported classified files carry saved revisions; known IDs still skip.
    replay = staged(flow, ["a", "b"])
    flow.classify(replay, json.dumps(before).encode(), "历史已分类.json")
    assert flow.commit(replay)["duplicates"] == 2
    assert len(flow.bills.list()) == 3


def test_invalid_identity_facts_partial_and_unclassified_rejected(flow):
    run_id = staged(flow, ["a", "b"])
    original = classify_run(flow, run_id).model_dump()
    mutations = [
        lambda d: d["bills"][0].update(id="invented"),
        lambda d: d["bills"].pop(),
        lambda d: d["bills"][0]["facts"].update(amount_minor=1),
        lambda d: d["bills"][0].update(classification=None),
        lambda d: d["bills"][0].update(revision=9),
    ]
    for mutate in mutations:
        doc = json.loads(json.dumps(original))
        mutate(doc)
        with pytest.raises(DomainError):
            flow.classify(run_id, json.dumps(doc).encode())
    assert len(flow.detail(run_id)["artifacts"]) == 2
    with pytest.raises(DomainError):
        flow.commit(run_id)
    assert flow.bills.list() == []


def test_same_id_changed_facts_conflict_is_atomic(flow):
    flow.commit(prepared(flow, ["a"]))
    before = flow.bills.export().model_dump()
    # A new row preceding the conflict must roll back too.
    raw = (
        statement(["new", "a"])
        .decode("gb18030")
        .replace("80.00", "81.00")
        .encode("utf-8")
    )
    run_id = flow.stage(raw, "changed.csv")["run_id"]
    with pytest.raises(DomainError):
        flow.classify(run_id, classify_run(flow, run_id).model_dump_json().encode())
    assert any(r["conflict"] for r in flow.detail(run_id)["rows"])
    with pytest.raises(DomainError):
        flow.commit(run_id)
    assert flow.bills.export().model_dump() == before
    assert flow.detail(run_id)["error"]
    assert flow.detail(run_id)["status"] == "ERROR"


def test_failed_original_preserved_and_classified_versions_immutable(flow):
    result = flow.stage(b"not a statement", "bad.csv")
    detail = flow.detail(result["run_id"])
    assert detail["status"] == "ERROR"
    assert flow.download(detail["artifacts"][0]["id"])[1] == b"not a statement"
    run_id = prepared(flow, ["a"])
    old = flow.detail(run_id)["artifacts"][-1]
    doc = classify_run(flow, run_id).model_dump()
    doc["bills"][0]["classification"]["tags"] = ["新标签"]
    content = json.dumps(doc).encode()
    flow.classify(run_id, content)
    flow.classify(run_id, content)
    assert len(flow.detail(run_id)["artifacts"]) == 4
    assert "新标签" not in flow.download(old["id"])[1].decode()
    flow.commit(run_id)
    assert flow.bills.list()[0]["classification"]["tags"] == ["新标签"]


def test_restart_pending_and_backup_keep_all_artifacts(flow, tmp_path):
    pending = prepared(flow, ["a"])
    restarted = BillImportWorkflow(flow.db)
    restarted.recover_legacy()
    assert restarted.bills.list() == []
    assert len(restarted.list()) == 1
    backup = tmp_path / "backup.sqlite3"
    flow.db.backup(backup)
    restored = BillImportWorkflow(Database(backup))
    assert restored.detail(pending) == flow.detail(pending)
    for artifact in flow.detail(pending)["artifacts"]:
        assert restored.download(artifact["id"]) == flow.download(artifact["id"])


def test_concurrent_duplicate_commits(flow):
    first, second = prepared(flow, ["a"]), prepared(flow, ["a"])
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(flow.commit, [first, second]))
    assert sum(r["created"] for r in results) == 1
    assert sum(r["duplicates"] for r in results) == 1
    assert len(flow.bills.list()) == 1


def test_legacy_recovery_never_fabricates_original(flow):
    raw = statement(["a"])
    ImportService(flow.db).upload(raw, "legacy.csv")
    service = BillService(flow.db)
    service.sync_imports()
    service.save(classify(service.export()))
    before = service.export().model_dump()
    flow.recover_legacy()
    flow.recover_legacy()
    assert len(flow.list()) == 1
    run = flow.list()[0]
    assert run["status"] == "IMPORTED"
    assert not any(a["stage"] == "ORIGINAL" for a in run["artifacts"])
    assert run["summary"]["legacy"]
    assert service.export().model_dump() == before
    with pytest.raises(DomainError):
        flow.attach_legacy_original(run["id"], b"wrong bytes", "wrong.csv")
    flow.attach_legacy_original(run["id"], raw, "legacy.csv")
    assert len(flow.detail(run["id"])["artifacts"]) == 3
    actual = service.export().model_dump_json(indent=2).encode()
    flow.attach_legacy_classified(run["id"], actual, "原已分类文件.json")
    last = flow.detail(run["id"])["artifacts"][-1]
    assert flow.download(last["id"])[1] == actual
    assert service.export().model_dump() == before


def test_offline_cli_uses_same_staged_workflow(tmp_path):
    from argparse import Namespace
    from bill_tool import BillFileTool

    database = str(tmp_path / "cli.sqlite3")
    source = tmp_path / "source.csv"
    normalized = tmp_path / "normalized.json"
    classified = tmp_path / "classified.json"
    source.write_bytes(statement(["cli-one"]))
    tool = BillFileTool()
    tool.run(
        Namespace(
            database=database,
            command="normalize",
            input=str(source),
            output=str(normalized),
        )
    )
    flow = BillImportWorkflow(Database(database))
    run_id = flow.list()[0]["id"]
    assert flow.bills.list() == []
    classified.write_text(
        classify(BillDocument.read(normalized.read_bytes())).model_dump_json(),
        encoding="utf-8",
    )
    tool.run(
        Namespace(
            database=database, command="save", input=str(classified), run_id=run_id
        )
    )
    assert flow.bills.list() == []
    tool.run(Namespace(database=database, command="commit", run_id=run_id))
    assert len(flow.bills.list()) == 1
    assert len(flow.list()[0]["artifacts"]) == 3
