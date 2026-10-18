"""Attention lists remain visible when off; review queues include old bills."""

from fastapi.testclient import TestClient
from app.main import LedgerApplication
from app.report_scope import ReportAccountScope
from app.services import TransactionService
from test_analysis_settings import configured_ledger
from test_report_defaults import save
from test_import_workflow import classify_run
from test_ledger import statement, payload


def test_exclusion_hints_expose_each_configured_list_even_when_off(configured_ledger):
    db, ids = configured_ledger
    save(db, single_account_ids=[5], single_excluded_account_ids=[6])
    with db.read() as session:
        active = ReportAccountScope(session).projection()
        inactive = ReportAccountScope(
            session,
            dict(exclude_investment_accounts=False, exclude_single_accounts=False),
        ).projection()
    for scope in (active, inactive):
        assert scope["investment_account_ids"] == [ids["wealth"]]
        assert scope["single_excluded_account_ids"] == [6]
    assert inactive["excluded_account_ids"] == []
    assert set(active["excluded_account_ids"]) == {6, ids["wealth"]}


def test_all_date_attention_queue_and_export_include_older_pending_bills(tmp_path):
    app = LedgerApplication(tmp_path / "attention.sqlite3")
    flow = app.workflow
    raw = (
        statement(["old-pending"])
        .decode("gb18030")
        .replace("账户余额", "未知资金账户")
        .encode()
    )
    run = flow.stage(raw, "pending.csv")["run_id"]
    flow.classify(run, classify_run(flow, run).model_dump_json().encode())
    assert flow.commit(run)["pending"] == 1
    # More recent ledger data makes the default month hide the older pending row.
    TransactionService(app.db).post(payload(app.db, occurred_at="2026-10-18 12:00:00"))
    with TestClient(app.app) as client:
        params = dict(ledger_status="PENDING", period="latest_month")
        assert client.get("/api/bills", params=params).json() == []
        params.update(period="all", start="2026-10-01", end="2026-10-31")
        pending = client.get("/api/bills", params=params)
        assert pending.status_code == 200
        assert [row["source_transaction_id"] for row in pending.json()] == [
            "old-pending"
        ]
        export = client.get("/api/bills/export", params=params)
        assert export.status_code == 200
        assert len(export.json()["bills"]) == 1
        # Other analytical pages keep their bounded period contract.
        assert (
            client.get("/api/reports/analysis", params={"period": "all"}).status_code
            == 400
        )
        bill = pending.json()[0]
        response = client.post(
            "/api/bills/resolve",
            json=dict(payload(app.db), bill_id=bill["id"]),
            headers={"X-Ledger-Client": "local-web"},
        )
        assert response.status_code == 200
        assert client.get("/api/bills", params=params).json() == []
        assert client.get("/api/integrity").json()["ok"]
