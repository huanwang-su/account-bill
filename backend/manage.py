"""Offline maintenance. Stop the server before restoring a backup."""

import argparse, sqlite3, shutil
from pathlib import Path
from datetime import datetime
from app.database import Database, ProcessLease


class BackupManager:
    def restore(self, source, target):
        Path(target).resolve().parent.mkdir(parents=True, exist_ok=True)
        with ProcessLease(Path(target).resolve()):
            return self._restore(source, target)

    def _restore(self, source, target):
        source = Path(source).resolve()
        target = Path(target).resolve()
        if source == target:
            raise ValueError("备份文件不能和当前数据库相同")
        with sqlite3.connect(source.as_uri() + "?mode=ro&immutable=1", uri=True) as c:
            if c.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                raise ValueError("备份文件损坏")
            if c.execute("PRAGMA foreign_key_check").fetchone():
                raise ValueError("备份存在关联错误")
            if c.execute("SELECT version_num FROM alembic_version").fetchone()[
                0
            ] not in (
                "001",
                "002",
                "003",
                "004",
                "005",
                "006",
                "007",
                "008",
                "009",
                "010",
                "011",
                "012",
            ):
                raise ValueError("不支持的备份版本")
            if c.execute(
                "SELECT COUNT(*) FROM (SELECT transaction_id FROM entries GROUP BY transaction_id HAVING SUM(amount) != 0)"
            ).fetchone()[0]:
                raise ValueError("备份中的账目不平衡")
        target.parent.mkdir(parents=True, exist_ok=True)
        if target.exists():
            Database(target).backup(
                str(target)
                + ".before-restore-"
                + datetime.now().strftime("%Y%m%d%H%M%S")
            )
        with sqlite3.connect(
            source.as_uri() + "?mode=ro&immutable=1", uri=True
        ) as src, sqlite3.connect(target) as dest:
            src.backup(dest)
        print("恢复完成；原数据库已备份。")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("backup")
    parser.add_argument(
        "--target",
        default=str(Path(__file__).resolve().parents[1] / "data" / "ledger.sqlite3"),
    )
    args = parser.parse_args()
    BackupManager().restore(args.backup, args.target)
