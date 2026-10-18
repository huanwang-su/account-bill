"""Read-only household spending, with explicit exclusions and signed refunds."""

from collections import defaultdict
from datetime import date, timedelta
from .analysis_scope import AnalysisAccountScope
from .category_catalog import CategoryGraph
from .domain import Clock, DomainError
from .models import Entry, Transaction
from .services import ReportService


class AnalysisPeriod:
    def __init__(self, start=None, end=None):
        today = Clock.now()[:10]
        try:
            self.end = date.fromisoformat(end or today)
            self.start = date.fromisoformat(
                start or self.end.replace(day=1).isoformat()
            )
            if self.start.isoformat() != (
                start or self.start.isoformat()
            ) or self.end.isoformat() != (end or today):
                raise ValueError()
        except (TypeError, ValueError):
            raise DomainError("日期需为 YYYY-MM-DD") from None
        if self.start > self.end:
            raise DomainError("开始日期不能晚于结束日期")
        self.days = (self.end - self.start).days + 1
        if self.days > 5000:
            raise DomainError("分析区间过长，请缩短至 5000 天以内")
        try:
            self.previous_end = self.start - timedelta(days=1)
            self.previous_start = self.previous_end - timedelta(days=self.days - 1)
        except OverflowError:
            raise DomainError("日期过早，无法计算上期比较") from None


class ExpenseAnalysisService:
    def __init__(self, db):
        self.db = db

    def analyze(self, filters=None, large_amount=None, *, use_settings=True):
        filters = filters or {}
        period = AnalysisPeriod(filters.get("start"), filters.get("end"))
        from .analysis_settings import AnalysisDefaults

        threshold = AnalysisDefaults(self.db).threshold("expense", large_amount)
        # Classify category scope after refund attribution, so a refund can still
        # reduce its original category when that is the selected parent.
        selection = {
            k: filters[k] for k in ("account_id", "group_id") if filters.get(k)
        }
        direct_group = filters.get("direct_group") in (True, "true", "1")
        if direct_group:
            # A Sankey node means direct ownership, not all descendant groups.
            selection.pop("group_id", None)
        rows = ReportService(self.db).list(
            dict(
                selection,
                start=period.previous_start.isoformat(),
                end=period.end.isoformat(),
            )
        )
        with self.db.read() as s:
            scope = AnalysisAccountScope(
                s, filters, side="expense", use_settings=use_settings
            )
            accounts = scope.graph
            if filters.get("account_id"):
                accounts.canonical(filters["account_id"])
            direct_group_id = scope.group_id
            categories = CategoryGraph(s)
            transactions = {t.id: t for t in s.query(Transaction)}
            public = defaultdict(list)
            funding_ids = defaultdict(set)
            for e in s.query(Entry):
                if accounts.accounts[e.account_id].role == "SYSTEM" and e.category_id:
                    public[e.transaction_id].append(e)
                elif accounts.accounts[e.account_id].role != "SYSTEM":
                    funding_ids[e.transaction_id].add(
                        accounts.canonical(e.account_id).id
                    )
            selected = None
            category_id = filters.get("category_id")
            if category_id is not None and category_id != "":
                # Reserved flow nodes are not catalog identities. In particular,
                # integer zero must remain a filter, rather than mean "all".
                key = int(category_id)
                if key not in (0, -1):
                    key = categories.canonical(key).id
                    if categories.canonical(key).kind != "EXPENSE":
                        raise DomainError("请选择支出分类")
                selected = {key}
                while key > 0 and filters.get("exact_category") not in (
                    True,
                    "true",
                    "1",
                ):
                    more = {
                        c.id
                        for c in categories.rows.values()
                        if c.parent_id in selected and not c.merged_into_id
                    } - selected
                    if not more:
                        break
                    selected |= more

            def category_info(key):
                if not key:
                    return dict(id=0, name="未分类", parent_id=0, parent_name="未分类")
                row = categories.canonical(key)
                parent = row
                while parent.parent_id:
                    parent = categories.canonical(parent.parent_id)
                return dict(
                    id=row.id,
                    name=row.name,
                    parent_id=parent.id,
                    parent_name=parent.name,
                )

            def parts(row):
                entries = [
                    e
                    for e in row["entries"]
                    if e["role"] == "SYSTEM" and e["category_id"]
                ]
                original = (
                    transactions.get(row.get("related_id"))
                    if row["kind"] == "REFUND"
                    else None
                )
                original_entries = public.get(original.id, []) if original else []
                # Never guess how a refund of a split purchase should be allocated.
                original_categories = {
                    categories.canonical(e.category_id).id for e in original_entries
                }
                original_key = (
                    next(iter(original_categories))
                    if len(original_categories) == 1
                    else None
                )
                result = []
                for entry in entries:
                    key = original_key or entry["category_id"]
                    info = (
                        dict(
                            id=-1,
                            name="未分配退款",
                            parent_id=-1,
                            parent_name="退款抵减",
                        )
                        if row["kind"] == "REFUND" and not original_key
                        else category_info(key)
                    )
                    value = (
                        entry["amount"] if row["kind"] != "INCOME" else -entry["amount"]
                    )
                    result.append((info, value))
                return result, original

            def collect(start, end):
                buckets = {}
                group_buckets = {}
                group_detail_buckets = {}
                merchants = {}
                records = []
                trend = defaultdict(int)
                income = paid = refunds = excluded_expense = excluded_income = 0
                for row in rows:
                    day = row["occurred_at"][:10]
                    if not start <= day <= end or row["kind"] not in (
                        "INCOME",
                        "EXPENSE",
                        "REFUND",
                    ):
                        continue
                    # Expense/refund journals have one funding account; resolve
                    # merges before assigning its direct ownership group. Refunds
                    # use the receiving account's group and original purpose.
                    funding = next(
                        (
                            accounts.canonical(e["account_id"])
                            for e in row["entries"]
                            if e["role"] in ("ASSET", "LIABILITY")
                        ),
                        None,
                    )
                    group_id = funding.group_id if funding else None
                    if (
                        direct_group
                        and direct_group_id is not None
                        and (group_id or 0) != direct_group_id
                    ):
                        continue
                    values, original = parts(row)
                    original_excluded = bool(
                        original and funding_ids[original.id] & scope.excluded_ids
                    )
                    eligible = []
                    for info, value in values:
                        if (
                            scope.excludes(row)
                            or original_excluded
                            or (
                                info["parent_name"] in ("投资亏损", "理财收益")
                                and not scope.funding_ids(row) & scope.wealth_ids
                            )
                        ):
                            if row["kind"] == "INCOME":
                                excluded_income += value
                            else:
                                excluded_expense += value
                            continue
                        if selected is not None and info["id"] not in selected:
                            continue
                        eligible.append((info, value))
                    if row["kind"] == "INCOME":
                        income += sum(v for _, v in eligible)
                        continue
                    amount = sum(v for _, v in eligible)
                    if not amount:
                        continue
                    if row["kind"] == "EXPENSE":
                        paid += amount
                    else:
                        refunds -= amount
                    trend[day] += amount
                    name = (
                        (original.counterparty if original else row["counterparty"])
                        or ""
                    ).strip() or "未填写交易方"
                    merchant_key = name.casefold()
                    merchant = merchants.setdefault(
                        merchant_key,
                        dict(name=name, amount=0, count=0, refund_count=0, days=set()),
                    )
                    merchant["amount"] += amount
                    merchant["count"] += row["kind"] == "EXPENSE"
                    merchant["refund_count"] += row["kind"] == "REFUND"
                    if row["kind"] == "EXPENSE":
                        merchant["days"].add(day)
                    for info, value in eligible:
                        grouped = group_buckets.setdefault(
                            (group_id, info["parent_id"]),
                            dict(
                                group_id=group_id,
                                category_id=info["parent_id"],
                                name=info["parent_name"],
                                amount=0,
                                paid=0,
                                refunds=0,
                                transactions=set(),
                            ),
                        )
                        grouped["amount"] += value
                        grouped["paid"] += max(0, value)
                        grouped["refunds"] -= min(0, value)
                        if row["kind"] == "EXPENSE":
                            grouped["transactions"].add(row["id"])
                        detail = group_detail_buckets.setdefault(
                            (group_id, info["id"]),
                            dict(
                                group_id=group_id,
                                category_id=info["id"],
                                name=info["name"],
                                parent_id=info["parent_id"],
                                parent_name=info["parent_name"],
                                amount=0,
                                paid=0,
                                refunds=0,
                                transactions=set(),
                            ),
                        )
                        detail["amount"] += value
                        detail["paid"] += max(0, value)
                        detail["refunds"] -= min(0, value)
                        if row["kind"] == "EXPENSE":
                            detail["transactions"].add(row["id"])
                        bucket = buckets.setdefault(
                            info["id"],
                            dict(
                                **info, amount=0, paid=0, refunds=0, transactions=set()
                            ),
                        )
                        bucket["amount"] += value
                        bucket["paid"] += max(0, value)
                        bucket["refunds"] += -min(0, value)
                        if row["kind"] == "EXPENSE":
                            bucket["transactions"].add(row["id"])
                    records.append(
                        dict(
                            row,
                            amount=amount,
                            category_names=list(
                                dict.fromkeys(
                                    i["parent_name"]
                                    + (
                                        " / " + i["name"]
                                        if i["id"] != i["parent_id"]
                                        else ""
                                    )
                                    for i, _ in eligible
                                )
                            ),
                        )
                    )
                return dict(
                    income=income,
                    paid=paid,
                    refunds=refunds,
                    expense=paid - refunds,
                    buckets=buckets,
                    group_buckets=group_buckets,
                    group_detail_buckets=group_detail_buckets,
                    merchants=merchants,
                    records=records,
                    trend=trend,
                    excluded_expense=excluded_expense,
                    excluded_income=excluded_income,
                )

            current = collect(period.start.isoformat(), period.end.isoformat())
            previous = collect(
                period.previous_start.isoformat(), period.previous_end.isoformat()
            )
        leaves = []
        for key, bucket in current["buckets"].items():
            earlier = previous["buckets"].get(key, {}).get("amount", 0)
            leaves.append(
                dict(
                    **{k: v for k, v in bucket.items() if k != "transactions"},
                    count=len(bucket["transactions"]),
                    previous_amount=earlier,
                    change=bucket["amount"] - earlier
                )
            )
        parents = {}
        for key, bucket in current["buckets"].items():
            parent = parents.setdefault(
                bucket["parent_id"],
                dict(
                    id=bucket["parent_id"],
                    name=bucket["parent_name"],
                    amount=0,
                    paid=0,
                    refunds=0,
                    transactions=set(),
                ),
            )
            for field in ("amount", "paid", "refunds"):
                parent[field] += bucket[field]
            parent["transactions"] |= bucket["transactions"]
        previous_parents = defaultdict(int)
        for b in previous["buckets"].values():
            previous_parents[b["parent_id"]] += b["amount"]
        positive = sum(max(0, b["amount"]) for b in parents.values())
        parent_rows = []
        for row in parents.values():
            earlier = previous_parents[row["id"]]
            parent_rows.append(
                dict(
                    **{k: v for k, v in row.items() if k != "transactions"},
                    count=len(row["transactions"]),
                    previous_amount=earlier,
                    change=row["amount"] - earlier,
                    share=max(0, row["amount"]) / positive if positive else 0
                )
            )
        parent_rows.sort(key=lambda r: (-r["amount"], r["id"]))
        merchants = [
            dict(
                **{k: v for k, v in row.items() if k != "days"},
                active_days=len(row["days"]),
                average=row["amount"] // row["count"] if row["count"] else 0
            )
            for row in current["merchants"].values()
        ]
        merchants.sort(key=lambda r: (-r["count"], -r["amount"], r["name"]))
        payments = [r for r in current["records"] if r["kind"] == "EXPENSE"]
        large = sorted(
            [r for r in payments if r["amount"] >= threshold],
            key=lambda r: (-r["amount"], r["id"]),
        )
        unknown = sum(
            max(0, r["amount"])
            for r in parent_rows
            if r["name"] in ("未知用途", "未分类")
        )
        change = current["expense"] - previous["expense"]
        return dict(
            excluded_account_ids=sorted(scope.excluded_ids),
            start=period.start.isoformat(),
            end=period.end.isoformat(),
            days=period.days,
            previous_start=period.previous_start.isoformat(),
            previous_end=period.previous_end.isoformat(),
            income=current["income"],
            expense=current["expense"],
            net=current["income"] - current["expense"],
            paid=current["paid"],
            refunds=current["refunds"],
            previous_expense=previous["expense"],
            change=change,
            change_ratio=(
                change / previous["expense"] if previous["expense"] > 0 else None
            ),
            count=len(payments),
            refund_count=len(current["records"]) - len(payments),
            average_daily=current["expense"] // period.days,
            categories=sorted(leaves, key=lambda r: (-r["amount"], r["id"])),
            parents=parent_rows,
            group_categories=[
                dict(
                    **{k: v for k, v in row.items() if k != "transactions"},
                    count=len(row["transactions"])
                )
                for _, row in sorted(
                    current["group_buckets"].items(),
                    key=lambda item: (item[0][0] or 0, item[0][1]),
                )
            ],
            group_category_details=[
                dict(
                    **{k: v for k, v in row.items() if k != "transactions"},
                    count=len(row["transactions"])
                )
                for row in sorted(
                    current["group_detail_buckets"].values(),
                    key=lambda row: (
                        row["group_id"] or 0,
                        row["parent_id"],
                        row["category_id"],
                    ),
                )
            ],
            merchants=merchants,
            frequent_merchants=[
                r for r in merchants if r["count"] >= 3 and r["amount"] > 0
            ],
            unknown_amount=unknown,
            large_amount_minor=threshold,
            large_count=len(large),
            large_paid=sum(r["amount"] for r in large),
            large_transactions=large,
            transactions=current["records"],
            excluded_investment_expense=current["excluded_expense"],
            excluded_investment_income=current["excluded_income"],
            trend=[
                dict(
                    day=(period.start + timedelta(days=i)).isoformat(),
                    expense=current["trend"][
                        (period.start + timedelta(days=i)).isoformat()
                    ],
                )
                for i in range(period.days)
            ],
        )
