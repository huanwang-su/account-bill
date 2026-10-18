"""Select configured securities/wealth accounts, independent of income categories."""

from .account_config import AccountGraph


class InvestmentScope:
    ASSET_KINDS = AccountGraph.WEALTH_KINDS

    def __init__(self, graph):
        self.graph = graph
        # Account merges use the target account's configured type. A bank does
        # not become an investment account because it has interest or a fund
        # among its merged sources.
        self.asset_members = {
            a.id: graph.members(a.id)
            for a in graph.accounts.values()
            if not a.merged_into_id and a.role == "ASSET" and a.kind in self.ASSET_KINDS
        }
        self.assets = set(self.asset_members)

    def asset_owner(self, account_id):
        key = self.graph.canonical(account_id).id
        return key if account_id in self.asset_members.get(key, set()) else None

    def options(self):
        return [
            dict(
                id=key,
                name=self.graph.accounts[key].name,
                kind=self.graph.accounts[key].kind,
                active=self.graph.accounts[key].active,
                analysis_mode="ASSET",
            )
            for key in sorted(self.assets)
        ]
