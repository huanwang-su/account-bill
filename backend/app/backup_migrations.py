"""Explicit, additive migrations for the business ZIP contract (introduced at 015)."""

from copy import deepcopy
from .domain import DomainError


class BackupMigrations:
    @staticmethod
    def upgrade(tables, source, target):
        if source == target:
            return tables
        if source == "015" and target == "016":
            tables = deepcopy(tables)
            for row in tables.get("transactions", []):
                if "purpose" in row:
                    raise DomainError("旧版备份包含不支持的交易用途字段")
                row["purpose"] = (
                    "OPENING"
                    if row["kind"] == "OPENING"
                    else (
                        "VALUATION"
                        if row.get("source") == "证券余额更新"
                        else "GENERAL"
                    )
                )
            for row in tables.get("account_valuations", []):
                if "revoked_at" in row:
                    raise DomainError("旧版备份包含不支持的估值字段")
                row["revoked_at"] = None
            return tables
        raise DomainError("该备份版本暂无安全升级路径，请使用对应版本程序恢复")
