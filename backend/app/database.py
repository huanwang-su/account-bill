from contextlib import contextmanager
from pathlib import Path
import sqlite3
from sqlalchemy import create_engine, event, text
from sqlalchemy.orm import sessionmaker
from .models import Base, Account, Category


class Database:
    def __init__(self, path):
        self.path = Path(path).resolve()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.engine = create_engine(
            "sqlite:///" + str(self.path),
            connect_args={"check_same_thread": False, "timeout": 15},
        )

        @event.listens_for(self.engine, "connect")
        def configure(db, _):
            db.execute("PRAGMA foreign_keys=ON")
            db.execute("PRAGMA journal_mode=WAL")
            db.execute("PRAGMA busy_timeout=15000")

        self.sessions = sessionmaker(bind=self.engine, expire_on_commit=False)

    def initialize(self):
        from alembic.config import Config
        from alembic import command

        root = Path(__file__).resolve().parents[1]
        config = Config(str(root / "alembic.ini"))
        config.set_main_option("script_location", str(root / "migrations"))
        config.set_main_option(
            "sqlalchemy.url", "sqlite:///" + str(self.path).replace("%", "%%")
        )
        if self.path.exists():
            with sqlite3.connect(self.path) as c:
                has_version = c.execute(
                    "SELECT name FROM sqlite_master WHERE name='alembic_version'"
                ).fetchone()
                current = (
                    c.execute("SELECT version_num FROM alembic_version").fetchone()
                    if has_version
                    else None
                )
            if current and current[0] != "013":
                self.backup(str(self.path) + ".before-upgrade-" + current[0])
        command.upgrade(config, "head")
        with self.write() as s:
            if not s.query(Account).count():
                for name in ["消费", "收入", "期初", "余额调整"]:
                    s.add(
                        Account(
                            name=name, role="SYSTEM", kind="公共账户", opening_set=True
                        )
                    )
                for name, kind in [
                    ("支付宝余额", "支付宝"),
                    ("余额宝", "理财"),
                    ("微信", "微信"),
                    ("银行卡", "银行卡"),
                    ("现金", "现金"),
                ]:
                    s.add(Account(name=name, kind=kind))
            fresh_catalog = not s.query(Category).count()
            if fresh_catalog:
                for kind, groups in [
                    (
                        "EXPENSE",
                        {
                            "餐饮": ["买菜", "外卖", "聚餐"],
                            "购物": ["日用品", "服饰"],
                            "交通": ["公交地铁", "打车"],
                            "居家": ["房租", "水电"],
                            "其他支出": [],
                        },
                    ),
                    ("INCOME", {"工资": [], "理财收益": [], "其他收入": []}),
                ]:
                    for name, children in groups.items():
                        cat = Category(name=name, kind=kind)
                        s.add(cat)
                        s.flush()
                        for child in children:
                            s.add(Category(name=child, parent_id=cat.id, kind=kind))
            if fresh_catalog:
                from .category_catalog import CategoryCatalog

                CategoryCatalog(s).consolidate()

    @contextmanager
    def read(self):
        with self.sessions() as s:
            yield s

    @contextmanager
    def write(self):
        with self.sessions() as s:
            try:
                s.execute(text("BEGIN IMMEDIATE"))
                yield s
                s.commit()
            except Exception:
                s.rollback()
                raise

    def backup(self, target):
        with sqlite3.connect(self.path) as source, sqlite3.connect(target) as dest:
            source.backup(dest)
            dest.execute("PRAGMA journal_mode=DELETE")


class ProcessLease:
    """Prevent a second server or restore from opening the same live ledger."""

    def __init__(self, path):
        import fcntl
        from .domain import DomainError

        self.file = open(str(path) + ".lock", "a+")
        try:
            fcntl.flock(self.file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            self.file.close()
            raise DomainError("账本正在运行，请先停止服务再恢复或重新启动")

    def close(self):
        self.file.close()

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()
