"""Export a verified encrypted business backup without changing the live ledger."""

import argparse
import sqlite3
from pathlib import Path

from app.domain import DomainError
from app.local_backup import LocalBackupExporter


def main():
    parser = argparse.ArgumentParser(
        description="使用本地环境密码导出并校验加密账本备份"
    )
    parser.add_argument(
        "--database", type=Path, help="账本数据库，默认 data/ledger.sqlite3"
    )
    parser.add_argument("--output-dir", type=Path, help="备份目录，默认工程 backups/")
    args = parser.parse_args()
    try:
        result = LocalBackupExporter(Path(__file__).resolve().parents[1]).export(
            args.database, args.output_dir
        )
    except DomainError as error:
        parser.exit(1, f"备份失败：{error}。未修改当前账本。\n")
    except (OSError, sqlite3.Error):
        parser.exit(
            1, "备份失败：请检查本地密码配置、数据库和目录权限，未修改当前账本。\n"
        )
    print("加密备份已导出并通过解密及格式校验：")
    print(result["path"])
    print(f"文件大小：{result['size']:,} 字节")


if __name__ == "__main__":
    main()
