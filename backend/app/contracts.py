"""Validated command contracts; service/domain invariants remain authoritative."""

from typing import Literal, Optional, Union
from pydantic import BaseModel, ConfigDict, Field


class SplitItem(BaseModel):
    model_config = ConfigDict(extra="forbid")
    amount: Union[str, int, float]
    category_id: int


class TransactionCommand(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["INCOME", "EXPENSE", "REFUND", "TRANSFER"]
    occurred_at: str
    account_id: int = Field(gt=0)
    to_account_id: Optional[int] = Field(default=None, gt=0)
    category_id: Optional[int] = Field(default=None, gt=0)
    related_id: Optional[int] = Field(default=None, gt=0)
    amount: Optional[Union[str, int, float]] = None
    items: Optional[list[SplitItem]] = None
    counterparty: str = Field(default="", max_length=500)
    note: str = Field(default="", max_length=4000)
    tags: list[str] = Field(default_factory=list, max_length=100)
    idempotency_key: str = Field(min_length=1, max_length=200)
    source: str = Field(default="手动", max_length=80)
