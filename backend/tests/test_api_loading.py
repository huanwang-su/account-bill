import asyncio
from threading import Event
import pytest
import httpx
from fastapi.testclient import TestClient
from app.main import LedgerApplication


@pytest.fixture
def application(tmp_path):
    app = LedgerApplication(tmp_path / "web.sqlite3")
    yield app
    app.db.engine.dispose()
    app.lease.close()


def test_upload_processing_does_not_block_event_loop(application, monkeypatch):
    started, release = Event(), Event()
    def stage(*args, **kwargs):
        started.set()
        assert release.wait(5)
        return dict(run_id=1)
    monkeypatch.setattr(application.workflow, "stage", stage)
    async def exercise():
        transport = httpx.ASGITransport(app=application.app)
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
            upload = asyncio.create_task(client.post("/api/imports", headers={"X-Ledger-Client":"local-web"}, files={"file":("sample.csv",b"example")}))
            try:
                assert await asyncio.to_thread(started.wait, 3)
                response = await asyncio.wait_for(client.get("/api/health"), 2)
                assert response.json()["ok"]
            finally:
                release.set()
            assert (await upload).json()["run_id"] == 1
    asyncio.run(exercise())


def test_workspace_and_cache_contracts(application):
    client = TestClient(application.app)
    response = client.get("/api/workspace")
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    assert response.json()["pending_bill_count"] == 0
    assert response.json()["revision"]
    assert client.get("/api/transactions?page=0").status_code == 400
    assert client.get("/api/bills?page=1&page_size=201").status_code == 400
    index = client.get("/")
    if index.status_code == 200:
        import re
        asset = re.search(r'src="(/assets/[^"]+)"', index.text).group(1)
        assert client.get(asset).headers["cache-control"] == "public, max-age=31536000, immutable"
        assert index.headers["cache-control"] == "no-store"


def test_split_routes_resolve_command_dependencies(application):
    client = TestClient(application.app)
    headers = {"X-Ledger-Client": "local-web"}
    assert client.post("/api/bills/confirmed-transfer", json={}, headers=headers).status_code == 400
    assert client.post("/api/imports/999/commit", headers=headers).status_code == 400
