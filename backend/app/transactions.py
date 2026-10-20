from .models import Transaction, BillLedger
from .domain import DomainError


from .repository import Repository
from .journal import JournalService


class TransactionService(JournalService):
    """Application commands: post, reverse and replace an existing transaction."""

    def post(self, data):
        data = {k: v for k, v in data.items() if not k.startswith("_")}
        with self.db.write() as s:
            return {"id": self.post_in(s, data).id}

    def reverse(self, tx_id):
        with self.db.write() as s:
            tx = Repository(s).require(Transaction, tx_id)
            if tx.status == "REVERSED":
                return {"ok": True}
            self._reverse(s, tx)
            return {"ok": True}

    def replace(self, tx_id, data):
        from .journal_guards import JournalIdempotency

        with self.db.write() as s:
            tx = Repository(s).require(Transaction, tx_id)
            if tx.purpose == "VALUATION":
                raise DomainError("估值交易请先撤销估值，再通过证券余额更新重新记录")
            previous = s.query(BillLedger).filter_by(transaction_id=tx.id).first()
            data = {k: v for k, v in data.items() if not k.startswith("_")}
            data = {
                "_owner_run_id": previous.owner_run_id if previous else None,
                **data,
                "source": tx.source,
                "note": data.get("note", "") + " [修改自 #" + str(tx.id) + "]",
            }
            old = (
                s.query(Transaction)
                .filter_by(idempotency_key=data.get("idempotency_key"))
                .first()
            )
            if old:
                JournalIdempotency.check(
                    s, old, data, self._postings(s, data, existing=old.id)
                )
                return {"id": old.id}
            self._reverse(s, tx)
            return {"id": self.post_in(s, data).id}
