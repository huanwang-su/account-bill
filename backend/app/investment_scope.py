"""Classify investment accounts and explicit investment earnings in ordinary accounts."""

from collections import defaultdict
from .category_catalog import CategoryGraph


class InvestmentScope:
    ASSET_KINDS = {"证券", "理财"}

    def __init__(self, session, graph, transactions, entries):
        self.graph = graph
        self.assets = {
            a.id
            for a in graph.accounts.values()
            if not a.merged_into_id and a.role == "ASSET" and a.kind in self.ASSET_KINDS
        }
        categories = CategoryGraph(session)

        def financial_category(key):
            if not key:
                return False
            row = categories.canonical(key)
            while row.parent_id:
                row = categories.canonical(row.parent_id)
            return (row.kind, row.name) in {
                ("INCOME", "理财收益"),
                ("EXPENSE", "投资亏损"),
            }

        self.returns = {}
        complete_investment_expenses = set()
        for tx in transactions.values():
            if tx.kind != "EXPENSE":
                continue
            public = [
                e
                for e in entries[tx.id]
                if graph.canonical(e.account_id).role == "SYSTEM"
            ]
            if public and all(financial_category(e.category_id) for e in public):
                complete_investment_expenses.add(tx.id)
        for tx in transactions.values():
            if tx.kind not in ("INCOME", "EXPENSE", "REFUND"):
                continue
            owners = defaultdict(int)
            delta = 0
            for entry in entries[tx.id]:
                account = graph.canonical(entry.account_id)
                if account.role == "ASSET":
                    owners[account.id] += entry.amount
                elif account.role == "SYSTEM" and financial_category(entry.category_id):
                    delta -= entry.amount
            if len(owners) != 1:
                continue
            owner, movement = next(iter(owners.items()))
            if tx.kind == "REFUND" and tx.related_id in complete_investment_expenses:
                delta = movement
            if delta and movement * delta > 0 and abs(delta) <= abs(movement):
                self.returns[tx.id] = (owner, delta)
        self.income_only = {key for key, _ in self.returns.values()} - self.assets
        self.accounts = self.assets | self.income_only

    def options(self, include=()):
        return [
            dict(
                id=key,
                name=self.graph.accounts[key].name,
                kind=self.graph.accounts[key].kind,
                active=self.graph.accounts[key].active,
                analysis_mode="ASSET" if key in self.assets else "INCOME_ONLY",
            )
            for key in sorted(self.accounts | set(include))
        ]
