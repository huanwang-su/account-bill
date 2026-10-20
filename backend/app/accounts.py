import json
from sqlalchemy import func
from .models import Account, Transaction, Entry, Reconciliation
from .domain import DomainError, Money, Clock, Posting
from .account_config import AccountGraph, AccountNamingService
from .models import AccountGroup


from .repository import Repository
from .analysis_settings import AnalysisSettingsService


class AccountService:
    def __init__(self, database):
        self.db = database

    def list(self):
        with self.db.read() as s:
            graph = AccountGraph(s)
            followed_ids = set(AnalysisSettingsService.read_in(s)["single_account_ids"])
            raw, balances = graph.balances(s)
            groups = {g.id: g.name for g in s.query(AccountGroup)}
            return [
                dict(
                    id=a.id,
                    is_followed=a.id in followed_ids,
                    name=a.name,
                    number=a.number,
                    note=a.note,
                    role=a.role,
                    kind=a.kind,
                    tags=json.loads(a.tags),
                    active=a.active and a.merged_into_id is None,
                    **graph.opening_state(a.id),
                    balance=balances.get(a.id, 0) if a.merged_into_id is None else 0,
                    original_balance=raw.get(a.id, 0),
                    merged_into_id=a.merged_into_id,
                    merged_into_name=(
                        graph.canonical(a.id).name if a.merged_into_id else None
                    ),
                    merged_source_ids=(
                        sorted(graph.members(a.id) - {a.id})
                        if not a.merged_into_id
                        else []
                    ),
                    group_id=a.group_id,
                    group_name=groups.get(a.group_id),
                )
                for a in graph.accounts.values()
            ]

    def save(self, data, account_id=None):
        with self.db.write() as s:
            a = Repository(s).require(Account, account_id) if account_id else Account()
            if a.role == "SYSTEM":
                raise DomainError("公共账户不能编辑")
            if a.merged_into_id:
                raise DomainError("该账户已合并，请编辑目标账户或先解除合并")
            name = str(data.get("name", "")).strip()
            if not name or len(name) > 80:
                raise DomainError("请填写 1–80 字的账户名称")
            if (
                s.query(Account)
                .filter(Account.name == name, Account.id != (account_id or 0))
                .first()
            ):
                raise DomainError("账户名称已存在")
            role = data.get("role", "ASSET")
            if role not in ("ASSET", "LIABILITY", "EXTERNAL"):
                raise DomainError("账户角色不正确")
            if data.get("kind") == "证券" and role != "ASSET":
                raise DomainError("证券账户须设置为自有资产")
            if (
                account_id
                and a.role != role
                and s.query(Entry).filter_by(account_id=account_id).first()
            ):
                raise DomainError("已有流水的账户不能变更角色")
            AccountNamingService.rename_in(s, a, name)
            a.number = str(data.get("number", ""))
            note = data.get("note", a.note or "")
            if not isinstance(note, str) or len(note) > 2000:
                raise DomainError("账户备注须为 2000 字以内的文本")
            a.note = note.strip()
            a.role = role
            a.kind = str(data.get("kind", "其他"))
            a.tags = Repository(s).tag_values(data.get("tags", []), "ACCOUNT")
            group_id = data.get("group_id", a.group_id)
            if group_id is not None and not s.get(AccountGroup, int(group_id)):
                raise DomainError("账户组不存在")
            a.group_id = group_id
            a.active = bool(data.get("active", True))
            s.add(a)
            s.flush()
            return {"id": a.id}

    def opening(self, account_id, data):
        with self.db.write() as s:
            a = Repository(s).require(Account, account_id)
            graph = AccountGraph(s)
            if (
                a.merged_into_id
                or a.role == "SYSTEM"
                or any(graph.accounts[i].opening_set for i in graph.members(a.id))
            ):
                raise DomainError("该账户或合并来源已设置期初，或不允许设置期初")
            when = Clock.normalize(data["occurred_at"])
            earliest = (
                s.query(func.min(Transaction.occurred_at))
                .join(Entry, Entry.transaction_id == Transaction.id)
                .filter(Entry.account_id == a.id)
                .scalar()
            )
            if earliest and when > earliest:
                raise DomainError("期初时间不能晚于该账户的最早流水")
            amount = Money.parse(data["amount"])
            if amount:
                system = s.query(Account).filter_by(role="SYSTEM", name="期初").one()
                from .transactions import TransactionService

                TransactionService(self.db)._write(
                    s,
                    {
                        "kind": "OPENING",
                        "occurred_at": when,
                        "note": "设置期初余额",
                        "idempotency_key": "opening:" + str(a.id),
                    },
                    [Posting(a.id, amount), Posting(system.id, -amount)],
                )
            for member in graph.members(a.id):
                graph.accounts[member].opening_set = True
            return {"ok": True}

    def reconcile(self, account_id, data):
        with self.db.write() as s:
            a = Repository(s).require(Account, account_id)
            if a.role == "SYSTEM":
                raise DomainError("公共账户无需对账")
            graph = AccountGraph(s)
            at = Clock.normalize(data["at"])
            actual = Money.parse(data["actual"])
            calculated = (
                s.query(func.coalesce(func.sum(Entry.amount), 0))
                .join(Transaction, Transaction.id == Entry.transaction_id)
                .filter(
                    Entry.account_id.in_(graph.members(account_id)),
                    Transaction.occurred_at <= at,
                )
                .scalar()
            )
            r = Reconciliation(
                account_id=account_id,
                at=at,
                actual=actual,
                calculated=calculated,
                note=data.get("note", ""),
            )
            s.add(r)
            s.flush()
            return {
                "id": r.id,
                "actual": actual,
                "calculated": calculated,
                "difference": actual - calculated,
            }
