"""Durable report preferences with merged identities and optimistic updates."""

import json
from typing import Literal
from pydantic import BaseModel, ConfigDict, Field, StrictBool, StrictInt
from .models import AnalysisSettings
from .account_config import AccountGraph
from .investment_scope import InvestmentScope
from .domain import DomainError, Clock, Money


class AnalysisSettingsValues(BaseModel):
    model_config = ConfigDict(extra="forbid")
    exclude_investment_accounts: StrictBool = True
    exclude_single_accounts: StrictBool = True
    large_income_threshold_minor: StrictInt = Field(
        default=100000, ge=1, le=100000000000000
    )
    large_expense_threshold_minor: StrictInt = Field(
        default=100000, ge=1, le=100000000000000
    )
    income_excluded_account_ids: list[StrictInt] = Field(default_factory=list)
    expense_excluded_account_ids: list[StrictInt] = Field(default_factory=list)
    single_excluded_account_ids: list[StrictInt] = Field(default_factory=list)
    single_account_ids: list[StrictInt] = Field(default_factory=list)
    # Accept older clients, but keep one persisted attention list.
    overview_account_ids: list[StrictInt] = Field(default_factory=list, exclude=True)
    single_account_modes: dict[str, Literal["cashflow", "counterparties", "both"]] = (
        Field(default_factory=dict)
    )


class AnalysisSettingsService:
    ID_FIELDS = (
        "income_excluded_account_ids",
        "expense_excluded_account_ids",
        "single_account_ids",
        "single_excluded_account_ids",
    )

    def __init__(self, db):
        self.db = db

    @staticmethod
    def normalize(graph, ids, strict=False):
        result = set()
        for key in ids:
            if key not in graph.accounts and not strict:
                continue  # An unused account can have been deleted after saving.
            account = graph.canonical(key)
            if account.role == "SYSTEM":
                raise DomainError("请选择自有资金账户")
            result.add(account.id)
        return sorted(result)

    @classmethod
    def normalize_modes(cls, graph, ids, modes, strict=False):
        selected = set(cls.normalize(graph, ids, strict))
        if strict:
            for key in modes:
                if not key.isdecimal() or int(key) <= 0 or str(int(key)) != key:
                    raise DomainError("单账户分析方式的账户编号无效")
                if graph.canonical(int(key)).id not in selected:
                    raise DomainError("请先将账户加入单账户分析名单")
        result = {}
        for key in ids:
            if key not in graph.accounts:
                continue
            canonical = graph.canonical(key).id
            mode = modes.get(str(key), modes.get(str(canonical), "both"))
            name = str(canonical)
            if name in result and result[name] != mode:
                result[name] = "both"  # A merge preserves both selected analyses.
            else:
                result[name] = mode
        return result

    @classmethod
    def read_in(cls, session):
        row = session.get(AnalysisSettings, 1)
        values = AnalysisSettingsValues().model_dump()
        if row:
            stored = json.loads(row.content)
            values.update(stored)
            if "single_excluded_account_ids" not in stored:
                values["single_excluded_account_ids"] = list(
                    values["single_account_ids"]
                )
            values["single_account_ids"] = sorted(
                set(values["single_account_ids"])
                | set(values.pop("overview_account_ids", []))
            )
        graph = AccountGraph(session)
        values["single_account_modes"] = cls.normalize_modes(
            graph, values["single_account_ids"], values["single_account_modes"]
        )
        for field in cls.ID_FIELDS:
            values[field] = cls.normalize(graph, values[field])
        defaults = (
            InvestmentScope(graph).assets
            if values["exclude_investment_accounts"]
            else set()
        )
        if values["exclude_single_accounts"]:
            defaults = set(defaults) | set(values["single_excluded_account_ids"])
        return dict(
            **values,
            revision=row.revision if row else 0,
            updated_at=row.updated_at if row else None,
            effective_income_excluded_account_ids=sorted(
                defaults | set(values["income_excluded_account_ids"])
            ),
            effective_expense_excluded_account_ids=sorted(
                defaults | set(values["expense_excluded_account_ids"])
            ),
        )

    def get(self):
        with self.db.read() as session:
            return self.read_in(session)

    def save(self, data):
        try:
            parsed = AnalysisSettingsValues.model_validate(
                {k: v for k, v in data.items() if k != "revision"}
            )
            values = parsed.model_dump()
            if type(data.get("revision")) is not int or any(
                key <= 0
                for key in [
                    *(key for field in self.ID_FIELDS for key in values[field]),
                    *parsed.overview_account_ids,
                ]
            ):
                raise ValueError()
        except (TypeError, ValueError):
            raise DomainError("分析配置格式错误") from None
        with self.db.write() as session:
            row = session.get(AnalysisSettings, 1)
            if data["revision"] != (row.revision if row else 0):
                raise DomainError("配置已被修改，请重新加载后保存")
            graph = AccountGraph(session)
            previous = self.read_in(session)
            if "single_excluded_account_ids" not in data:
                values["single_excluded_account_ids"] = (
                    previous["single_excluded_account_ids"]
                    if row
                    else list(values["single_account_ids"])
                )
            if "overview_account_ids" in data:
                values["single_account_ids"] = sorted(
                    set(values["single_account_ids"]) | set(parsed.overview_account_ids)
                )
            elif "single_account_ids" not in data:
                values["single_account_ids"] = previous["single_account_ids"]
            # Older clients must not reset preferences they do not yet expose.
            for key in (
                "exclude_single_accounts",
                "large_income_threshold_minor",
                "large_expense_threshold_minor",
            ):
                if key not in data and row:
                    values[key] = json.loads(row.content).get(key, values[key])
            if "single_account_modes" not in data and row:
                old_modes = previous["single_account_modes"]
                values["single_account_modes"] = {
                    str(key): old_modes.get(str(key), "both")
                    for key in values["single_account_ids"]
                }
            values["single_account_modes"] = self.normalize_modes(
                graph,
                values["single_account_ids"],
                values["single_account_modes"],
                strict=True,
            )
            for field in self.ID_FIELDS:
                values[field] = self.normalize(graph, values[field], strict=True)
            if row is None:
                row = AnalysisSettings(id=1, revision=0)
                session.add(row)
            row.revision += 1
            row.content = json.dumps(values, ensure_ascii=False)
            row.updated_at = Clock.now()
            session.flush()
            return self.read_in(session)


class AnalysisDefaults:
    """One persisted source for monetary report thresholds (integer cents)."""

    def __init__(self, db):
        self.config = AnalysisSettingsService(db).get()

    def threshold(self, side, override=None):
        value = (
            self.config[f"large_{side}_threshold_minor"]
            if override is None
            else Money.parse(str(override))
        )
        if value <= 0:
            raise DomainError("大额门槛须大于零")
        return value
