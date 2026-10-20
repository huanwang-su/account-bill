"""Canonical account identities shared by financial and household report scopes."""

import json
from .domain import DomainError


class AccountSelection:
    @staticmethod
    def exclusions(graph, raw):
        try:
            values = json.loads(raw) if isinstance(raw, str) else raw
            if not isinstance(values, list) or any(
                type(key) is not int or key <= 0 for key in values
            ):
                raise ValueError()
        except (ValueError, TypeError):
            raise DomainError("屏蔽账户需为账户编号数组") from None
        result = set()
        for key in values:
            account = graph.canonical(key)
            if account.role == "SYSTEM":
                raise DomainError("只能屏蔽资金账户")
            result.add(account.id)
        return result

    @staticmethod
    def funding_ids(graph, row):
        return {
            graph.canonical(entry["account_id"]).id
            for entry in row["entries"]
            if entry["role"] in ("ASSET", "LIABILITY")
        }
