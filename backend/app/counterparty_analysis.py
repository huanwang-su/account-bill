"""Signed account movements grouped by exact counterparty, with valuations separate."""

import re
from .report_context import consistent_read
from .services import ReportService
from .account_config import AccountGraph
from .domain import DomainError


class CounterpartyAnalysisService:
    def __init__(self, db):
        self.db = db

    @consistent_read
    def analyze(self, account_id, filters=None, *, rows=None):
        with self.db.read() as s:
            account = AccountGraph(s).canonical(account_id)
            if account.role not in ("ASSET", "LIABILITY"):
                raise DomainError("请选择自有资金账户")
            key, name = account.id, account.name
        filters = filters or {}
        rows = (
            rows
            if rows is not None
            else ReportService(self.db).list(
                dict(start=filters.get("start"), end=filters.get("end"), account_id=key)
            )
        )
        groups = {}
        for row in rows:
            if row["kind"] == "OPENING":
                continue
            signed = sum(e["amount"] for e in row["entries"] if e["account_id"] == key)
            if not signed:
                continue
            party = re.sub(r"\s+", " ", row["counterparty"]).strip()
            if not party and row["kind"] == "TRANSFER":
                party = "、".join(
                    sorted(
                        {
                            e["account"]
                            for e in row["entries"]
                            if e["account_id"] != key and e["role"] != "SYSTEM"
                        }
                    )
                )
            party = party or "未填写交易方"
            valuation = row.get("purpose") == "VALUATION"
            if (
                filters.get("q")
                and filters["q"].strip().casefold() not in party.casefold()
            ):
                continue
            group_key = (valuation, party)
            group = groups.setdefault(
                group_key,
                dict(
                    key=("valuation:" if valuation else "party:") + party,
                    counterparty=party,
                    valuation=valuation,
                    incoming=0,
                    outgoing=0,
                    count=0,
                    incoming_count=0,
                    outgoing_count=0,
                    transactions=[],
                ),
            )
            group["incoming"] += max(signed, 0)
            group["outgoing"] += max(-signed, 0)
            group["count"] += 1
            group["incoming_count"] += signed > 0
            group["outgoing_count"] += signed < 0
            group["transactions"].append(dict(**row, account_change=signed))
        result = []
        for group in groups.values():
            group["net"] = group["incoming"] - group["outgoing"]
            dates = [r["occurred_at"] for r in group["transactions"]]
            group["first_at"], group["last_at"] = min(dates), max(dates)
            result.append(group)
        parties = sorted(
            (r for r in result if not r["valuation"]),
            key=lambda r: (-r["count"], r["counterparty"]),
        )
        valuations = [r for r in result if r["valuation"]]
        incoming = sum(r["incoming"] for r in parties)
        outgoing = sum(r["outgoing"] for r in parties)
        return dict(
            account_id=key,
            account_name=name,
            incoming=incoming,
            outgoing=outgoing,
            net=incoming - outgoing,
            count=sum(r["count"] for r in parties),
            party_count=len(parties),
            valuation_gain=sum(r["incoming"] for r in valuations),
            valuation_loss=sum(r["outgoing"] for r in valuations),
            valuation_net=sum(r["net"] for r in valuations),
            valuation_count=sum(r["count"] for r in valuations),
            parties=parties,
            valuations=valuations,
        )
