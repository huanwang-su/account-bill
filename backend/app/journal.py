from sqlalchemy import func
from .models import (
    Account,
    Transaction,
    Entry,
    BillLedger,
    TransferMatch,
    BillAssociation,
)
from .domain import DomainError, Money, Clock, Journal, Posting
from .account_config import AccountGraph


from .repository import Repository


class JournalService:
    """Validated balanced journal writes; independent of import orchestration."""

    def __init__(self, database):
        self.db = database

    def _account(self, s, key, replay=False):
        graph = AccountGraph(s)
        target = graph.canonical(key)
        if (not target.active and not replay) or target.role == "SYSTEM":
            raise DomainError("请选择启用的普通账户")
        return graph.funding(key)

    def _postings(self, s, data, existing=None):
        kind = data.get("kind")
        a = self._account(s, data.get("account_id"), bool(existing))
        if kind == "TRANSFER":
            b = self._account(s, data.get("to_account_id"), bool(existing))
            if a.id == b.id:
                raise DomainError("转出和转入账户不能相同")
            amount = Money.parse(data.get("amount"), positive=True)
            return [Posting(a.id, -amount), Posting(b.id, amount)]
        if kind not in ("INCOME", "EXPENSE", "REFUND"):
            raise DomainError("不支持的交易类型")
        expected = "INCOME" if kind == "INCOME" else "EXPENSE"
        system = (
            s.query(Account)
            .filter_by(role="SYSTEM", name="收入" if kind == "INCOME" else "消费")
            .one()
        )
        items = data.get("items") or [
            {"amount": data.get("amount"), "category_id": data.get("category_id")}
        ]
        if kind == "REFUND":
            from .category_catalog import CategoryCatalog
            from .classification_policy import ClassificationPolicyService

            refund_category = (
                CategoryCatalog(s)
                .resolve(
                    "EXPENSE",
                    ["退款"],
                    ClassificationPolicyService.read_in(s)["allow_new_categories"],
                )
                .id
            )
            items = [{**item, "category_id": refund_category} for item in items]
        postings = []
        total = 0
        for item in items:
            amount = Money.parse(item.get("amount"), positive=True)
            from .category_catalog import CategoryGraph

            category = CategoryGraph(s).canonical(item.get("category_id"))
            if category.kind != expected or (not category.active and not existing):
                raise DomainError("请选择正确且启用的收支分类")
            total += amount
            postings.append(
                Posting(
                    system.id, amount if kind == "EXPENSE" else -amount, category.id
                )
            )
        if total > Money.MAX:
            raise DomainError("总金额超出范围")
        postings.append(Posting(a.id, -total if kind == "EXPENSE" else total))
        if kind == "REFUND" and data.get("related_id"):
            original = Repository(s).require(Transaction, data["related_id"])
            if original.kind != "EXPENSE" or (
                original.status != "POSTED" and not existing
            ):
                raise DomainError("退款只能关联有效支出")
            original_amount = (
                s.query(func.sum(Entry.amount))
                .filter_by(transaction_id=original.id, account_id=system.id)
                .scalar()
                or 0
            )
            refunded = (
                s.query(func.coalesce(func.sum(Entry.amount), 0))
                .join(Transaction, Entry.transaction_id == Transaction.id)
                .filter(
                    Transaction.id != (existing or 0),
                    Transaction.related_id == original.id,
                    Transaction.kind == "REFUND",
                    Transaction.status == "POSTED",
                    Entry.account_id == system.id,
                )
                .scalar()
            )
            if total > original_amount + refunded:
                raise DomainError("退款合计不能超过原支出")
        return postings

    def _write(self, s, data, postings):
        from .journal_guards import JournalIdempotency, ValuationHistoryGuard

        Journal(postings).validate()
        key = data.get("idempotency_key")
        if not isinstance(key, str) or not key or len(key) > 200:
            raise DomainError("缺少有效的提交编号")
        old = s.query(Transaction).filter_by(idempotency_key=key).first()
        if old:
            return JournalIdempotency.check(s, old, data, postings)
        ValuationHistoryGuard.check(s, data, postings)
        opening_link = None
        if data["kind"] == "OPENING":
            from .bill_journal import BillJournalLink

            opening_link = BillJournalLink(self.db).prepare_transaction(
                s, data, postings
            )
        from .transaction_purpose import TransactionPurpose

        tx = Transaction(
            purpose=TransactionPurpose.from_input(data),
            kind=data["kind"],
            occurred_at=Clock.normalize(data["occurred_at"]),
            posted_at=Clock.now(),
            counterparty=str(data.get("counterparty", "")),
            note=str(data.get("note", "")),
            tags=Repository(s).tag_values(data.get("tags", []), "TRANSACTION"),
            idempotency_key=key,
            source=data.get("source", "手动"),
            related_id=data.get("related_id"),
            reversal_of=data.get("reversal_of"),
        )
        s.add(tx)
        s.flush()
        for p in postings:
            s.add(
                Entry(
                    transaction_id=tx.id,
                    account_id=p.account_id,
                    amount=p.amount,
                    category_id=p.category_id,
                )
            )
        s.flush()
        if opening_link:
            BillJournalLink(self.db).attach_transaction(s, opening_link, tx)
        return tx

    def post_in(self, s, data):
        from .journal_guards import JournalIdempotency

        old = (
            s.query(Transaction)
            .filter_by(idempotency_key=data.get("idempotency_key"))
            .first()
        )
        if old:
            return JournalIdempotency.check(
                s, old, data, self._postings(s, data, existing=old.id)
            )
        from .bill_journal import BillJournalLink

        postings = self._postings(s, data)
        service = BillJournalLink(self.db)
        link = service.prepare_transaction(s, data, postings)
        tx = self._write(s, data, postings)
        service.attach_transaction(s, link, tx)
        return tx

    def _reverse(self, s, tx):
        if tx.status != "POSTED" or tx.kind in ("REVERSAL", "OPENING"):
            raise DomainError("该交易不能撤销")
        if (
            s.query(Transaction)
            .filter_by(related_id=tx.id, kind="REFUND", status="POSTED")
            .first()
        ):
            raise DomainError("请先撤销关联退款")
        postings = [
            Posting(e.account_id, -e.amount, e.category_id)
            for e in s.query(Entry).filter_by(transaction_id=tx.id)
        ]
        reversal = self._write(
            s,
            {
                "kind": "REVERSAL",
                "occurred_at": tx.occurred_at,
                "note": "冲销交易 #" + str(tx.id),
                "idempotency_key": "reverse:" + str(tx.id),
                "reversal_of": tx.id,
            },
            postings,
        )
        tx.status = "REVERSED"
        link = s.query(BillLedger).filter_by(transaction_id=tx.id).first()
        if link:
            from .bill_states import BillStates

            BillStates.posting(link, "REVERSED", "交易已撤销，余额已冲回")
            from .bill_journal import BillJournalLink

            BillJournalLink.source_state(s, link.bill_id, "REVERSED", link.reason)
        pair = s.query(TransferMatch).filter_by(transaction_id=tx.id).first()
        if pair:
            mirror = s.get(BillLedger, pair.incoming_id)
            if mirror:
                mirror.status, mirror.reason, mirror.revoked_at = (
                    "REVERSED",
                    "内部转账已撤销，两侧流水已冲回",
                    Clock.now(),
                )
                BillJournalLink.source_state(
                    s, mirror.bill_id, "REVERSED", mirror.reason
                )
        if link:
            for association in s.query(BillAssociation).filter_by(
                target_id=link.bill_id
            ):
                secondary = s.get(BillLedger, association.source_id)
                if secondary:
                    secondary.status, secondary.reason, secondary.revoked_at = (
                        "REVERSED",
                        "关联交易已撤销，凭证保留",
                        Clock.now(),
                    )
                    BillJournalLink.source_state(
                        s, secondary.bill_id, "REVERSED", secondary.reason
                    )
        return reversal
