import json
from pathlib import Path
import pytest
from app.bill_status import BillStatusService
from app.bills import BillDocument
from app.database import Database
from app.domain import DomainError
from app.import_workflow import BillImportWorkflow
from app.models import Bill, BillLedger, Entry, ImportRow, Transaction
from app.services import AccountService, ReportService
from test_ledger import statement
from test_import_workflow import classify_run, prepared


@pytest.fixture
def flow(tmp_path):
    db = Database(tmp_path / 'ignored.sqlite3')
    db.initialize()
    return BillImportWorkflow(db)


def uncounted(ids):
    return statement(ids).decode('gb18030').replace('支出,80.00','不计收支,80.00').encode()


def test_ignored_rows_persist_in_bill_files_without_details_or_journals(flow):
    run = flow.stage(uncounted(['one']), 'ignored.csv')['run_id']
    detail = flow.detail(run)
    assert detail['rows'][0]['bill_status'] == 'IGNORED'
    assert detail['ignored_bill_count'] == 1 and detail['active_bill_count'] == 0
    assert detail['summary']['ignored_bill_count'] == 1
    normalized = next(a for a in detail['artifacts'] if a['stage'] == 'NORMALIZED')
    assert json.loads(flow.download(normalized['id'])[1])['bills'][0]['bill_status'] == 'IGNORED'
    # An all-ignored statement needs no AI classification.
    result = flow.commit(run)
    assert result['ignored_bills'] == 1 and result['created'] == result['posted'] == 0
    assert flow.bills.list() == []
    with flow.db.read() as s:
        assert s.query(Bill).count() == s.query(Transaction).count() == s.query(Entry).count() == 0
        row = s.query(ImportRow).one()
        assert row.status == 'IGNORED'
    with pytest.raises(DomainError):
        flow.imports.decide(row.id, {'kind':'EXPENSE','account_id':5,'category_id':1,'amount':'80'})
    assert flow.cancel(run)['reversed_details'] == 0


def test_mixed_document_only_active_rows_require_classification(flow):
    raw = statement(['active', 'ignored']).decode('gb18030')
    lines = raw.splitlines()
    lines[-1] = lines[-1].replace('支出,80.00','不计收支,80.00')
    run = flow.stage(('\n'.join(lines)+'\n').encode(), 'mixed.csv')['run_id']
    doc = classify_run(flow, run).model_dump()
    for r in doc['bills']:
        if r['bill_status'] == 'IGNORED': r['classification'] = None
    flow.classify(run, json.dumps(doc).encode())
    result = flow.commit(run)
    assert result['created'] == result['posted'] == result['ignored_bills'] == 1
    assert len(flow.bills.list()) == 1
    assert ReportService(flow.db).summary()['expense'] == 8000
    assert len(flow.detail(run)['rows']) == 2


def test_ai_cannot_override_bill_routing_and_old_file_is_supported(flow):
    run = flow.stage(uncounted(['one']), 'ignored.csv')['run_id']
    doc = classify_run(flow, run).model_dump()
    doc['bills'][0]['bill_status'] = 'NORMAL'
    with pytest.raises(DomainError, match='账单状态'):
        flow.classify(run, json.dumps(doc).encode())
    # Pre-upgrade JSON lacked the field: server-side source policy still wins.
    del doc['bills'][0]['bill_status']
    flow.classify(run, json.dumps(doc).encode())
    assert flow.commit(run)['created'] == 0
    assert flow.bills.list() == []


def test_existing_posting_reversed_and_archived_atomically(flow):
    run = prepared(flow, ['historical'])
    flow.commit(run)
    bill_id = flow.bills.list()[0]['id']
    # Simulate a record posted under v0.4's uncounted-direction policy.
    with flow.db.write() as s:
        row = s.query(ImportRow).one()
        data = json.loads(row.data)
        data['direction'] = '不计收支'
        row.data = json.dumps(data)
        bill = s.get(Bill, bill_id)
        facts = json.loads(bill.facts); facts['flow'] = 'UNSPECIFIED'
        bill.facts = json.dumps(facts)
        before = bill.facts, bill.classification, bill.revision
    policy = BillStatusService(flow.db)
    assert policy.apply_existing() == 1
    assert policy.apply_existing() == 0
    assert flow.bills.list() == [] and flow.bills.export().bills == []
    assert all(a['balance'] == 0 for a in AccountService(flow.db).list())
    assert ReportService(flow.db).integrity()['ok']
    with flow.db.read() as s:
        bill = s.get(Bill, bill_id)
        assert (bill.facts, bill.classification, bill.revision) == before
        assert s.query(Bill).count() == 1  # Audit preserved, not hard-deleted.
        assert s.get(BillLedger, bill_id).status == 'REVERSED'
        assert s.query(Transaction).count() == 2
    with pytest.raises(DomainError): flow.posting.resolve(bill_id, {})
    replay = flow.stage(uncounted(['historical']), 'repeat.csv')['run_id']
    assert flow.commit(replay)['created'] == 0
    assert flow.bills.list() == []
