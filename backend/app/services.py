"""Compatibility exports; implementations live in focused domain modules."""

from .repository import Repository
from .accounts import AccountService
from .catalog import CatalogService
from .transactions import TransactionService
from .reports import ReportService

__all__ = [
    "Repository",
    "AccountService",
    "CatalogService",
    "TransactionService",
    "ReportService",
]
