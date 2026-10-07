import json
import pytest
from fastapi.testclient import TestClient
from app.bills import BillService, BillNormalizer, BillDocument
from app.database import Database
from app.domain import DomainError
from app.main import LedgerApplication
from app.importers import ImportService, AlipayParser
from app.models import Bill, BillClassificationHistory
from test_ledger import statement


@pytest.fixture
def db(tmp_path):
    db = Database(tmp_path / "bills.sqlite3")
    db.initialize()
    return db


def seed(db):
    ImportService(db).upload(statement(["a", "b"]), "sample.csv")
    service = BillService(db)
    assert service.sync_imports() == 2
    return service


def classify(doc):
    d = doc.model_dump()
    for row in d["bills"]:
        row["classification"] = {
            "category_path": ["支出", "餐饮", "用餐"],
            "tags": ["餐饮"],
            "status": "CLASSIFIED",
            "note": "测试离线分类",
            "classified_by": "Codex",
        }
    return BillDocument.read(json.dumps(d))


def test_normalized_contract_and_idempotent_save(db):
    service = seed(db)
    doc = service.export()
    assert len(doc.bills) == 2
    facts = doc.bills[0].facts.model_dump()
    assert set(facts) == {
        "occurred_at",
        "amount_minor",
        "currency",
        "flow",
        "settlement",
        "counterparty",
        "description",
        "payment_hint",
    }
    assert facts["amount_minor"] == 8000 and facts["flow"] == "OUT"
    assert service.save(classify(doc)) == {"created": 0, "updated": 2, "unchanged": 0}
    assert service.save(classify(doc))["unchanged"] == 2
    assert service.sync_imports() == 0
    assert len(service.list({"tag": "餐饮"})) == 2
    assert len(service.history(doc.bills[0].id)) == 1


def test_immutable_facts_and_atomic_import(db):
    service = seed(db)
    d = classify(service.export()).model_dump()
    d["bills"][1]["facts"]["amount_minor"] = 1
    with pytest.raises(DomainError):
        service.save(BillDocument.read(json.dumps(d)))
    assert all(x["classification"] is None for x in service.list())
    with db.read() as s:
        assert s.query(BillClassificationHistory).count() == 0


def test_stale_file_cannot_overwrite_manual_correction(db):
    service = seed(db)
    old = classify(service.export())
    service.save(old)
    d = service.export().model_dump()
    d["bills"][0]["classification"]["tags"] = ["人工确认"]
    d["bills"][0]["classification"]["classified_by"] = "人工修正"
    service.save(BillDocument.read(json.dumps(d)))
    with pytest.raises(DomainError):
        service.save(old)
    assert len(service.history(d["bills"][0]["id"])) == 2
    # An unclassified old document must not erase persisted classification.
    for b in d["bills"]:
        b["classification"] = None
    service.save(BillDocument.read(json.dumps(d)))
    assert all(x["classification"] for x in service.list())


def test_schema_validation(db):
    service = seed(db)
    d = service.export().model_dump()
    for value in [True, 1.5, -1]:
        bad = json.loads(json.dumps(d))
        bad["bills"][0]["facts"]["amount_minor"] = value
        with pytest.raises(DomainError):
            BillDocument.read(json.dumps(bad))
    d["bills"].append(d["bills"][0])
    with pytest.raises(DomainError):
        BillDocument.read(json.dumps(d))
    d = classify(service.export()).model_dump()
    d["bills"][0]["classification"]["account_id"] = 5
    with pytest.raises(DomainError):
        BillDocument.read(json.dumps(d))


def test_export_and_fresh_database_roundtrip(db, tmp_path):
    service = seed(db)
    service.save(classify(service.export()))
    copy = Database(tmp_path / "copy.sqlite3")
    copy.initialize()
    other = BillService(copy)
    result = other.save(
        BillDocument.read(service.export().model_dump_json()), allow_new=True
    )
    assert result["created"] == 2
    assert all(b["classification_status"] == "CLASSIFIED" for b in other.list())
    assert len(other.list({"category": "支出 / 餐饮 / 用餐"})) == 2


def test_api_offline_pipeline_posts_only_at_commit(tmp_path):
    app = LedgerApplication(tmp_path / "api.sqlite3")
    client = TestClient(app.app)
    h = {"X-Ledger-Client": "local-web"}
    r = client.post(
        "/api/imports",
        files={"file": ("sample.csv", statement(["one"]), "text/csv")},
        headers=h,
    )
    assert r.status_code == 200
    run_id = r.json()["run_id"]
    assert client.get("/api/bills").json() == []
    detail = client.get(f"/api/import-runs/{run_id}").json()
    artifact = next(a for a in detail["artifacts"] if a["stage"] == "NORMALIZED")
    original = client.get(f"/api/import-artifacts/{artifact['id']}").content
    doc = classify(BillDocument.read(original))
    r = client.post(
        f"/api/import-runs/{run_id}/classifications",
        files={"file": ("classified.json", doc.model_dump_json(), "application/json")},
        headers=h,
    )
    assert r.status_code == 200
    assert client.get("/api/bills").json() == []
    assert (
        client.post(f"/api/import-runs/{run_id}/commit", headers=h).status_code == 200
    )
    bills = client.get("/api/bills").json()
    assert bills[0]["classification"]["tags"] == ["餐饮"]
    assert len(client.get("/api/transactions").json()) == 1
    assert bills[0]["ledger_status"] == "POSTED"
    assert client.get("/api/reports/summary").json()["expense"] == 8000
    assert (
        client.get("/api/bills/history", params={"bill_id": bills[0]["id"]}).json()[0][
            "revision"
        ]
        == 1
    )
    bad = doc.model_dump()
    bad["bills"][0]["facts"]["counterparty"] = "changed"
    assert (
        client.post("/api/bills/classifications", json=bad, headers=h).status_code
        == 400
    )


def test_classification_cannot_invent_bill_identity(db):
    service = seed(db)
    d = classify(service.export()).model_dump()
    d["bills"][0]["id"] = "invented"
    with pytest.raises(DomainError):
        service.save(BillDocument.read(json.dumps(d)))
    assert len(service.list()) == 2
