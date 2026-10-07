import json
import pytest
from app.database import Database
from app.account_matching import AlipayAccountResolver
from app.importers import ImportService
from app.bills import BillService
from app.models import Account, AccountAlias, ImportRow, Transaction
from test_ledger import statement

@pytest.fixture
def db(tmp_path):
    db = Database(tmp_path / 'pouch.sqlite3')
    db.initialize()
    return db


def test_identity_survives_rename_and_discounts(db):
    resolver = AlipayAccountResolver()
    with db.write() as s:
        a = resolver.resolve(s, 'owner', '支付宝小荷包(??????恋爱小金库)')
        assert a.name == '小荷包（恋爱小金库）'
        assert a.role == 'ASSET' and not a.opening_set
        a.name = '我们的共同账户'
        for suffix in resolver.DISCOUNTS:
            assert resolver.resolve(s, 'owner', '支付宝小荷包(??????恋爱小金库)&' + suffix).id == a.id
        assert resolver.resolve(s, 'owner', '支付宝小荷包(旅行基金)').id != a.id
        assert resolver.resolve(s, 'other-owner', '支付宝小荷包(??????恋爱小金库)').id != a.id
        assert s.query(AccountAlias).count() == 3


def test_mixed_payment_and_inactive_account_not_assumed(db):
    resolver = AlipayAccountResolver()
    with db.write() as s:
        for method in ['支付宝小荷包(家用)&余额宝', '支付宝小荷包(家用)&未知优惠']:
            assert resolver.resolve(s, 'owner', method) is None
        assert s.query(AccountAlias).count() == 0
        a = resolver.resolve(s, 'owner', '支付宝小荷包(家用)')
        a.active = False
        assert resolver.resolve(s, 'owner', '支付宝小荷包(家用)') is None
        assert s.query(AccountAlias).count() == 1


def pouch_statement(ids):
    return statement(ids).decode('gb18030').replace('账户余额', '支付宝小荷包(家用)&支付立减优惠').encode('utf-8')


def test_upload_and_backfill_preserve_decisions_and_financial_data(db):
    imports = ImportService(db)
    batch = imports.upload(pouch_statement(['a', 'b']), 'a.csv')
    rows = imports.rows(batch['id'])
    assert all(r['status'] == 'REVIEW' for r in rows)
    with db.write() as s:
        rows = s.query(ImportRow).order_by(ImportRow.id).all()
        pouch_id = json.loads(rows[0].decision)['account_id']
        rows[0].decision = '{}'
        rows[0].warning += '；请选择实际收付款账户'
        other = s.query(Account).filter_by(name='现金').one()
        rows[1].decision = json.dumps({'account_id': other.id})
    bills = BillService(db)
    bills.sync_imports()
    before = bills.export().model_dump()
    assert imports.link_existing_pouches() == 1
    assert imports.link_existing_pouches() == 0
    assert bills.export().model_dump() == before
    with db.read() as s:
        rows = s.query(ImportRow).order_by(ImportRow.id).all()
        assert json.loads(rows[0].decision)['account_id'] == pouch_id
        assert json.loads(rows[1].decision)['account_id'] == other.id
        assert '请选择实际收付款账户' not in rows[0].warning
        assert all(r.status == 'REVIEW' for r in rows)
        assert s.query(Transaction).count() == 0
    assert {r['account_name'] for r in bills.list()} == {'小荷包（家用）', '现金'}
