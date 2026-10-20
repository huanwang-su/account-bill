"""One filter definition for exports, detail lookup and database pagination."""

import json
from sqlalchemy import case, func, select
from .models import Transaction, Entry
from .account_config import AccountGraph, AccountGroupService
from .category_catalog import CategoryGraph
from .taxonomy import TagHierarchy
from .domain import Clock, DomainError, Money


class TransactionQuery:
    SORTS = {"occurred_at", "posted_at", "amount", "kind", "counterparty", "status"}

    def __init__(self, session, filters=None, audit=False):
        self.session, self.filters = session, filters or {}
        f = self.filters
        graph = AccountGraph(session)
        query = session.query(Transaction)
        if not audit:
            query = query.filter(
                Transaction.status == "POSTED", Transaction.kind != "REVERSAL"
            )
        for field, op in (("start", ">="), ("end", "<=")):
            if f.get(field):
                value = str(f[field])
                value = Clock.normalize(
                    value + " 23:59:59"
                    if field == "end" and len(value) == 10
                    else value
                )
                query = query.filter(
                    Transaction.occurred_at >= value
                    if op == ">="
                    else Transaction.occurred_at <= value
                )
        for field in ("kind", "transaction_id"):
            if f.get(field):
                query = query.filter(
                    getattr(Transaction, "id" if field == "transaction_id" else field)
                    == f[field]
                )

        def entries_in(ids):
            return select(Entry.transaction_id).where(Entry.account_id.in_(ids))

        if f.get("account_id"):
            query = query.filter(
                Transaction.id.in_(entries_in(graph.members(f["account_id"])))
            )
        if f.get("group_id"):
            query = query.filter(
                Transaction.id.in_(
                    entries_in(AccountGroupService.accounts_in(session, f["group_id"]))
                )
            )
        tags = TagHierarchy(session)
        if f.get("tag"):
            values = func.json_each(Transaction.tags).table_valued("value")
            query = query.filter(
                select(1)
                .select_from(values)
                .where(values.c.value.in_(tags.names(f["tag"])))
                .exists()
            )
        if f.get("account_tag"):
            ids = [
                key
                for key in graph.accounts
                if tags.matches(json.loads(graph.canonical(key).tags), f["account_tag"])
            ]
            query = query.filter(Transaction.id.in_(entries_in(ids)))
        categories = CategoryGraph(session)
        descendants = set()
        if f.get("category_id"):
            descendants.add(categories.canonical(f["category_id"]).id)
            if f.get("exact_category") not in (True, "true", "1"):
                while True:
                    more = {
                        c.id
                        for c in categories.rows.values()
                        if c.parent_id in descendants
                    } - descendants
                    if not more:
                        break
                    descendants |= more
            originals = {
                key
                for key in categories.rows
                if categories.canonical(key).id in descendants
            }
            query = query.filter(
                Transaction.id.in_(
                    select(Entry.transaction_id).where(Entry.category_id.in_(originals))
                )
            )
        if f.get("q"):
            text = str(f["q"]).lower()
            accounts = [
                key
                for key in graph.accounts
                if text in graph.canonical(key).name.lower()
            ]
            query = query.filter(
                func.lower(Transaction.counterparty + " " + Transaction.note).contains(
                    text, autoescape=True
                )
                | Transaction.id.in_(entries_in(accounts))
            )
        system = [
            key
            for key in graph.accounts
            if graph.canonical(key).role == "SYSTEM"
            and graph.canonical(key).name in ("消费", "收入")
        ]
        public = Entry.account_id.in_(system)
        if descendants:
            public = public & Entry.category_id.in_(originals)
        amounts = (
            session.query(
                Entry.transaction_id.label("id"),
                func.coalesce(
                    func.sum(case((public, func.abs(Entry.amount)), else_=None)),
                    func.sum(case((Entry.amount > 0, Entry.amount), else_=0)),
                ).label("amount"),
            )
            .group_by(Entry.transaction_id)
            .subquery()
        )
        query = query.join(amounts, amounts.c.id == Transaction.id)
        for field in ("min_amount", "max_amount"):
            if f.get(field):
                value = Money.parse(f[field])
                query = query.filter(
                    amounts.c.amount >= value
                    if field == "min_amount"
                    else amounts.c.amount <= value
                )
        self.query, self.amount = query, amounts.c.amount

    def ordered(self):
        field = self.filters.get("sort", "occurred_at")
        if field not in self.SORTS:
            raise DomainError("不支持的排序字段")
        ascending = self.filters.get("order") in ("asc", "ascend")
        column = self.amount if field == "amount" else getattr(Transaction, field)
        return self.query.order_by(
            column.asc() if ascending else column.desc(),
            Transaction.id.asc() if ascending else Transaction.id.desc(),
        )


class PageRequest:
    def __init__(self, filters):
        try:
            self.page = int(filters.get("page", 1))
            self.size = int(filters.get("page_size", 25))
        except (TypeError, ValueError):
            raise DomainError("分页参数必须为整数")
        if self.page < 1 or not 1 <= self.size <= 200:
            raise DomainError("页码须大于零，每页最多 200 条")

    def apply(self, query):
        return query.offset((self.page - 1) * self.size).limit(self.size)
