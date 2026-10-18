from types import SimpleNamespace
import pytest
from app.database import Database
from app.services import AccountService, ReportService
from app.account_matching import AlipayAccountResolver, StatementAccountResolver
from app.account_config import AccountNamingService
from app.models import Account, AccountAlias, Entry
from app.domain import DomainError


def test_rename_keeps_import_alias_and_wallet_identity(tmp_path):
    db = Database(tmp_path / "db")
    db.initialize()
    service = AccountService(db)
    service.opening(7, dict(amount="100", occurred_at="2026-10-01"))
    before = ReportService(db).summary()
    with db.read() as s:
        entries = [(e.id, e.account_id, e.amount) for e in s.query(Entry)]
    wallet = next(a for a in service.list() if a["id"] == 7)
    service.save({**wallet, "name": "成员甲 · 微信"}, 7)
    with db.read() as s:
        assert AlipayAccountResolver().resolve(s, "", "微信").id == 7
        assert (
            StatementAccountResolver()
            .resolve(s, "wechat", SimpleNamespace(owner=""), {"method": "微信"})
            .id
            == 7
        )
        assert entries == [(e.id, e.account_id, e.amount) for e in s.query(Entry)]
    assert ReportService(db).summary() == before
    with pytest.raises(DomainError, match="别名"):
        service.save(dict(name="微信", kind="微信", role="ASSET"))
    with db.write() as s:
        account = s.get(Account, 7)
        AccountNamingService.rename_in(s, account, "成员甲 · 微信钱包")
    with db.read() as s:
        for old in ("微信", "成员甲 · 微信"):
            assert (
                s.query(AccountAlias)
                .filter_by(provider="account-name", owner="", source_name=old)
                .one()
                .account_id
                == 7
            )
