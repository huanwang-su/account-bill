"""Explicit account filters shared by dashboards, balances and cash-flow reports."""

import json
from .account_config import AccountGraph
from .analysis_settings import AnalysisSettingsService
from .investment_scope import InvestmentScope
from .domain import DomainError


class ReportAccountScope:
    FIELDS = (
        "exclude_investment_accounts",
        "exclude_single_accounts",
        "excluded_account_ids",
    )

    @classmethod
    def active(cls, filters):
        return any(filters.get(key) is not None for key in cls.FIELDS)

    @staticmethod
    def boolean(value, default=False):
        if value is None:
            return default
        if value in (True, "true", "1"):
            return True
        if value in (False, "false", "0"):
            return False
        raise DomainError("账户屏蔽开关须为 true 或 false")

    def __init__(self, session, filters=None):
        filters = filters or {}
        self.graph = AccountGraph(session)
        self.config = AnalysisSettingsService.read_in(session)
        self.exclude_wealth = self.boolean(
            filters.get("exclude_investment_accounts"),
            self.config["exclude_investment_accounts"],
        )
        self.exclude_singles = self.boolean(
            filters.get("exclude_single_accounts"),
            self.config["exclude_single_accounts"],
        )
        raw = filters.get("excluded_account_ids", [])
        try:
            values = json.loads(raw) if isinstance(raw, str) else raw
            if not isinstance(values, list) or any(
                type(key) is not int or key <= 0 for key in values
            ):
                raise ValueError()
        except (ValueError, TypeError):
            raise DomainError("屏蔽账户需为账户编号数组") from None
        self.specified = set(
            AnalysisSettingsService.normalize(self.graph, values, strict=True)
        )
        self.excluded_ids = set(self.specified)
        if self.exclude_wealth:
            self.excluded_ids |= InvestmentScope(self.graph).assets
        if self.exclude_singles:
            self.excluded_ids |= set(self.config["single_excluded_account_ids"])

    def allows(self, row):
        return not any(
            self.graph.canonical(entry["account_id"]).id in self.excluded_ids
            for entry in row["entries"]
            if entry["role"] in ("ASSET", "LIABILITY")
        )

    def projection(self):
        return dict(
            exclude_investment_accounts=self.exclude_wealth,
            exclude_single_accounts=self.exclude_singles,
            investment_account_ids=sorted(InvestmentScope(self.graph).assets),
            single_excluded_account_ids=self.config["single_excluded_account_ids"],
            specified_excluded_account_ids=sorted(self.specified),
            excluded_account_ids=sorted(self.excluded_ids),
        )

    def resolved_filters(self, filters=None):
        return dict(
            filters or {}, excluded_account_ids=json.dumps(sorted(self.excluded_ids))
        )
