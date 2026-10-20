"""Canonical financial accounts and non-overlapping hierarchical ownership groups."""

from sqlalchemy import func
from .domain import Clock, DomainError
from .models import (
    Account,
    AccountGroup,
    AccountMergeEvent,
    Entry,
    AccountAlias,
    Transaction,
)


class AccountGraph:
    WEALTH_KINDS = {"证券", "理财"}

    def __init__(self, session):
        cached = session.info.get("account_graph_rows")
        self.accounts = (
            cached if cached is not None else {a.id: a for a in session.query(Account)}
        )
        if session.info.get("read_only"):
            session.info["account_graph_rows"] = self.accounts
            self.canonical_cache = session.info.setdefault("canonical_accounts", {})
            self.member_cache = session.info.setdefault("account_members", {})
        else:
            self.canonical_cache, self.member_cache = {}, {}
        self.read_only = session.info.get("read_only", False)

    def canonical(self, key):
        key = int(key)
        original = key
        if self.read_only and key in self.canonical_cache:
            return self.canonical_cache[key]
        seen = set()
        while key in self.accounts:
            if key in seen:
                raise DomainError("账户合并配置存在循环")
            seen.add(key)
            account = self.accounts[key]
            if account.merged_into_id is None:
                self.canonical_cache[original] = account
                return account
            key = account.merged_into_id
        raise DomainError("账户不存在")

    def members(self, key):
        target = self.canonical(key).id
        if not self.read_only or target not in self.member_cache:
            self.member_cache[target] = frozenset(a.id for a in self.accounts.values() if self.canonical(a.id).id == target)
        return set(self.member_cache[target])

    def is_composite(self, key):
        target = self.canonical(key)
        members = self.members(target.id)
        return target.role == "ASSET" and (
            any(self.accounts[i].role == "LIABILITY" for i in members)
            or (
                target.kind
                not in self.WEALTH_KINDS | {"支付宝", "微信", "现金", "零钱通"}
                and any(
                    i != target.id and self.accounts[i].kind in self.WEALTH_KINDS
                    for i in members
                )
            )
        )

    def funding(self, key):
        """A net account retains the funding identity of its underlying components."""
        target = self.canonical(key)
        return self.accounts[int(key)] if self.is_composite(target.id) else target

    def opening_state(self, key):
        members = self.members(key)
        missing = sorted(i for i in members if not self.accounts[i].opening_set)
        return dict(
            opening_set=not missing,
            opening_status=(
                "UNSET"
                if len(missing) == len(members)
                else "PARTIAL" if missing else "COMPLETE"
            ),
            missing_opening_member_ids=missing,
        )

    def balances(self, session, as_of=None):
        query = session.query(Entry.account_id, func.sum(Entry.amount))
        if as_of is not None:
            query = query.join(
                Transaction, Transaction.id == Entry.transaction_id
            ).filter(Transaction.occurred_at <= as_of)
        # Keep both original and reversing entries: dropping reversed transactions
        # would count only the reversal and produce the wrong balance.
        raw = dict(query.group_by(Entry.account_id))
        totals = {}
        for key, amount in raw.items():
            canonical = self.canonical(key).id
            totals[canonical] = totals.get(canonical, 0) + amount
        return raw, totals


class AccountNamingService:
    """Display names can change while imported payment identities stay stable."""

    @staticmethod
    def rename_in(session, account, name):
        name = str(name).strip()
        if account.role == "SYSTEM":
            raise DomainError("公共账户不能改名")
        if not name or len(name) > 80:
            raise DomainError("请填写 1–80 字的账户名称")
        if (
            session.query(Account)
            .filter(Account.name == name, Account.id != (account.id or 0))
            .first()
        ):
            raise DomainError("账户名称已存在")
        for label in set(filter(None, [account.name, name])):
            alias = (
                session.query(AccountAlias)
                .filter_by(provider="account-name", owner="", source_name=label)
                .first()
            )
            if alias and alias.account_id != account.id:
                raise DomainError("名称已被其他账户用作导入别名：" + label)
        if account.id and account.name and account.name != name:
            old = (
                session.query(AccountAlias)
                .filter_by(provider="account-name", owner="", source_name=account.name)
                .first()
            )
            if not old:
                session.add(
                    AccountAlias(
                        provider="account-name",
                        owner="",
                        source_name=account.name,
                        account_id=account.id,
                    )
                )
        account.name = name


class AccountGroupService:
    def __init__(self, database):
        self.db = database

    @staticmethod
    def descendants(session, group_id):
        group_id = int(group_id)
        groups = {g.id: g for g in session.query(AccountGroup)}
        if group_id not in groups:
            raise DomainError("账户组不存在")
        seen = {group_id}
        while True:
            more = {g.id for g in groups.values() if g.parent_id in seen} - seen
            if not more:
                return seen
            seen |= more

    @classmethod
    def accounts_in(cls, session, group_id):
        groups = cls.descendants(session, group_id)
        graph = AccountGraph(session)
        return {
            a.id
            for a in graph.accounts.values()
            if graph.canonical(a.id).group_id in groups
            and graph.canonical(a.id).role != "SYSTEM"
        }

    def list(self):
        with self.db.read() as session:
            graph = AccountGraph(session)
            _, balances = graph.balances(session)
            result = []
            for group in session.query(AccountGroup).order_by(AccountGroup.id):
                scope = self.descendants(session, group.id)
                members = [
                    a
                    for a in graph.accounts.values()
                    if a.merged_into_id is None
                    and a.group_id in scope
                    and a.role != "SYSTEM"
                ]
                result.append(
                    dict(
                        id=group.id,
                        name=group.name,
                        parent_id=group.parent_id,
                        account_ids=[a.id for a in members],
                        account_count=len(members),
                        balance=sum(
                            balances.get(a.id, 0)
                            for a in members
                            if a.role in ("ASSET", "LIABILITY")
                        ),
                    )
                )
            return result

    def save(self, data, key=None):
        with self.db.write() as session:
            group = session.get(AccountGroup, key) if key else AccountGroup()
            if group is None:
                raise DomainError("账户组不存在")
            name = str(data.get("name", "")).strip()
            if not name or len(name) > 80:
                raise DomainError("账户组名称需为 1–80 字")
            if (
                session.query(AccountGroup)
                .filter(AccountGroup.name == name, AccountGroup.id != (key or 0))
                .first()
            ):
                raise DomainError("账户组名称重复")
            parent = data.get("parent_id") or None
            if parent:
                if not session.get(AccountGroup, int(parent)):
                    raise DomainError("父账户组不存在")
                if key and int(parent) in self.descendants(session, key):
                    raise DomainError("不能把账户组放入自身或子组")
            group.name, group.parent_id = name, parent
            session.add(group)
            session.flush()
            return dict(id=group.id)

    def assign(self, key, account_ids):
        with self.db.write() as session:
            if key is not None and not session.get(AccountGroup, int(key)):
                raise DomainError("账户组不存在")
            for account_id in account_ids:
                account = session.get(Account, int(account_id))
                if not account or account.role == "SYSTEM" or account.merged_into_id:
                    raise DomainError("只能为普通合并后账户设置所属组")
                account.group_id = key
            return {"assigned": len(account_ids)}


class AccountMergeService:
    def __init__(self, database):
        self.db = database

    @staticmethod
    def validate(session, source_id, target_id):
        graph = AccountGraph(session)
        source, target = session.get(Account, int(source_id)), session.get(
            Account, int(target_id)
        )
        if not source or not target:
            raise DomainError("请选择有效账户")
        if source.id == target.id or source.merged_into_id or target.merged_into_id:
            raise DomainError("只能合并两个不同的未合并账户")
        if source.role == "SYSTEM" or (
            source.role != target.role
            and not (source.role == "LIABILITY" and target.role == "ASSET")
        ):
            raise DomainError(
                "仅同角色账户可合并；信用卡等负债也可并入资产账户按净额汇总，公共账户不能合并"
            )
        if not source.active or not target.active:
            raise DomainError("请先启用需要合并的账户")
        return graph, source, target

    def preview(self, source_id, target_id):
        with self.db.read() as session:
            graph, source, target = self.validate(session, source_id, target_id)
            _, balances = graph.balances(session)
            return dict(
                source_id=source.id,
                target_id=target.id,
                source_name=source.name,
                target_name=target.name,
                source_balance=balances.get(source.id, 0),
                target_balance=balances.get(target.id, 0),
                combined_balance=balances.get(source.id, 0)
                + balances.get(target.id, 0),
                group_id=target.group_id,
                source_members=sorted(graph.members(source.id)),
                target_members=sorted(graph.members(target.id)),
            )

    def merge(self, data):
        with self.db.write() as session:
            source_id, target_id = int(data["source_id"]), int(data["target_id"])
            source = session.get(Account, source_id)
            if source and source.merged_into_id == target_id:
                return {"already_merged": True}
            graph, source, target = self.validate(session, source_id, target_id)
            for account in (source, target):
                alias = (
                    session.query(AccountAlias)
                    .filter_by(
                        provider="account-name", owner="", source_name=account.name
                    )
                    .first()
                )
                if not alias:
                    session.add(
                        AccountAlias(
                            provider="account-name",
                            owner="",
                            source_name=account.name,
                            account_id=account.id,
                        )
                    )
            source.merged_into_id = target.id
            # Funding identity changes; each account retains its own labels.
            session.add(
                AccountMergeEvent(
                    source_id=source.id,
                    target_id=target.id,
                    action="MERGE",
                    created_at=Clock.now(),
                )
            )
            return {"already_merged": False, "target_id": target.id}

    def unmerge(self, source_id):
        with self.db.write() as session:
            source = session.get(Account, int(source_id))
            if not source or source.merged_into_id is None:
                raise DomainError("该账户没有合并配置")
            session.add(
                AccountMergeEvent(
                    source_id=source.id,
                    target_id=source.merged_into_id,
                    action="UNMERGE",
                    created_at=Clock.now(),
                )
            )
            source.merged_into_id = None
            return {"ok": True}

    def history(self):
        with self.db.read() as session:
            accounts = {a.id: a.name for a in session.query(Account)}
            return [
                dict(
                    id=e.id,
                    source_id=e.source_id,
                    target_id=e.target_id,
                    source_name=accounts[e.source_id],
                    target_name=accounts[e.target_id],
                    action=e.action,
                    created_at=e.created_at,
                )
                for e in session.query(AccountMergeEvent).order_by(
                    AccountMergeEvent.id.desc()
                )
            ]
