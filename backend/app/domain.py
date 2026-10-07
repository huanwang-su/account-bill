from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from datetime import datetime
from zoneinfo import ZoneInfo
import json


class DomainError(ValueError):
    pass


class Money:
    MAX = 100_000_000_000_000

    @classmethod
    def parse(cls, value, positive=False):
        try:
            d = Decimal(
                str(value).strip().replace(",", "").replace("¥", "").replace("￥", "")
            )
            if not d.is_finite() or d * 100 != (d * 100).to_integral_value():
                raise DomainError("金额必须精确到分")
            n = int(d * 100)
            if abs(n) > cls.MAX:
                raise DomainError("金额超出范围")
            if positive and n <= 0:
                raise DomainError("金额必须大于零")
            return n
        except (InvalidOperation, TypeError):
            raise DomainError("金额格式不正确")


class Clock:
    @staticmethod
    def now():
        return datetime.now(ZoneInfo("Asia/Shanghai")).strftime("%Y-%m-%d %H:%M:%S")

    @staticmethod
    def normalize(value):
        try:
            d = datetime.fromisoformat(value)
            if d.tzinfo:
                d = d.astimezone(ZoneInfo("Asia/Shanghai"))
            return d.strftime("%Y-%m-%d %H:%M:%S")
        except (ValueError, TypeError):
            raise DomainError("日期格式不正确")


class TagValues:
    @staticmethod
    def encode(values):
        if not isinstance(values, list) or any(
            not isinstance(x, str) or not x.strip() or len(x) > 40 for x in values
        ):
            raise DomainError("标签格式不正确")
        return json.dumps(
            list(dict.fromkeys(x.strip() for x in values)), ensure_ascii=False
        )


@dataclass(frozen=True)
class Posting:
    account_id: int
    amount: int
    category_id: int = None


class Journal:
    def __init__(self, postings):
        self.postings = list(postings)

    def validate(self):
        if len(self.postings) < 2 or any(p.amount == 0 for p in self.postings):
            raise DomainError("交易至少包含两条非零流水")
        if sum(p.amount for p in self.postings) != 0:
            raise DomainError("交易不平衡")
        return self
