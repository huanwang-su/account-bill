"""Reusable, canonical account exclusions for income and expense analysis."""

import json
from .account_config import AccountGraph, AccountGroupService
from .investment_scope import InvestmentScope
from .domain import DomainError


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
            try:
                values = json.loads(raw) if isinstance(raw, str) else raw
                if not isinstance(values, list) or any(
                    type(v) is not int or v <= 0 for v in values
                ):
                    raise ValueError()
            except (TypeError, ValueError):
                raise DomainError("屏蔽账户需为账户编号数组") from None
            self.excluded_ids = set()
            for key in values:
                account = self.graph.canonical(key)
                if account.role == "SYSTEM":
                    raise DomainError("只能屏蔽资金账户")
                self.excluded_ids.add(account.id)
        self.direct_group = filters.get("direct_group") in (True, "true", "1")
        self.group_id = None
        if self.direct_group and filters.get("group_id") is not None:
            self.group_id = int(filters["group_id"])
            if self.group_id:
                AccountGroupService.accounts_in(session, self.group_id)

    def funding_ids(self, row):
        return {
            self.graph.canonical(e["account_id"]).id
            for e in row["entries"]
            if e["role"] in ("ASSET", "LIABILITY")
        }

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
