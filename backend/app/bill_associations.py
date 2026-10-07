"""One economic event, several immutable source vouchers, one active journal."""

import json
from .models import (
    Bill,
    BillLedger,
    BillAssociation,
    BillDisposition,
    BillNetting,
    ImportRow,
    ImportBatch,
    ImportSource,
    Entry,
    Transaction,
)
from .bill_status import BillStatusService
from .account_config import AccountGraph
from .domain import DomainError, Clock


class BillAssociationService:
    def __init__(self, db):
        self.db = db

    @staticmethod
    def publish_link(s, source_id, target_id, kind, note):
        s.add(
            BillAssociation(
                source_id=source_id,
                target_id=target_id,
                kind=kind,
                note=note,
                created_at=Clock.now(),
            )
        )
        state = s.get(BillDisposition, source_id)
        if not state:
            state = BillDisposition(source_key=source_id)
            s.add(state)
        state.status, state.reason, state.changed_at = "LINKED", note, Clock.now()
        ledger = s.get(BillLedger, source_id)
        if ledger:
            ledger.status, ledger.reason = "LINKED", note
        for row in s.query(ImportRow).filter_by(source_key=source_id):
            row.status, row.warning = "LINKED", note
        s.flush()
        BillAssociationService.sync_sources(s, target_id)

    @staticmethod
    def sync_sources(s, target_id):
        link = s.get(BillLedger, target_id)
        if not link or not link.transaction_id or link.status != "POSTED":
            return
        for association in s.query(BillAssociation).filter_by(target_id=target_id):
            for row in s.query(ImportRow).filter_by(source_key=association.source_id):
                row.transaction_id = link.transaction_id
                old = s.get(ImportSource, row.source_key)
                if old:
                    old.transaction_id = link.transaction_id
                else:
                    s.add(
                        ImportSource(
                            key=row.source_key,
                            transaction_id=link.transaction_id,
                            row_id=row.id,
                        )
                    )

    def candidates_in(self, s, bill_id):
        graph = AccountGraph(s)

        def event(key):
            bill = s.get(Bill, key)
            ledger = s.get(BillLedger, key)
            raw = s.query(ImportRow).filter_by(source_key=key).first()
            if (
                not bill
                or not raw
                or not ledger
                or ledger.status not in ("PENDING", "POSTED")
                or BillStatusService.excluded(s, key)
            ):
                return None
            facts = json.loads(bill.facts)
            data = json.loads(raw.data)
            decision = json.loads(raw.decision)
            account = (
                graph.canonical(decision["account_id"])
                if decision.get("account_id")
                else None
            )
            if (
                not account
                or account.role not in ("ASSET", "LIABILITY")
                or not account.active
            ):
                return None
            net = s.get(BillNetting, key)
            amount = net.net_minor if net else facts["amount_minor"]
            if (
                facts["flow"] != "OUT"
                or facts["settlement"] != "COMPLETED"
                or amount <= 0
            ):
                return None
            if ledger.status == "POSTED":
                tx = s.get(Transaction, ledger.transaction_id)
                signed = sum(
                    e.amount
                    for e in s.query(Entry).filter_by(transaction_id=tx.id)
                    if graph.canonical(e.account_id).id == account.id
                )
                if tx.kind != "EXPENSE" or signed != -amount:
                    return None
            provider = json.loads(s.get(ImportBatch, raw.batch_id).metadata_json).get(
                "parser"
            )
            return dict(
                id=key,
                facts=facts,
                amount=amount,
                account=account.id,
                provider=provider,
                raw=data,
                status=ledger.status,
            )

        source = event(bill_id)
        if (
            not source
            or source["provider"] != "wechat"
            or not source["raw"].get("review_reason")
            or "银行" not in source["facts"]["payment_hint"]
        ):
            return []
        result = []
        used_bank_targets = {
            a.target_id for a in s.query(BillAssociation).filter_by(kind="PAYMENT")
        }
        for bill in s.query(Bill):
            if bill.id in used_bank_targets:
                continue
            target = event(bill.id)
            if not target or target["provider"] not in ("cmb", "boc"):
                continue
            if (
                target["account"] == source["account"]
                and target["amount"] == source["amount"]
                and target["facts"]["amount_minor"] == source["facts"]["amount_minor"]
                and target["facts"]["currency"] == source["facts"]["currency"]
                and target["facts"]["occurred_at"][:10]
                == source["facts"]["occurred_at"][:10]
            ):
                result.append(
                    dict(
                        bill_id=target["id"],
                        account_id=target["account"],
                        account_name=graph.canonical(target["account"]).name,
                        amount_minor=target["amount"],
                        original_amount_minor=target["facts"]["amount_minor"],
                        occurred_at=target["facts"]["occurred_at"],
                        counterparty=target["facts"]["counterparty"],
                        description=target["facts"]["description"],
                        ledger_status=target["status"],
                    )
                )
        return result

    def candidates(self, key):
        with self.db.read() as s:
            return self.candidates_in(s, key)

    def link_in(self, s, source_id, target_id, note):
        old = s.get(BillAssociation, source_id)
        reverse_old = s.get(BillAssociation, target_id)
        if old and old.target_id == target_id:
            return dict(already_linked=True, target_id=target_id)
        if reverse_old and reverse_old.target_id == source_id:
            return dict(already_linked=True, target_id=source_id)
        if old or reverse_old:
            raise DomainError("凭证已有不同关联，不能覆盖")
        if not isinstance(note, str) or not note.strip() or len(note) > 1000:
            raise DomainError("请填写确认关联的依据")
        if target_id not in {r["bill_id"] for r in self.candidates_in(s, source_id)}:
            raise DomainError(
                "候选必须是同银行卡、同日同币种、原金额和净金额一致的微信及银行付款"
            )
        if s.query(BillAssociation).filter_by(target_id=source_id).first():
            raise DomainError("不能创建嵌套或循环关联")
        a, b = s.get(BillLedger, source_id), s.get(BillLedger, target_id)
        # Keep an existing single posting; bank is primary when both are posted or pending.
        primary, secondary = (
            (source_id, target_id)
            if a.status == "POSTED" and b.status == "PENDING"
            else (target_id, source_id)
        )
        secondary_link = s.get(BillLedger, secondary)
        reversed_count = 0
        if secondary_link.status == "POSTED":
            from .bill_posting import BillPostingService

            BillPostingService(self.db).reverse_in(s, secondary)
            reversed_count = 1
        self.publish_link(s, secondary, primary, "PAYMENT", note)
        return dict(
            already_linked=False,
            target_id=primary,
            linked_source_id=secondary,
            reversed_duplicates=reversed_count,
        )

    def link(self, source_id, target_id, note):
        with self.db.write() as s:
            return self.link_in(s, source_id, target_id, note)
