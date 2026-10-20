"""Reusable, canonical account exclusions for income and expense analysis."""

from .account_config import AccountGraph, AccountGroupService
from .investment_scope import InvestmentScope


class AnalysisAccountScope:
    def __init__(self, session, filters=None, side="income", use_settings=True):
        filters = filters or {}
        self.graph = AccountGraph(session)
        self.wealth_ids = InvestmentScope(self.graph).assets
        raw = filters.get("excluded_account_ids")
        if raw is None:
            if use_settings:
                from .analysis_settings import AnalysisSettingsService

                settings = AnalysisSettingsService.read_in(session)
                self.excluded_ids = set(
                    settings[f"effective_{side}_excluded_account_ids"]
                )
            else:
                self.excluded_ids = set(self.wealth_ids)
        else:
            from .account_selection import AccountSelection

            self.excluded_ids = AccountSelection.exclusions(self.graph, raw)
        self.direct_group = filters.get("direct_group") in (True, "true", "1")
        self.group_id = None
        if self.direct_group and filters.get("group_id") is not None:
            self.group_id = int(filters["group_id"])
            if self.group_id:
                AccountGroupService.accounts_in(session, self.group_id)

    def funding_ids(self, row):
        from .account_selection import AccountSelection

        return AccountSelection.funding_ids(self.graph, row)

    def excludes(self, row):
        return bool(self.funding_ids(row) & self.excluded_ids)

    def allows(self, row):
        ids = self.funding_ids(row)
        return not ids & self.excluded_ids and (
            self.group_id is None
            or any(
                (self.graph.accounts[key].group_id or 0) == self.group_id for key in ids
            )
        )
