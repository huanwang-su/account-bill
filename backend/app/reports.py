import json
from collections import defaultdict
from sqlalchemy import func
from .report_context import consistent_read, snapshot_cached
from .models import Transaction, Entry, SavedReport, BillJournalHistory
from .domain import DomainError, Money
from .account_config import AccountGraph, AccountGroupService


from .catalog import CatalogService
from .report_queries import TransactionQuery


class ReportService:
    def __init__(self, database):
        self.db = database

    @snapshot_cached
    def list(self, filters=None, audit=False):
        f = filters or {}
        with self.db.read() as s:
            query = TransactionQuery(s, f, audit).ordered()
            if f.get("_paged"):
                from .report_queries import PageRequest

                query = PageRequest(f).apply(query)
            entries = defaultdict(list)
            candidates = query.with_entities(Transaction.id)
            for e in s.query(Entry).filter(Entry.transaction_id.in_(candidates)):
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
                while f.get("exact_category") not in (True, "true", "1"):
                    next_ids = descendants | {
                        c.id for c in cats.values() if c.parent_id in descendants
                    }
                    if next_ids == descendants:
                        break
                    descendants = next_ids
            bill_links = {
                l.transaction_id: l.bill_id
                for l in s.query(BillJournalHistory).filter(
                    BillJournalHistory.transaction_id.in_(candidates)
                )
                if l.transaction_id
            }
            result = []
            for tx in query:
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
                        purpose=tx.purpose,
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

    @consistent_read
    def page(self, filters=None, audit=False):
        from .report_queries import PageRequest

        f = filters or {}
        page = PageRequest(f)
        with self.db.read() as s:
            total = TransactionQuery(s, f, audit).query.count()
            return dict(
                items=self.list(dict(f, _paged=True), audit),
                total=total,
                page=page.page,
                page_size=page.size,
            )

    def detail(self, transaction_id):
        rows = self.list(dict(transaction_id=transaction_id), audit=True)
        if not rows:
            raise DomainError("交易不存在")
        return rows[0]

    @consistent_read
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
