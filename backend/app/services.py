import json, uuid
from collections import defaultdict
from sqlalchemy import func
from .models import (
    Account,
    Category,
    Tag,
    Transaction,
    Entry,
    Reconciliation,
    SavedReport,
    BillLedger,
    BillJournalHistory,
    TransferMatch,
    BillAssociation,
)
from .domain import DomainError, Money, Clock, TagValues, Journal, Posting
from .account_config import AccountGraph, AccountGroupService
from .models import AccountGroup


class Repository:
    """Shared identity lookup; all writes use the caller's unit of work."""

    def __init__(self, session):
        self.session = session

    def require(self, model, key):
        obj = self.session.get(model, key)
        if obj is None:
            raise DomainError("记录不存在")
        return obj

    def tag_values(self, values, scope):
        encoded = TagValues.encode(values)
        for name in json.loads(encoded):
            tag = self.session.query(Tag).filter_by(name=name).first()
            if tag and tag.scope not in (scope, "BOTH"):
                raise DomainError("标签适用范围不匹配：" + name)
            if not tag:
                self.session.add(Tag(name=name, scope="BOTH"))
        return encoded


class AccountService:
    def __init__(self, database):
        self.db = database

    def list(self):
        with self.db.read() as s:
            graph = AccountGraph(s)
            raw, balances = graph.balances(s)
            groups = {g.id: g.name for g in s.query(AccountGroup)}
            return [
                dict(
                    id=a.id,
                    name=a.name,
                    number=a.number,
                    role=a.role,
                    kind=a.kind,
                    tags=json.loads(a.tags),
                    active=a.active and a.merged_into_id is None,
                    opening_set=any(
                        graph.accounts[i].opening_set for i in graph.members(a.id)
                    ),
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
            if (
                account_id
                and a.role != role
                and s.query(Entry).filter_by(account_id=account_id).first()
            ):
                raise DomainError("已有流水的账户不能变更角色")
            a.name = name
            a.number = str(data.get("number", ""))
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


class CatalogService:
    def __init__(self, database):
        self.db = database

    def categories(self):
        with self.db.read() as s:
            return [
                dict(
                    id=c.id,
                    name=c.name,
                    parent_id=c.parent_id,
                    kind=c.kind,
                    active=c.active,
                )
                for c in s.query(Category).filter_by(merged_into_id=None)
            ]

    def save_category(self, data, category_id=None):
        with self.db.write() as s:
            repo = Repository(s)
            cat = repo.require(Category, category_id) if category_id else Category()
            name = str(data.get("name", "")).strip()
            kind = data.get("kind", "EXPENSE")
            parent = data.get("parent_id")
            if category_id and cat.merged_into_id:
                raise DomainError("分类已归并，请编辑当前分类目录")
            if parent:
                from .category_catalog import CategoryGraph

                proposed_parent = CategoryGraph(s).canonical(parent)
                parent = proposed_parent.id
                if proposed_parent.parent_id:
                    raise DomainError("分类最多支持两级")
                if (
                    category_id
                    and s.query(Category)
                    .filter_by(parent_id=category_id, merged_into_id=None)
                    .first()
                ):
                    raise DomainError("含子项的一级分类不能移入其他分类")

            if not name or kind not in ("EXPENSE", "INCOME"):
                raise DomainError("分类名称或类型不正确")
            if (
                category_id
                and cat.kind != kind
                and (
                    s.query(Entry).filter_by(category_id=category_id).first()
                    or s.query(Category).filter_by(parent_id=category_id).first()
                )
            ):
                raise DomainError("已使用或包含子分类的分类不能改变类型")
            from .taxonomy import CategoryPath

            old_path = CategoryPath.of(s, category_id) if category_id else []
            cursor = parent
            seen = {category_id} if category_id else set()
            while cursor:
                if cursor in seen:
                    raise DomainError("不能将分类移入自身或子分类")
                seen.add(cursor)
                p = repo.require(Category, cursor)
                if p.kind != kind:
                    raise DomainError("父子分类的收支类型必须相同")
                cursor = p.parent_id
            if (
                s.query(Category)
                .filter(
                    Category.name == name,
                    Category.parent_id == parent,
                    Category.kind == kind,
                    Category.id != (category_id or 0),
                )
                .first()
            ):
                raise DomainError("同级分类名称重复")
            cat.name = name
            cat.kind = kind
            cat.parent_id = parent
            cat.active = bool(data.get("active", True))
            s.add(cat)
            s.flush()
            new_path = CategoryPath.of(s, cat.id)
            if old_path and old_path != new_path:
                from .models import Bill, BillClassificationHistory

                for bill in s.query(Bill):
                    labels = json.loads(bill.classification)
                    if labels and labels["category_path"][: len(old_path)] == old_path:
                        labels["category_path"] = (
                            new_path + labels["category_path"][len(old_path) :]
                        )
                        bill.classification = json.dumps(labels, ensure_ascii=False)
                        bill.revision += 1
                        bill.saved_at = Clock.now()
                        s.add(
                            BillClassificationHistory(
                                bill_id=bill.id,
                                revision=bill.revision,
                                classification=bill.classification,
                                saved_at=bill.saved_at,
                            )
                        )
            return {"id": cat.id}

    def tags(self):
        with self.db.read() as s:
            return [
                dict(
                    id=t.id,
                    name=t.name,
                    scope=t.scope,
                    parent_id=t.parent_id,
                    active=t.active,
                )
                for t in s.query(Tag).order_by(Tag.id)
            ]

    def save_tag(self, data, tag_id=None):
        name = str(data.get("name", "")).strip()
        scope = data.get("scope", "BOTH")
        if (
            not name
            or len(name) > 40
            or scope not in ("ACCOUNT", "TRANSACTION", "BOTH")
        ):
            raise DomainError("标签内容不正确")
        with self.db.write() as s:
            from .models import Bill
            from .taxonomy import TagHierarchy

            repo = Repository(s)
            tag = repo.require(Tag, tag_id) if tag_id else Tag()
            if s.query(Tag).filter(Tag.name == name, Tag.id != (tag_id or 0)).first():
                raise DomainError("标签已存在")
            if (
                tag_id
                and tag.name != name
                and (
                    any(tag.name in json.loads(a.tags) for a in s.query(Account))
                    or any(tag.name in json.loads(t.tags) for t in s.query(Transaction))
                    or any(
                        tag.name in (json.loads(b.classification) or {}).get("tags", [])
                        for b in s.query(Bill)
                    )
                )
            ):
                raise DomainError("已使用标签不能改名，可以调整父标签")
            parent = data.get("parent_id") or None
            hierarchy = TagHierarchy(s)
            if parent:
                parent = int(parent)
                ancestor = repo.require(Tag, parent)
                if not ancestor.active:
                    raise DomainError("请先恢复父标签，再添加或移动子标签")
                if tag_id and parent in hierarchy.descendants(tag_id):
                    raise DomainError("不能将标签移入自身或子标签")
                if ancestor.scope != "BOTH" and ancestor.scope != scope:
                    raise DomainError("子标签适用范围不能超出父标签")
            if tag_id and scope != "BOTH":
                descendants = [
                    hierarchy.rows[k] for k in hierarchy.descendants(tag_id) - {tag_id}
                ]
                if any(t.scope not in (scope,) for t in descendants):
                    raise DomainError("父标签适用范围不能小于子标签")
                if (
                    scope == "ACCOUNT"
                    and (
                        any(
                            tag.name in json.loads(t.tags) for t in s.query(Transaction)
                        )
                        or any(
                            tag.name
                            in (json.loads(b.classification) or {}).get("tags", [])
                            for b in s.query(Bill)
                        )
                    )
                ) or (
                    scope == "TRANSACTION"
                    and any(tag.name in json.loads(a.tags) for a in s.query(Account))
                ):
                    raise DomainError("标签已用于其他范围，不能缩小适用范围")
            tag.name, tag.scope, tag.parent_id = name, scope, parent
            s.add(tag)
            s.flush()
            return {"id": tag.id}

    def set_tag_active(self, tag_id, active):
        """Archive/restore a subtree; existing account and bill labels remain intact."""
        if not isinstance(active, bool):
            raise DomainError("标签启用状态必须为布尔值")
        from .taxonomy import TagHierarchy

        with self.db.write() as s:
            root = Repository(s).require(Tag, tag_id)
            hierarchy = TagHierarchy(s)
            if active and root.parent_id and not hierarchy.rows[root.parent_id].active:
                raise DomainError("请先恢复父标签")
            keys = hierarchy.descendants(tag_id)
            for key in keys:
                hierarchy.rows[key].active = active
            return dict(id=tag_id, active=active, count=len(keys))


class TransactionService:
    def __init__(self, database):
        self.db = database

    def _account(self, s, key):
        a = AccountGraph(s).canonical(key)
        if not a.active or a.role == "SYSTEM":
            raise DomainError("请选择启用的普通账户")
        return a

    def _postings(self, s, data):
        kind = data.get("kind")
        a = self._account(s, data.get("account_id"))
        if kind == "TRANSFER":
            b = self._account(s, data.get("to_account_id"))
            if a.id == b.id:
                raise DomainError("转出和转入账户不能相同")
            amount = Money.parse(data.get("amount"), positive=True)
            return [Posting(a.id, -amount), Posting(b.id, amount)]
        if kind not in ("INCOME", "EXPENSE", "REFUND"):
            raise DomainError("不支持的交易类型")
        expected = "INCOME" if kind == "INCOME" else "EXPENSE"
        system = (
            s.query(Account)
            .filter_by(role="SYSTEM", name="收入" if kind == "INCOME" else "消费")
            .one()
        )
        items = data.get("items") or [
            {"amount": data.get("amount"), "category_id": data.get("category_id")}
        ]
        if kind == "REFUND":
            from .bill_posting import BillPostingService

            refund_category = BillPostingService(self.db).category(
                s, "EXPENSE", ["退款"]
            )
            items = [{**item, "category_id": refund_category} for item in items]
        postings = []
        total = 0
        for item in items:
            amount = Money.parse(item.get("amount"), positive=True)
            from .category_catalog import CategoryGraph

            category = CategoryGraph(s).canonical(item.get("category_id"))
            if category.kind != expected or not category.active:
                raise DomainError("请选择正确且启用的收支分类")
            total += amount
            postings.append(
                Posting(
                    system.id, amount if kind == "EXPENSE" else -amount, category.id
                )
            )
        if total > Money.MAX:
            raise DomainError("总金额超出范围")
        postings.append(Posting(a.id, -total if kind == "EXPENSE" else total))
        if kind == "REFUND" and data.get("related_id"):
            original = Repository(s).require(Transaction, data["related_id"])
            if original.kind != "EXPENSE" or original.status != "POSTED":
                raise DomainError("退款只能关联有效支出")
            original_amount = (
                s.query(func.sum(Entry.amount))
                .filter_by(transaction_id=original.id, account_id=system.id)
                .scalar()
                or 0
            )
            refunded = (
                s.query(func.coalesce(func.sum(Entry.amount), 0))
                .join(Transaction, Entry.transaction_id == Transaction.id)
                .filter(
                    Transaction.related_id == original.id,
                    Transaction.kind == "REFUND",
                    Transaction.status == "POSTED",
                    Entry.account_id == system.id,
                )
                .scalar()
            )
            if total > original_amount + refunded:
                raise DomainError("退款合计不能超过原支出")
        return postings

    def _write(self, s, data, postings):
        Journal(postings).validate()
        key = data.get("idempotency_key")
        if not isinstance(key, str) or not key or len(key) > 200:
            raise DomainError("缺少有效的提交编号")
        old = s.query(Transaction).filter_by(idempotency_key=key).first()
        if old:
            return old
        opening_link = None
        if data["kind"] == "OPENING":
            from .bill_posting import BillPostingService

            opening_link = BillPostingService(self.db).prepare_transaction(
                s, data, postings
            )
        tx = Transaction(
            kind=data["kind"],
            occurred_at=Clock.normalize(data["occurred_at"]),
            posted_at=Clock.now(),
            counterparty=str(data.get("counterparty", "")),
            note=str(data.get("note", "")),
            tags=Repository(s).tag_values(data.get("tags", []), "TRANSACTION"),
            idempotency_key=key,
            source=data.get("source", "手动"),
            related_id=data.get("related_id"),
            reversal_of=data.get("reversal_of"),
        )
        s.add(tx)
        s.flush()
        for p in postings:
            s.add(
                Entry(
                    transaction_id=tx.id,
                    account_id=p.account_id,
                    amount=p.amount,
                    category_id=p.category_id,
                )
            )
        s.flush()
        if opening_link:
            BillPostingService(self.db).attach_transaction(s, opening_link, tx)
        return tx

    def post_in(self, s, data):
        old = (
            s.query(Transaction)
            .filter_by(idempotency_key=data.get("idempotency_key"))
            .first()
        )
        if old:
            return old
        from .bill_posting import BillPostingService

        postings = self._postings(s, data)
        service = BillPostingService(self.db)
        link = service.prepare_transaction(s, data, postings)
        tx = self._write(s, data, postings)
        service.attach_transaction(s, link, tx)
        return tx

    def post(self, data):
        data = {k: v for k, v in data.items() if not k.startswith("_")}
        with self.db.write() as s:
            return {"id": self.post_in(s, data).id}

    def _reverse(self, s, tx):
        if tx.status != "POSTED" or tx.kind in ("REVERSAL", "OPENING"):
            raise DomainError("该交易不能撤销")
        if (
            s.query(Transaction)
            .filter_by(related_id=tx.id, kind="REFUND", status="POSTED")
            .first()
        ):
            raise DomainError("请先撤销关联退款")
        postings = [
            Posting(e.account_id, -e.amount, e.category_id)
            for e in s.query(Entry).filter_by(transaction_id=tx.id)
        ]
        reversal = self._write(
            s,
            {
                "kind": "REVERSAL",
                "occurred_at": tx.occurred_at,
                "note": "冲销交易 #" + str(tx.id),
                "idempotency_key": "reverse:" + str(tx.id),
                "reversal_of": tx.id,
            },
            postings,
        )
        tx.status = "REVERSED"
        link = s.query(BillLedger).filter_by(transaction_id=tx.id).first()
        if link:
            link.status = "REVERSED"
            link.reason = "交易已撤销，余额已冲回"
            link.revoked_at = Clock.now()
            from .bill_posting import BillPostingService

            BillPostingService.source_state(s, link.bill_id, "REVERSED", link.reason)
        pair = s.query(TransferMatch).filter_by(transaction_id=tx.id).first()
        if pair:
            mirror = s.get(BillLedger, pair.incoming_id)
            if mirror:
                mirror.status, mirror.reason, mirror.revoked_at = (
                    "REVERSED",
                    "内部转账已撤销，两侧流水已冲回",
                    Clock.now(),
                )
                BillPostingService.source_state(
                    s, mirror.bill_id, "REVERSED", mirror.reason
                )
        if link:
            for association in s.query(BillAssociation).filter_by(
                target_id=link.bill_id
            ):
                secondary = s.get(BillLedger, association.source_id)
                if secondary:
                    secondary.status, secondary.reason, secondary.revoked_at = (
                        "REVERSED",
                        "关联交易已撤销，凭证保留",
                        Clock.now(),
                    )
                    BillPostingService.source_state(
                        s, secondary.bill_id, "REVERSED", secondary.reason
                    )
        return reversal

    def reverse(self, tx_id):
        with self.db.write() as s:
            tx = Repository(s).require(Transaction, tx_id)
            if tx.status == "REVERSED":
                return {"ok": True}
            self._reverse(s, tx)
            return {"ok": True}

    def replace(self, tx_id, data):
        with self.db.write() as s:
            old = (
                s.query(Transaction)
                .filter_by(idempotency_key=data.get("idempotency_key"))
                .first()
            )
            if old:
                return {"id": old.id}
            tx = Repository(s).require(Transaction, tx_id)
            previous = s.query(BillLedger).filter_by(transaction_id=tx.id).first()
            data = {k: v for k, v in data.items() if not k.startswith("_")}
            self._reverse(s, tx)
            data = {
                "_owner_run_id": previous.owner_run_id if previous else None,
                **data,
                "source": tx.source,
                "note": data.get("note", "") + " [修改自 #" + str(tx.id) + "]",
            }
            return {"id": self.post_in(s, data).id}


class ReportService:
    def __init__(self, database):
        self.db = database

    def list(self, filters=None, audit=False):
        f = filters or {}
        with self.db.read() as s:
            query = s.query(Transaction)
            if not audit:
                query = query.filter(
                    Transaction.status == "POSTED", Transaction.kind != "REVERSAL"
                )
            if f.get("start"):
                query = query.filter(
                    Transaction.occurred_at >= Clock.normalize(f["start"])
                )
            if f.get("end"):
                query = query.filter(
                    Transaction.occurred_at
                    <= Clock.normalize(
                        f["end"] + " 23:59:59" if len(f["end"]) == 10 else f["end"]
                    )
                )
            if f.get("kind"):
                query = query.filter(Transaction.kind == f["kind"])
            entries = defaultdict(list)
            for e in s.query(Entry):
                entries[e.transaction_id].append(e)
            graph = AccountGraph(s)
            accounts = {a.id: graph.canonical(a.id) for a in graph.accounts.values()}
            group_scope = (
                AccountGroupService.accounts_in(s, f["group_id"])
                if f.get("group_id")
                else None
            )
            from .taxonomy import TagHierarchy

            tag_tree = TagHierarchy(s)
            from .category_catalog import CategoryGraph

            category_graph = CategoryGraph(s)
            cats = {
                c.id: c
                for c in category_graph.rows.values()
                if c.merged_into_id is None
            }
            descendants = set()
            if f.get("category_id"):
                descendants = {category_graph.canonical(f["category_id"]).id}
                while True:
                    next_ids = descendants | {
                        c.id for c in cats.values() if c.parent_id in descendants
                    }
                    if next_ids == descendants:
                        break
                    descendants = next_ids
            bill_links = {
                l.transaction_id: l.bill_id
                for l in s.query(BillJournalHistory)
                if l.transaction_id
            }
            result = []
            for tx in query.order_by(
                Transaction.occurred_at.desc(), Transaction.id.desc()
            ):
                es = entries[tx.id]
                tags = json.loads(tx.tags)
                if f.get("account_id") and not any(
                    accounts[e.account_id].id == graph.canonical(f["account_id"]).id
                    for e in es
                ):
                    continue
                if group_scope is not None and not any(
                    e.account_id in group_scope for e in es
                ):
                    continue
                if f.get("tag") and not tag_tree.matches(tags, f["tag"]):
                    continue
                if f.get("account_tag") and not any(
                    tag_tree.matches(
                        json.loads(accounts[e.account_id].tags), f["account_tag"]
                    )
                    for e in es
                ):
                    continue
                selected = (
                    [
                        e
                        for e in es
                        if e.category_id
                        and category_graph.canonical(e.category_id).id in descendants
                    ]
                    if descendants
                    else es
                )
                if descendants and not selected:
                    continue
                if (
                    f.get("q")
                    and f["q"].lower()
                    not in (
                        tx.counterparty
                        + " "
                        + tx.note
                        + " "
                        + " ".join(accounts[e.account_id].name for e in es)
                    ).lower()
                ):
                    continue
                public = [
                    e
                    for e in selected
                    if accounts[e.account_id].role == "SYSTEM"
                    and accounts[e.account_id].name in ("消费", "收入")
                ]
                amount = (
                    sum(abs(e.amount) for e in public)
                    if public
                    else sum(e.amount for e in es if e.amount > 0)
                )
                if f.get("min_amount") and amount < Money.parse(f["min_amount"]):
                    continue
                if f.get("max_amount") and amount > Money.parse(f["max_amount"]):
                    continue
                result.append(
                    dict(
                        bill_id=bill_links.get(tx.id) or bill_links.get(tx.reversal_of),
                        id=tx.id,
                        kind=tx.kind,
                        occurred_at=tx.occurred_at,
                        posted_at=tx.posted_at,
                        counterparty=tx.counterparty,
                        note=tx.note,
                        tags=tags,
                        status=tx.status,
                        source=tx.source,
                        related_id=tx.related_id,
                        reversal_of=tx.reversal_of,
                        amount=amount,
                        entries=[
                            dict(
                                account_id=accounts[e.account_id].id,
                                original_account_id=e.account_id,
                                original_account=graph.accounts[e.account_id].name,
                                account=accounts[e.account_id].name,
                                role=accounts[e.account_id].role,
                                amount=e.amount,
                                category_id=(
                                    category_graph.canonical(e.category_id).id
                                    if e.category_id
                                    else None
                                ),
                                original_category_id=e.category_id,
                                category=(
                                    (
                                        "退款"
                                        if tx.kind == "REFUND"
                                        else category_graph.canonical(
                                            e.category_id
                                        ).name
                                    )
                                    if e.category_id
                                    else ""
                                ),
                                selected=(
                                    not descendants
                                    or e.category_id
                                    and category_graph.canonical(e.category_id).id
                                    in descendants
                                ),
                            )
                            for e in es
                        ],
                    )
                )
            return result

    def summary(self, filters=None):
        rows = self.list(filters)
        income = expense = 0
        categories = defaultdict(int)
        months = defaultdict(lambda: {"income": 0, "expense": 0})
        for tx in rows:
            if tx["kind"] not in ("INCOME", "EXPENSE", "REFUND"):
                continue
            value = tx["amount"] * (-1 if tx["kind"] == "REFUND" else 1)
            if tx["kind"] == "INCOME":
                income += value
                months[tx["occurred_at"][:7]]["income"] += value
            else:
                expense += value
                months[tx["occurred_at"][:7]]["expense"] += value
                for e in tx["entries"]:
                    if e["category_id"] and e["selected"]:
                        categories[e["category_id"]] += e["amount"]
        cats = {c["id"]: c for c in CatalogService(self.db).categories()}

        def category_path(key):
            c = cats[key]
            return (
                category_path(c["parent_id"]) + " / " if c["parent_id"] else ""
            ) + c["name"]

        return dict(
            income=income,
            expense=expense,
            net=income - expense,
            count=len(rows),
            categories=[
                dict(id=k, name=category_path(k), value=v)
                for k, v in sorted(categories.items(), key=lambda x: -x[1])
            ],
            months=[dict(month=k, **v) for k, v in sorted(months.items())],
        )

    def integrity(self):
        with self.db.read() as s:
            bad = (
                s.query(Entry.transaction_id)
                .group_by(Entry.transaction_id)
                .having(func.sum(Entry.amount) != 0)
                .all()
            )
            empty = (
                s.query(Transaction)
                .filter(~Transaction.id.in_(s.query(Entry.transaction_id)))
                .count()
            )
            unlinked = (
                s.query(Transaction)
                .outerjoin(
                    BillJournalHistory,
                    BillJournalHistory.transaction_id == Transaction.id,
                )
                .filter(
                    Transaction.kind != "REVERSAL", BillJournalHistory.bill_id == None
                )
                .count()
            )
            return {
                "ok": not bad and not empty and not unlinked,
                "unlinked": unlinked,
                "unbalanced": len(bad),
                "empty": empty,
                "transactions": s.query(Transaction).count(),
                "entries": s.query(Entry).count(),
            }

    def saved(self):
        with self.db.read() as s:
            return [
                dict(id=r.id, name=r.name, filters=json.loads(r.filters))
                for r in s.query(SavedReport)
            ]

    def save(self, data):
        name = str(data.get("name", "")).strip()
        if not name:
            raise DomainError("请填写报表名称")
        with self.db.write() as s:
            r = SavedReport(
                name=name,
                filters=json.dumps(data.get("filters", {}), ensure_ascii=False),
            )
            s.add(r)
            s.flush()
            return {"id": r.id}
