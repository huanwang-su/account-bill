"""Actual directed fund movements, independent of balance initialization and valuation."""

import json
from collections import defaultdict

from .account_config import AccountGraph, AccountGroupService
from .account_movements import AccountMovementService
from .category_catalog import CategoryGraph
from .models import AccountGroup, BillJournalHistory, Entry, Transaction
from .report_scope import ReportAccountScope


class FundFlowService:
    EXTERNAL = {
        "INCOME": ("external:income", "外部收入"),
        "EXPENSE": ("external:expense", "外部支出"),
        "REFUND": ("external:refund", "外部退款"),
    }
    EXCLUSIONS = {
        "OPENING": "期初录入不属于资金流转",
        "VALUATION": "证券估值不属于实际资金流转",
        "ADJUSTMENT": "账面调整不属于实际资金流转",
        "REVERSED": "已撤销交易不计入资金流转",
        "REVERSAL": "冲销记录不计入资金流转",
        "OTHER": "其他非资金交易不计入资金流转",
    }

    def __init__(self, database):
        self.db = database
        self.periods = AccountMovementService(database)

    @classmethod
    def _exclusion(cls, transaction):
        if transaction.kind == "REVERSAL":
            return "REVERSAL"
        if transaction.status != "POSTED":
            return "REVERSED"
        if transaction.kind == "OPENING":
            return "OPENING"
        if transaction.purpose == "VALUATION":
            return "VALUATION"
        if transaction.kind == "ADJUSTMENT":
            return "ADJUSTMENT"
        if transaction.kind not in ("INCOME", "EXPENSE", "REFUND", "TRANSFER"):
            return "OTHER"
        return None

    @staticmethod
    def _account_endpoint(account, graph, scope):
        return dict(
            key=f"account:{account.id}",
            account_id=account.id,
            name=account.name,
            role=account.role,
            kind=account.kind,
            group_id=account.group_id,
            active=account.active,
            composite=graph.is_composite(account.id),
            external=False,
            in_scope=account.id in scope,
        )

    @staticmethod
    def _scope_amount(legs, endpoints):
        values = [value for key, value in legs.items() if endpoints[key]["in_scope"]]
        return max(
            sum(max(0, value) for value in values),
            sum(max(0, -value) for value in values),
        )

    @staticmethod
    def _pairs(legs):
        """Only a one-to-many or many-to-one journal has a unique pairing."""
        negative = [(key, -value) for key, value in legs.items() if value < 0]
        positive = [(key, value) for key, value in legs.items() if value > 0]
        if (
            not negative
            or not positive
            or sum(v for _, v in negative) != sum(v for _, v in positive)
        ):
            return None
        if len(negative) == 1:
            return [(negative[0][0], key, value) for key, value in positive]
        if len(positive) == 1:
            return [(key, positive[0][0], value) for key, value in negative]
        return None

    @staticmethod
    def _serialize(transaction, entries, graph, categories, bill_links):
        return dict(
            id=transaction.id,
            bill_id=bill_links.get(transaction.id),
            kind=transaction.kind,
            occurred_at=transaction.occurred_at,
            posted_at=transaction.posted_at,
            counterparty=transaction.counterparty,
            note=transaction.note,
            source=transaction.source,
            status=transaction.status,
            tags=json.loads(transaction.tags),
            related_id=transaction.related_id,
            reversal_of=transaction.reversal_of,
            amount=sum(max(0, entry.amount) for entry in entries),
            entries=[
                dict(
                    account_id=graph.canonical(entry.account_id).id,
                    account=graph.canonical(entry.account_id).name,
                    role=graph.canonical(entry.account_id).role,
                    original_account_id=entry.account_id,
                    original_account=graph.accounts[entry.account_id].name,
                    original_role=graph.accounts[entry.account_id].role,
                    amount=entry.amount,
                    category_id=(
                        categories.canonical(entry.category_id).id
                        if entry.category_id
                        else None
                    ),
                    category=(
                        categories.canonical(entry.category_id).name
                        if entry.category_id
                        else ""
                    ),
                )
                for entry in entries
            ],
        )

    def analyze(self, filters=None):
        filters = filters or {}
        with self.db.read() as session:
            graph = AccountGraph(session)
            funding = {
                account.id: account
                for account in graph.accounts.values()
                if not account.merged_into_id and account.role in ("ASSET", "LIABILITY")
            }
            account_id = (
                graph.canonical(filters["account_id"]).id
                if self.periods._has(filters.get("account_id"))
                else None
            )
            group_id = (
                int(filters["group_id"])
                if self.periods._has(filters.get("group_id"))
                else None
            )
            groups = None
            if group_id is not None:
                groups = (
                    {None}
                    if group_id == 0
                    else AccountGroupService.descendants(session, group_id)
                )
            account_scope = ReportAccountScope(session, filters)
            excluded_ids = account_scope.excluded_ids
            scope = {
                key
                for key, account in funding.items()
                if (account_id is None or key == account_id)
                and (groups is None or account.group_id in groups)
                and key not in excluded_ids
            }
            members = {
                key for key in graph.accounts if graph.canonical(key).id in scope
            }
            start, end = self.periods._period(session, members, filters)
            endpoints = {
                f"account:{key}": self._account_endpoint(funding[key], graph, scope)
                for key in scope
            }
            groups_projection = [
                dict(id=group.id, name=group.name, parent_id=group.parent_id)
                for group in session.query(AccountGroup).order_by(AccountGroup.id)
            ]
            query = session.query(Transaction).filter(
                Transaction.occurred_at >= start, Transaction.occurred_at <= end
            )
            entries = defaultdict(list)
            for entry in (
                session.query(Entry)
                .join(Transaction, Transaction.id == Entry.transaction_id)
                .filter(
                    Transaction.occurred_at >= start, Transaction.occurred_at <= end
                )
            ):
                entries[entry.transaction_id].append(entry)
            bill_links = {
                row.transaction_id: row.bill_id
                for row in session.query(BillJournalHistory)
                if row.transaction_id
            }
            categories = CategoryGraph(session)
            flows, details, unallocated = [], [], []
            excluded = {
                key: dict(
                    reason=key,
                    label=label,
                    transaction_count=0,
                    amount=0,
                    transaction_ids=[],
                )
                for key, label in self.EXCLUSIONS.items()
            }
            merged_internal = dict(transaction_count=0, amount=0, transaction_ids=[])
            for transaction in query.order_by(
                Transaction.occurred_at.desc(), Transaction.id.desc()
            ):
                journal = entries[transaction.id]
                if not any(
                    graph.canonical(entry.account_id).id in scope for entry in journal
                ):
                    continue
                fund_legs = defaultdict(int)
                gross_by_account = defaultdict(lambda: [0, 0])
                for entry in journal:
                    account = graph.canonical(entry.account_id)
                    if account.id not in funding:
                        continue
                    key = f"account:{account.id}"
                    if key not in endpoints:
                        endpoints[key] = self._account_endpoint(account, graph, scope)
                    fund_legs[key] += entry.amount
                    gross_by_account[key][entry.amount > 0] += abs(entry.amount)
                scope_amount = self._scope_amount(fund_legs, endpoints)
                reason = self._exclusion(transaction)
                if reason:
                    item = excluded[reason]
                    item["transaction_count"] += 1
                    item["amount"] += scope_amount
                    item["transaction_ids"].append(transaction.id)
                    continue
                cancellation = sum(
                    min(values)
                    for key, values in gross_by_account.items()
                    if endpoints[key]["in_scope"]
                )
                if cancellation:
                    merged_internal["transaction_count"] += 1
                    merged_internal["amount"] += cancellation
                    merged_internal["transaction_ids"].append(transaction.id)
                legs = defaultdict(int, fund_legs)
                invalid_external = False
                for entry in journal:
                    account = graph.canonical(entry.account_id)
                    if account.id in funding:
                        continue
                    if account.role == "EXTERNAL":
                        direction = "in" if entry.amount < 0 else "out"
                        key = f"external-account:{account.id}:{direction}"
                        endpoints.setdefault(
                            key,
                            dict(
                                key=key,
                                account_id=account.id,
                                name=account.name,
                                role="EXTERNAL",
                                kind=account.kind,
                                group_id=account.group_id,
                                external=True,
                                in_scope=False,
                            ),
                        )
                    else:
                        expected = "收入" if transaction.kind == "INCOME" else "消费"
                        expected_negative = transaction.kind in ("INCOME", "REFUND")
                        if (
                            transaction.kind not in self.EXTERNAL
                            or account.role != "SYSTEM"
                            or account.name != expected
                            or (entry.amount < 0) != expected_negative
                        ):
                            invalid_external = True
                            continue
                        key, name = self.EXTERNAL[transaction.kind]
                        endpoints.setdefault(
                            key,
                            dict(
                                key=key,
                                name=name,
                                role="EXTERNAL",
                                kind=transaction.kind,
                                group_id=None,
                                external=True,
                                in_scope=False,
                            ),
                        )
                    legs[key] += entry.amount
                legs = {key: value for key, value in legs.items() if value}
                detail = self._serialize(
                    transaction, journal, graph, categories, bill_links
                )
                detail.update(flow_ids=[], flow_amount=0, scope_amount=scope_amount)
                if not legs and not invalid_external:
                    detail["allocation"] = "merged_internal"
                    details.append(detail)
                    continue
                pairs = None if invalid_external else self._pairs(legs)
                if pairs is None:
                    amount = max(
                        sum(max(0, value) for value in legs.values()),
                        sum(max(0, -value) for value in legs.values()),
                    )
                    detail["allocation"] = "unallocated"
                    unallocated.append(
                        dict(
                            transaction_id=transaction.id,
                            amount=amount,
                            scope_amount=scope_amount,
                            reason="交易包含多方资金或无法核对的去向，未能唯一配对",
                            legs=[
                                dict(endpoint=key, amount=value)
                                for key, value in sorted(legs.items())
                            ],
                        )
                    )
                else:
                    detail["allocation"] = "allocated"
                    for index, (source, target, amount) in enumerate(pairs):
                        if (
                            not endpoints[source]["in_scope"]
                            and not endpoints[target]["in_scope"]
                        ):
                            continue
                        flow_kind = (
                            "TRANSFER"
                            if not endpoints[source]["external"]
                            and not endpoints[target]["external"]
                            else transaction.kind
                        )
                        flow = dict(
                            id=f"flow:{transaction.id}:{index}",
                            source=source,
                            target=target,
                            kind=flow_kind,
                            transaction_kind=transaction.kind,
                            transaction_id=transaction.id,
                            amount=amount,
                            occurred_at=transaction.occurred_at,
                        )
                        flows.append(flow)
                        detail["flow_ids"].append(flow["id"])
                        detail["flow_amount"] += amount
                details.append(detail)
            used = (
                {key for flow in flows for key in (flow["source"], flow["target"])}
                | {leg["endpoint"] for item in unallocated for leg in item["legs"]}
                | {f"account:{key}" for key in scope}
            )
            totals = dict(
                amount=sum(flow["amount"] for flow in flows),
                transaction_count=len(details),
                allocated_transaction_count=len(
                    {flow["transaction_id"] for flow in flows}
                ),
                unallocated_amount=sum(row["scope_amount"] for row in unallocated),
                unallocated_transaction_count=len(unallocated),
            )
            for kind in ("TRANSFER", "INCOME", "EXPENSE", "REFUND"):
                totals[kind.lower()] = sum(
                    flow["amount"] for flow in flows if flow["kind"] == kind
                )
            totals.update(
                external_inflow=0,
                external_outflow=0,
                boundary_inflow=0,
                boundary_outflow=0,
                scope_inflow=0,
                scope_outflow=0,
                internal_transfer=0,
            )
            for flow in flows:
                source, target = endpoints[flow["source"]], endpoints[flow["target"]]
                amount = flow["amount"]
                if target["in_scope"] and not source["in_scope"]:
                    totals["scope_inflow"] += amount
                    totals[
                        "external_inflow" if source["external"] else "boundary_inflow"
                    ] += amount
                if source["in_scope"] and not target["in_scope"]:
                    totals["scope_outflow"] += amount
                    totals[
                        "external_outflow" if target["external"] else "boundary_outflow"
                    ] += amount
                if source["in_scope"] and target["in_scope"]:
                    totals["internal_transfer"] += amount
                    totals["scope_inflow"] += amount
                    totals["scope_outflow"] += amount
            totals["scope_net"] = totals["scope_inflow"] - totals["scope_outflow"]
            return dict(
                start=start[:10],
                end=end[:10],
                start_at=start,
                end_at=end,
                basis="posted_actual_fund_flows",
                scope_account_ids=sorted(scope),
                account_scope=account_scope.projection(),
                applied_filters=dict(
                    start=filters.get("start"),
                    end=filters.get("end"),
                    account_id=account_id,
                    group_id=group_id,
                    excluded_account_ids=sorted(excluded_ids),
                ),
                ignored_filters=[
                    key
                    for key in self.periods.TRANSACTION_FILTERS
                    if self.periods._has(filters.get(key))
                ],
                endpoints=[endpoints[key] for key in sorted(used)],
                groups=groups_projection,
                flows=flows,
                transactions=details,
                unallocated=unallocated,
                excluded=[
                    item for item in excluded.values() if item["transaction_count"]
                ],
                merged_internal=merged_internal,
                totals=totals,
            )
