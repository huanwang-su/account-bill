"""Pair bank mirrors only with reciprocal complete owned account numbers."""

import json
import hashlib
from .models import (
    Bill,
    BillLedger,
    ImportRow,
    TransferMatch,
    BillClassificationHistory,
    Transaction,
    Entry,
    BillNetting,
)
from .account_config import AccountGraph
from .bill_posting import BillPostingService
from .bill_status import BillStatusService
from .domain import Clock


class TransferMatchService:
    def __init__(self, db):
        self.db = db

    def candidates_in(self, s):
        graph = AccountGraph(s)
        records = []
        paired = {
            key
            for p in s.query(TransferMatch)
            for key in (p.outgoing_id, p.incoming_id)
        }
        for link in s.query(BillLedger).filter(
            BillLedger.status.in_(("PENDING", "POSTED"))
        ):
            if link.bill_id in paired or BillStatusService.excluded(s, link.bill_id):
                continue
            row = s.query(ImportRow).filter_by(source_key=link.bill_id).first()
            if not row:
                continue
            raw, decision = json.loads(row.data), json.loads(row.decision)
            account = (
                graph.canonical(decision["account_id"])
                if decision.get("account_id")
                else None
            )
            facts = json.loads(s.get(Bill, link.bill_id).facts)
            if s.get(BillNetting, link.bill_id):
                continue
            if link.status == "POSTED":
                tx = s.get(Transaction, link.transaction_id)
                expected = "EXPENSE" if facts["flow"] == "OUT" else "INCOME"
                if tx.kind != expected:
                    continue
                signed = sum(
                    e.amount
                    for e in s.query(Entry).filter_by(transaction_id=tx.id)
                    if graph.canonical(e.account_id).id
                    == (account.id if account else None)
                )
                if signed != facts["amount_minor"] * (
                    -1 if facts["flow"] == "OUT" else 1
                ):
                    continue
            other_number = raw.get("counterparty_account", "").strip()
            if (
                not account
                or not account.active
                or account.role not in ("ASSET", "LIABILITY")
            ):
                continue
            if (
                not account.number
                or len(other_number) < 12
                or not other_number.isdigit()
            ):
                continue
            if facts["settlement"] != "COMPLETED" or facts["amount_minor"] <= 0:
                continue
            records.append(
                dict(id=link.bill_id, account=account, other=other_number, facts=facts)
            )
        possible = []
        for out in records:
            if out["facts"]["flow"] != "OUT":
                continue
            for incoming in records:
                a, b = out["facts"], incoming["facts"]
                if (
                    b["flow"] == "IN"
                    and out["account"].id != incoming["account"].id
                    and out["other"] == incoming["account"].number
                    and incoming["other"] == out["account"].number
                    and a["currency"] == b["currency"]
                    and a["amount_minor"] == b["amount_minor"]
                    and a["occurred_at"][:10] == b["occurred_at"][:10]
                ):
                    possible.append(
                        dict(
                            outgoing_id=out["id"],
                            incoming_id=incoming["id"],
                            account_id=out["account"].id,
                            to_account_id=incoming["account"].id,
                            amount_minor=a["amount_minor"],
                            occurred_at=a["occurred_at"],
                            note="自有账户完整账号互为对方账号，同日同币种同金额且方向相反",
                        )
                    )
        counts = {}
        for pair in possible:
            for key in (pair["outgoing_id"], pair["incoming_id"]):
                counts[key] = counts.get(key, 0) + 1
        return [
            p
            for p in possible
            if counts[p["outgoing_id"]] == counts[p["incoming_id"]] == 1
        ]

    def auto_in(self, s):
        matched = []
        posting = BillPostingService(self.db)
        for pair in self.candidates_in(s):
            for key in (pair["incoming_id"], pair["outgoing_id"]):
                link = s.get(BillLedger, key)
                if link.status == "POSTED":
                    posting.reverse_in(s, key)
            primary = s.get(BillLedger, pair["outgoing_id"])
            primary.status, primary.transaction_id, primary.revoked_at = (
                "PENDING",
                None,
                None,
            )
            s.flush()
            outgoing = s.get(Bill, pair["outgoing_id"])
            labels = json.loads(outgoing.classification) or dict(tags=[])
            labels.update(
                category_path=["资金往来", "内部转账"],
                status="CLASSIFIED",
                note=pair["note"],
                classified_by="账户转账匹配",
            )
            outgoing.classification = json.dumps(labels, ensure_ascii=False)
            outgoing.revision += 1
            outgoing.saved_at = Clock.now()
            s.add(
                BillClassificationHistory(
                    bill_id=outgoing.id,
                    revision=outgoing.revision,
                    classification=outgoing.classification,
                    saved_at=outgoing.saved_at,
                )
            )
            tx = posting.post_resolved(
                s,
                outgoing,
                s.get(BillLedger, outgoing.id),
                dict(
                    kind="TRANSFER",
                    account_id=pair["account_id"],
                    to_account_id=pair["to_account_id"],
                    _posting_key="internal-transfer:"
                    + hashlib.sha256(
                        (pair["outgoing_id"] + pair["incoming_id"]).encode()
                    ).hexdigest(),
                ),
            )
            s.add(
                TransferMatch(
                    outgoing_id=outgoing.id,
                    incoming_id=pair["incoming_id"],
                    transaction_id=tx.id,
                    note=pair["note"],
                    created_at=Clock.now(),
                )
            )
            from .bill_associations import BillAssociationService

            BillAssociationService.publish_link(
                s,
                pair["incoming_id"],
                outgoing.id,
                "TRANSFER",
                "已关联内部转账；保留转入侧凭证，不重复生成交易明细",
            )
            s.flush()
            matched.append(dict(**pair, transaction_id=tx.id))
        return dict(matched=len(matched), pairs=matched)

    def auto(self):
        with self.db.write() as s:
            return self.auto_in(s)
