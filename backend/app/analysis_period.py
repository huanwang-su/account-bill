"""Validated inclusive report interval and its equal-length comparison period."""

from datetime import date, timedelta
from .domain import Clock, DomainError


class AnalysisPeriod:
    def __init__(self, start=None, end=None):
        today = Clock.now()[:10]
        try:
            self.end = date.fromisoformat(end or today)
            self.start = date.fromisoformat(
                start or self.end.replace(day=1).isoformat()
            )
            if self.start.isoformat() != (
                start or self.start.isoformat()
            ) or self.end.isoformat() != (end or today):
                raise ValueError()
        except (TypeError, ValueError):
            raise DomainError("日期需为 YYYY-MM-DD") from None
        if self.start > self.end:
            raise DomainError("开始日期不能晚于结束日期")
        self.days = (self.end - self.start).days + 1
        if self.days > 5000:
            raise DomainError("分析区间过长，请缩短至 5000 天以内")
        try:
            self.previous_end = self.start - timedelta(days=1)
            self.previous_start = self.previous_end - timedelta(days=self.days - 1)
        except OverflowError:
            raise DomainError("日期过早，无法计算上期比较") from None


class PeriodSeries:
    @staticmethod
    def values(start, end, grain):
        first, last = date.fromisoformat(start[:10]), date.fromisoformat(end[:10])
        if grain == "month":
            first, last = first.replace(day=1), last.replace(day=1)
        values = []
        while first <= last:
            if len(values) >= 5000:
                raise DomainError("趋势范围过长，请缩短日期范围或切换为按月分析")
            values.append(
                first.isoformat()[:7] if grain == "month" else first.isoformat()
            )
            if first == last:
                break
            first = (
                date(first.year + (first.month == 12), first.month % 12 + 1, 1)
                if grain == "month"
                else first + timedelta(days=1)
            )
        return values
