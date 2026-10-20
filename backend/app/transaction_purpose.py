"""Stable business meaning, independent of a transaction's display source text."""

from enum import Enum


class TransactionPurpose(str, Enum):
    GENERAL = "GENERAL"
    VALUATION = "VALUATION"
    OPENING = "OPENING"

    @classmethod
    def from_input(cls, data):
        if data.get("kind") == "OPENING":
            return cls.OPENING.value
        if data.get("_valuation_update"):
            return cls.VALUATION.value
        return cls.GENERAL.value

    @staticmethod
    def is_valuation(row):
        if isinstance(row, dict):
            return row.get("purpose", "GENERAL") == "VALUATION"
        return row.purpose == "VALUATION"
