"""Page a canonical bill projection without sending every source field to the UI."""

import re
from .domain import DomainError
from .report_context import consistent_read
from .report_queries import PageRequest


class BillPageService:
    FIELDS = {
        "occurred_at",
        "amount",
        "counterparty",
        "description",
        "account",
        "category",
        "classification_status",
        "ledger_status",
    }

    def __init__(self, database):
        self.db = database

    @consistent_read
    def page(self, filters):
        from .bills import BillService
        import json

        f = dict(filters)
        page = PageRequest(f)
        field = f.get("sort", "occurred_at")
        if field not in self.FIELDS:
            raise DomainError("不支持的交易明细排序字段")
        # The projection includes cross-source association and category aliases.
        # It is reusable for subsequent pages in exactly the same ledger revision.
        query = {
            k: v
            for k, v in f.items()
            if k not in ("page", "page_size", "sort", "order")
        }
        session = self.db.current.get()
        readonly = session.info.get("read_only", False)
        key = ("bills", session.info.get("revision", self.db.revision), json.dumps(query, sort_keys=True))
        rows = self.db.read_cache.get(key) if readonly else None
        if rows is None:
            rows = BillService(self.db).list(query)
            if readonly:
                self.db.read_cache.put(key, rows)

        def value(row):
            if field == "amount":
                return row["effective_amount_minor"]
            if field == "account":
                return row.get("account_name") or ""
            if field == "category":
                return " / ".join(row["display_category_path"])
            if field == "description":
                return row["display_description"]
            return row["facts"].get(field, row.get(field, "")) or ""

        def natural(value):
            if isinstance(value, int):
                return (value,)
            return tuple(
                (1, int(part)) if part.isdigit() else (0, part.casefold())
                for part in re.split(r"(\d+)", str(value))
            )

        rows.sort(
            key=lambda row: (natural(value(row)), row["id"]),
            reverse=f.get("order", "descend") not in ("asc", "ascend"),
        )
        offset = (page.page - 1) * page.size
        return dict(
            items=rows[offset : offset + page.size],
            total=len(rows),
            page=page.page,
            page_size=page.size,
            statistics=BillService(self.db).statistics(),
        )
