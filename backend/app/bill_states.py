"""Separate lifecycle transitions for source runs and financial postings."""

from enum import Enum
from .domain import Clock, DomainError


class PostingState(str, Enum):
    PENDING = "PENDING"
    POSTED = "POSTED"
    IGNORED = "IGNORED"
    LINKED = "LINKED"
    REVERSED = "REVERSED"


class BillStates:
    RUN_TRANSITIONS = {
        "NORMALIZED": {"CLASSIFIED", "IMPORTED", "CANCELLED"},
        "CLASSIFIED": {"CLASSIFIED", "IMPORTED", "CANCELLED"},
        "IMPORTED": {"CANCELLED"},
        "CANCELLED": set(),
        "ERROR": {"CANCELLED"},
    }

    @classmethod
    def run(cls, run, target):
        if run.status != target and target not in cls.RUN_TRANSITIONS.get(
            run.status, set()
        ):
            raise DomainError("当前导入批次状态不允许执行此操作")
        run.status = target

    @staticmethod
    def posting(link, target, reason=""):
        PostingState(target)
        if link.status == "REVERSED" and target != "REVERSED":
            raise DomainError("已撤销的账单不可直接重新入账")
        link.status, link.reason = target, reason
        if target == "REVERSED":
            link.revoked_at = Clock.now()
