"""Explicit, reusable transfer confirmation for one or several source vouchers."""

import json
from .models import (
    Bill,
    BillLedger,
    BillAssociation,
    BillNetting,
    ImportRow,
    Transaction,
)
from .account_config import AccountGraph
from .bill_status import BillStatusService
from .bill_posting import BillPostingService
from .bill_associations import BillAssociationService
from .bills import BillService, BillDocument, BillRecord, BillClassification
from .domain import DomainError


class ConfirmedTransferService:
    def __init__(self, db):
        self.db = db

    def confirm_in(self, s, data):
        key = data["bill_id"]
        note = data.get("note", "")
        if not isinstance(note, str) or not note.strip() or len(note) > 1000:
            raise DomainError("请填写确认转账的依据")
        graph = AccountGraph(s)
        outgoing = graph.funding(data["account_id"])
        incoming = graph.funding(data["to_account_id"])
        if outgoing.id == incoming.id or any(
            not a.active or a.role not in ("ASSET", "LIABILITY")
            for a in (outgoing, incoming)
        ):
            raise DomainError("转出和转入必须是不同的有效资金账户")
        sources = data.get("source_ids", [])
        if (
            not isinstance(sources, list)
            or any(not isinstance(i, str) for i in sources)
            or len(set(sources)) != len(sources)
            or key in sources
        ):
            raise DomainError("凭证编号不能重复")
        primary = s.get(Bill, key)
        link = s.get(BillLedger, key)
        if not primary or not link:
            raise DomainError("请先导入交易明细")
        existing_transaction = None
        if link.status == "POSTED":
            tx = s.get(Transaction, link.transaction_id)
            from .models import Entry

            entries = {
                graph.funding(e.account_id).id: e.amount
                for e in s.query(Entry).filter_by(transaction_id=tx.id)
            }
            amount = json.loads(primary.facts)["amount_minor"]
            if tx.kind == "TRANSFER" and entries == {
                outgoing.id: -amount,
                incoming.id: amount,
            }:
                existing_transaction = tx
                sources = [
                    i
                    for i in sources
                    if not (
                        s.get(BillAssociation, i)
                        and s.get(BillAssociation, i).target_id == key
                    )
                ]
                if not sources:
                    return dict(transaction_id=tx.id, already_confirmed=True)
            else:
                raise DomainError("明细已有不同入账，不能覆盖")
        base = json.loads(primary.facts)
        records = []
        for identity in (sources if existing_transaction else [key, *sources]):
            BillStatusService.require_normal(s, identity)
            bill = s.get(Bill, identity)
            ledger = s.get(BillLedger, identity)
            if (
                not bill
                or not ledger
                or ledger.status != "PENDING"
                or s.get(BillNetting, identity)
            ):
                raise DomainError("转账凭证必须是未入账且未匹配退款的明细")
            if s.query(BillAssociation).filter_by(target_id=identity).first():
                raise DomainError("已有凭证关联，不能覆盖或嵌套关联")
            facts = json.loads(bill.facts)
            if (
                facts["settlement"] != "COMPLETED"
                or facts["flow"] not in ("IN", "OUT")
                or facts["amount_minor"] <= 0
            ):
                raise DomainError("转账凭证必须是已完成的正金额收付款")
            if (
                any(facts[f] != base[f] for f in ("amount_minor", "currency"))
                or facts["occurred_at"][:10] != base["occurred_at"][:10]
            ):
                raise DomainError("转账凭证金额、币种和日期必须一致")
            raw = s.query(ImportRow).filter_by(source_key=identity).first()
            account = json.loads(raw.decision).get("account_id") if raw else None
            expected = outgoing.id if facts["flow"] == "OUT" else incoming.id
            if account and graph.funding(account).id != expected:
                raise DomainError("转账账户与凭证实际收付款账户不一致")
            old = json.loads(bill.classification) or {}
            records.append(
                BillRecord(
                    id=identity,
                    revision=bill.revision,
                    facts=facts,
                    classification=BillClassification(
                        category_path=["资金往来", "内部转账"],
                        tags=old.get("tags", []),
                        status="CLASSIFIED",
                        review_scope="ACCOUNT",
                        note=note,
                        classified_by="Codex·用户确认",
                    ),
                )
            )
        BillService(self.db).save_in_session(
            s, BillDocument(bills=records), allow_new=False
        )
        tx = existing_transaction or BillPostingService(self.db).post_resolved(
            s,
            primary,
            link,
            dict(kind="TRANSFER", account_id=outgoing.id, to_account_id=incoming.id),
        )
        for identity in sources:
            BillAssociationService.publish_link(s, identity, key, "TRANSFER", note)
        return dict(
            transaction_id=tx.id, already_confirmed=existing_transaction is not None
        )

    def confirm(self, data):
        with self.db.write() as s:
            return self.confirm_in(s, data)
