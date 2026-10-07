"""Balance snapshots create valuation P&L through the existing journal pipeline."""

from sqlalchemy import func
from .database import Database
from .models import Account, AccountValuation, Category, Entry, Transaction
from .account_config import AccountGraph
from .services import Repository, TransactionService
from .domain import Clock, DomainError, Money, Posting


class SecuritiesValuationService:
    def __init__(self, db: Database):
        self.db = db

    @staticmethod
    def serialize(row, session):
        tx = (
            session.get(Transaction, row.transaction_id) if row.transaction_id else None
        )
        return dict(
            id=row.id,
            account_id=row.account_id,
            occurred_at=row.occurred_at,
            recorded_at=row.recorded_at,
            actual=row.actual,
            calculated=row.calculated,
            change=row.change,
            baseline=row.baseline,
            transaction_id=row.transaction_id,
            status=tx.status if tx else "RECORDED",
            note=row.note,
        )

    def history(self, account_id):
        with self.db.read() as s:
            graph = AccountGraph(s)
            graph.canonical(account_id)
            return [
                self.serialize(r, s)
                for r in s.query(AccountValuation)
                .filter(AccountValuation.account_id.in_(graph.members(account_id)))
                .order_by(
                    AccountValuation.occurred_at.desc(), AccountValuation.id.desc()
                )
            ]

    @staticmethod
    def category(session, kind, name):
        row = (
            session.query(Category)
            .filter_by(kind=kind, name=name, parent_id=None, merged_into_id=None)
            .first()
        )
        if row and not row.active:
            raise DomainError("请先启用盈亏分类：" + name)
        if not row:
            row = Category(kind=kind, name=name, active=True)
            session.add(row)
            session.flush()
        return row.id

    def update(self, account_id, data):
        when = Clock.normalize(data.get("occurred_at"))
        actual = Money.parse(data.get("actual"))
        key = data.get("idempotency_key")
        if actual < 0:
            raise DomainError("证券账户总资产不能为负数")
        if not isinstance(key, str) or not key or len(key) > 120:
            raise DomainError("缺少有效的余额更新编号")
        with self.db.write() as s:
            account = Repository(s).require(Account, account_id)
            if (
                account.merged_into_id
                or account.role != "ASSET"
                or account.kind != "证券"
                or not account.active
            ):
                raise DomainError("请选择启用且未合并的证券资产账户")
            old = s.query(AccountValuation).filter_by(idempotency_key=key).first()
            if old:
                if (
                    old.account_id != account_id
                    or old.actual != actual
                    or old.occurred_at != when
                    or old.note != str(data.get("note", ""))
                ):
                    raise DomainError("提交编号已用于不同的余额更新")
                return self.serialize(old, s)
            if (
                s.query(Transaction)
                .filter_by(idempotency_key="valuation:" + key)
                .first()
            ):
                raise DomainError("更新编号已用于其他交易")
            graph = AccountGraph(s)
            members = graph.members(account_id)
            latest = (
                s.query(func.max(Transaction.occurred_at))
                .join(Entry, Entry.transaction_id == Transaction.id)
                .filter(Entry.account_id.in_(members))
                .scalar()
            )
            last_snapshot = (
                s.query(func.max(AccountValuation.occurred_at))
                .filter(AccountValuation.account_id.in_(members))
                .scalar()
            )
            if when < max(latest or when, last_snapshot or when):
                raise DomainError(
                    "更新时间不能早于该账户已有流水或余额更新；请按时间顺序更新"
                )
            initialized = all(graph.accounts[i].opening_set for i in members)
            if not initialized and latest:
                raise DomainError("已有流水的证券账户请先补全期初余额，再更新盈亏")
            calculated = (
                s.query(func.coalesce(func.sum(Entry.amount), 0))
                .join(Transaction, Transaction.id == Entry.transaction_id)
                .filter(Entry.account_id.in_(members), Transaction.occurred_at <= when)
                .scalar()
            )
            baseline = not initialized
            change = 0 if baseline else actual - calculated
            service = TransactionService(self.db)
            tx = None
            if baseline:
                if actual:
                    system = (
                        s.query(Account).filter_by(role="SYSTEM", name="期初").one()
                    )
                    tx = service._write(
                        s,
                        dict(
                            kind="OPENING",
                            occurred_at=when,
                            note="证券账户首次余额，作为期初基准",
                            source="证券余额更新",
                            idempotency_key="valuation:" + key,
                        ),
                        [Posting(account_id, actual), Posting(system.id, -actual)],
                    )
                for i in members:
                    graph.accounts[i].opening_set = True
            elif change:
                kind = "INCOME" if change > 0 else "EXPENSE"
                category_id = self.category(
                    s, kind, "理财收益" if change > 0 else "投资亏损"
                )
                tx = service.post_in(
                    s,
                    dict(
                        kind=kind,
                        account_id=account_id,
                        amount=f"{abs(change) // 100}.{abs(change) % 100:02d}",
                        category_id=category_id,
                        occurred_at=when,
                        counterparty="证券估值",
                        note="余额更新盈亏：" + str(data.get("note", "")),
                        source="证券余额更新",
                        idempotency_key="valuation:" + key,
                    ),
                )
            row = AccountValuation(
                account_id=account_id,
                occurred_at=when,
                recorded_at=Clock.now(),
                actual=actual,
                calculated=calculated,
                change=change,
                baseline=baseline,
                transaction_id=tx.id if tx else None,
                idempotency_key=key,
                note=str(data.get("note", "")),
            )
            s.add(row)
            s.flush()
            return self.serialize(row, s)
