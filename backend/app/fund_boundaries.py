"""Independent account scopes count only actual flows crossing their boundary."""

from collections import defaultdict

from .fund_flows import FundFlowService


class FundBoundaryService:
    def __init__(self, database, fund_flows=None):
        self.fund_flows = fund_flows or FundFlowService(database)

    @staticmethod
    def _cancellations(transactions):
        result = {}
        for transaction in transactions:
            amounts = defaultdict(lambda: [0, 0])
            for entry in transaction["entries"]:
                if entry["role"] in ("ASSET", "LIABILITY"):
                    amounts[entry["account_id"]][entry["amount"] > 0] += abs(
                        entry["amount"]
                    )
            canceled = {
                key: min(values) for key, values in amounts.items() if min(values)
            }
            if canceled:
                result[transaction["id"]] = canceled
        return result

    @staticmethod
    def _scope(
        key, level, name, account_ids, report, endpoints, cancellations, **metadata
    ):
        account_ids = set(account_ids)

        def inside(key):
            endpoint = endpoints[key]
            return (
                not endpoint["external"] and endpoint.get("account_id") in account_ids
            )

        incoming, outgoing, internal = [], [], []
        for flow in report["flows"]:
            source, target = inside(flow["source"]), inside(flow["target"])
            if source and target:
                internal.append(flow)
            elif target:
                incoming.append(flow)
            elif source:
                outgoing.append(flow)
        boundary = incoming + outgoing
        merged = {
            transaction_id: sum(
                amount
                for account_id, amount in amounts.items()
                if account_id in account_ids
            )
            for transaction_id, amounts in cancellations.items()
        }
        merged = {key: value for key, value in merged.items() if value}
        unknown, unknown_internal = {}, {}
        for item in report["unallocated"]:
            values = [leg["amount"] for leg in item["legs"] if inside(leg["endpoint"])]
            amount = max(
                sum(max(0, value) for value in values),
                sum(max(0, -value) for value in values),
            )
            if amount:
                if len(values) == len(item["legs"]) and sum(values) == 0:
                    unknown_internal[item["transaction_id"]] = amount
                else:
                    unknown[item["transaction_id"]] = amount
        incoming_amount = sum(flow["amount"] for flow in incoming)
        outgoing_amount = sum(flow["amount"] for flow in outgoing)
        internal_amount = sum(flow["amount"] for flow in internal)
        incoming_ids = sorted({flow["transaction_id"] for flow in incoming})
        outgoing_ids = sorted({flow["transaction_id"] for flow in outgoing})
        transaction_ids = sorted(set(incoming_ids) | set(outgoing_ids))
        internal_ids = sorted(
            {flow["transaction_id"] for flow in internal}
            | set(merged)
            | set(unknown_internal)
        )
        return dict(
            key=key,
            level=level,
            name=name,
            account_ids=sorted(account_ids),
            incoming=incoming_amount,
            outgoing=outgoing_amount,
            net=incoming_amount - outgoing_amount,
            count=len(transaction_ids),
            incoming_count=len(incoming_ids),
            outgoing_count=len(outgoing_ids),
            flow_ids=sorted(flow["id"] for flow in boundary),
            incoming_flow_ids=sorted(flow["id"] for flow in incoming),
            outgoing_flow_ids=sorted(flow["id"] for flow in outgoing),
            transaction_ids=transaction_ids,
            incoming_transaction_ids=incoming_ids,
            outgoing_transaction_ids=outgoing_ids,
            internal_excluded=internal_amount
            + sum(merged.values())
            + sum(unknown_internal.values()),
            internal_count=len(internal_ids),
            internal_flow_ids=sorted(flow["id"] for flow in internal),
            internal_transaction_ids=internal_ids,
            paired_internal_excluded=internal_amount,
            merged_internal_excluded=sum(merged.values()),
            unallocated_internal_excluded=sum(unknown_internal.values()),
            unallocated_amount=sum(unknown.values()),
            unallocated_count=len(unknown),
            unallocated_transaction_ids=sorted(unknown),
            **metadata,
        )

    @classmethod
    def project(cls, report):
        endpoints = {row["key"]: row for row in report["endpoints"]}
        accounts = {
            endpoint["account_id"]: endpoint
            for endpoint in report["endpoints"]
            if not endpoint["external"] and endpoint["in_scope"]
        }
        cancellations = cls._cancellations(report["transactions"])
        summary = cls._scope(
            "total", "total", "选定资金范围", accounts, report, endpoints, cancellations
        )
        group_scopes = []
        for group in report["groups"]:
            descendants = {group["id"]}
            while True:
                more = {
                    row["id"]
                    for row in report["groups"]
                    if row["parent_id"] in descendants
                } - descendants
                if not more:
                    break
                descendants |= more
            members = {
                key
                for key, account in accounts.items()
                if account["group_id"] in descendants
            }
            if members:
                group_scopes.append(
                    cls._scope(
                        f"group:{group['id']}",
                        "group",
                        group["name"],
                        members,
                        report,
                        endpoints,
                        cancellations,
                        group_id=group["id"],
                        parent_id=group["parent_id"],
                    )
                )
        ungrouped = {
            key for key, account in accounts.items() if account["group_id"] is None
        }
        if ungrouped:
            group_scopes.append(
                cls._scope(
                    "group:0",
                    "group",
                    "未分组",
                    ungrouped,
                    report,
                    endpoints,
                    cancellations,
                    group_id=0,
                    parent_id=None,
                )
            )
        account_scopes = [
            cls._scope(
                f"account:{key}",
                "account",
                account["name"],
                [key],
                report,
                endpoints,
                cancellations,
                account_id=key,
                group_id=account["group_id"],
                role=account["role"],
                kind=account["kind"],
            )
            for key, account in sorted(accounts.items())
        ]
        result = {key: value for key, value in report.items() if key != "totals"}
        result.update(
            basis="scope_boundary_actual_fund_flows",
            scope_mode="intersection_with_selected_accounts",
            scope_label="每个范围仅包含当前筛选内的账户；父组包含后代，各范围分别计算，不能相加",
            summary=summary,
            group_scopes=group_scopes,
            account_scopes=account_scopes,
        )
        return result

    def analyze(self, filters=None):
        return self.project(self.fund_flows.analyze(filters))
