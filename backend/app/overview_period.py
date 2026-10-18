"""The dashboard starts at the month containing the latest recorded activity."""

import calendar
from datetime import date, timedelta
from sqlalchemy import func
from .models import Transaction
from .domain import Clock, DomainError
from .expense_analysis import AnalysisPeriod


class OverviewPeriod:
    def __init__(self, db, filters=None):
        filters = filters or {}
        with db.read() as session:
            latest = (
                session.query(func.max(Transaction.occurred_at))
                .filter(
                    Transaction.status == "POSTED",
                    Transaction.kind.in_(("INCOME", "EXPENSE", "REFUND", "TRANSFER")),
                )
                .scalar()
            )
        self.latest = latest[:10] if latest else None
        anchor = date.fromisoformat(self.latest or Clock.now()[:10])
        self.preset = filters.get("period") or (
            "custom" if filters.get("start") or filters.get("end") else "latest_month"
        )
        if self.preset == "custom":
            if not filters.get("start") or not filters.get("end"):
                raise DomainError("指定区间需要开始和结束日期")
            period = AnalysisPeriod(filters["start"], filters["end"])
        elif self.preset == "latest_month":
            period = AnalysisPeriod(
                anchor.replace(day=1).isoformat(),
                anchor.replace(
                    day=calendar.monthrange(anchor.year, anchor.month)[1]
                ).isoformat(),
            )
        elif self.preset in ("1m", "3m", "6m", "1y"):
            months = {"1m": 1, "3m": 3, "6m": 6, "1y": 12}[self.preset]
            index = anchor.year * 12 + anchor.month - 1 - months
            year, month = divmod(index, 12)
            lower = date(
                year,
                month + 1,
                min(anchor.day, calendar.monthrange(year, month + 1)[1]),
            ) + timedelta(days=1)
            period = AnalysisPeriod(lower.isoformat(), anchor.isoformat())
        else:
            raise DomainError("请选择有效的统计时间范围")
        self.start, self.end = period.start, period.end

    def projection(self):
        return dict(
            start=self.start.isoformat(),
            end=self.end.isoformat(),
            preset=self.preset,
            latest_data_date=self.latest,
        )
