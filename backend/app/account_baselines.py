"""Set a historical asset baseline without treating earlier movements as income.

Original journals stay intact. Explicitly selected later opening entries are
offset at their original time, so moving a baseline never doubles the balance.
"""

import json
from .account_config import AccountGraph
from .domain import Clock, DomainError, Money, Posting
from .models import Account, AccountValuation, Entry, Reconciliation, Transaction
from .services import TransactionService


class AccountBaselineService:
    SCHEMA = "local-ledger.account-baseline.v1"

    def __init__(self, database):
        self.db = database

    def apply(self, account_id, data):
        with self.db.write() as session:
            return self.apply_in(session, account_id, data)

    def apply_in(self, session, account_id, data):
        when = Clock.normalize(data["occurred_at"])
        target = Money.parse(data["amount"])
        key = data.get("idempotency_key")
        note = data.get("note", "")
        if not isinstance(key, str) or not key or len(key) > 120:
            raise DomainError("缺少有效的资产基准编号")
        if not isinstance(note, str) or not note.strip():
            raise DomainError("请填写资产基准的数据来源")
        graph = AccountGraph(session)
        account = graph.canonical(account_id)
        if account.id != int(account_id) or account.role not in ("ASSET", "LIABILITY"):
            raise DomainError("请选择未合并的资金账户")
        for old in session.query(Reconciliation).filter_by(account_id=account.id):
            try:
                audit = json.loads(old.note)
            except (ValueError, TypeError):
                continue
            if (
                not isinstance(audit, dict)
                or audit.get("schema_version") != self.SCHEMA
            ):
                continue
            if audit.get("idempotency_key") == key:
                if old.at != when or old.actual != target or audit["source"] != note:
                    raise DomainError("资产基准编号已用于不同的请求")
                return {**audit["result"], "already_applied": True}
            if old.at == when:
                raise DomainError("此时点已有资产基准，请先核对已有基准")

        members = graph.members(account.id)
        later_openings = {
            tx.id: tx
            for tx in session.query(Transaction)
            .join(Entry, Entry.transaction_id == Transaction.id)
            .filter(
                Entry.account_id.in_(members),
                Transaction.kind == "OPENING",
                Transaction.status == "POSTED",
                Transaction.occurred_at > when,
            )
        }
        selected = data.get("relocate_opening_ids", [])
        if len(set(selected)) != len(selected) or set(selected) != set(later_openings):
            raise DomainError("请明确需要前移的全部后续期初记录，避免重复增加资产")
        snapshots = list(
            session.query(AccountValuation).filter(
                AccountValuation.account_id.in_(members),
                AccountValuation.revoked_at.is_(None),
                AccountValuation.occurred_at >= when,
            )
        )
        corrections = data.get("correct_zero_valuation_ids", [])
        if len(set(corrections)) != len(corrections) or set(corrections) != {
            v.id for v in snapshots
        }:
            raise DomainError("已有后续证券估值，请明确更正范围，不自动重算投资盈亏")
        if snapshots and account.kind != "证券":
            raise DomainError("估值更正仅用于证券账户")
        if any(
            v.transaction_id or v.actual or v.change or not v.baseline
            for v in snapshots
        ):
            raise DomainError("仅支持用户明确确认误填、未产生流水的零余额基准更正")
        if (
            snapshots
            and session.query(Entry)
            .join(Transaction)
            .filter(Entry.account_id.in_(members), Transaction.occurred_at >= when)
            .first()
        ):
            raise DomainError("零估值之后已有账户流水，请先核对资金变动再更正")

        _, balances = graph.balances(session, when)
        calculated = balances.get(account.id, 0)
        amount = target - calculated
        system = session.query(Account).filter_by(role="SYSTEM", name="期初").one()
        transactions = TransactionService(self.db)
        tx = None
        if amount:
            tx = transactions._write(
                session,
                dict(
                    kind="OPENING",
                    occurred_at=when,
                    idempotency_key="asset-baseline:" + key,
                    source="历史资产基准",
                    _baseline_reconciliation=True,
                    note=note,
                ),
                [Posting(account.id, amount), Posting(system.id, -amount)],
            )
        offsets = []
        for old in later_openings.values():
            original = sum(
                e.amount
                for e in session.query(Entry).filter_by(transaction_id=old.id)
                if e.account_id in members
            )
            if not original:
                raise DomainError("后续期初不是独立的账户余额，请核对")
            offset = transactions._write(
                session,
                dict(
                    kind="OPENING",
                    occurred_at=old.occurred_at,
                    idempotency_key=f"baseline-offset:{key}:{old.id}",
                    source="历史资产基准",
                    _baseline_reconciliation=True,
                    note=f"期初基准已前移至 {when}，抵消原期初 #{old.id}，避免资产重复；{note}",
                ),
                [Posting(account.id, -original), Posting(system.id, original)],
            )
            offsets.append(
                dict(
                    original_transaction_id=old.id,
                    offset_transaction_id=offset.id,
                    amount_minor=original,
                )
            )
        corrections_audit = []
        for snapshot in snapshots:
            corrections_audit.append(
                {
                    column.name: getattr(snapshot, column.name)
                    for column in snapshot.__table__.columns
                }
            )
            snapshot.actual = snapshot.calculated = target
            snapshot.change = 0
            snapshot.baseline = False
            snapshot.note += f"；用户更正：此前0为误填，以{MoneyValue.format(target)}元为准；历史基准为{when}，未产生投资盈亏。原记录见资产基准审计。"
        if account.kind == "证券":
            session.add(
                AccountValuation(
                    account_id=account.id,
                    occurred_at=when,
                    recorded_at=Clock.now(),
                    actual=target,
                    calculated=calculated,
                    change=0,
                    baseline=True,
                    transaction_id=tx.id if tx else None,
                    idempotency_key="asset-baseline:" + key,
                    note=note,
                )
            )
        for member in members:
            graph.accounts[member].opening_set = True
        session.flush()
        _, check = graph.balances(session, when)
        if check.get(account.id, 0) != target:
            raise DomainError("资产基准核对失败，已取消本次操作")
        result = dict(
            account_id=account.id,
            occurred_at=when,
            actual_minor=target,
            calculated_minor=calculated,
            adjustment_minor=amount,
            transaction_id=tx.id if tx else None,
            offsets=offsets,
            corrected_valuation_ids=corrections,
            already_applied=False,
        )
        session.add(
            Reconciliation(
                account_id=account.id,
                at=when,
                actual=target,
                calculated=calculated,
                note=json.dumps(
                    dict(
                        schema_version=self.SCHEMA,
                        idempotency_key=key,
                        source=note,
                        result=result,
                        previous_valuations=corrections_audit,
                    ),
                    ensure_ascii=False,
                ),
            )
        )
        session.flush()
        return result


class MoneyValue:
    @staticmethod
    def format(minor):
        sign = "-" if minor < 0 else ""
        return f"{sign}{abs(minor) // 100}.{abs(minor) % 100:02d}"
