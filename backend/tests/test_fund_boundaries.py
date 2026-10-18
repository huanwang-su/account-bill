import json

from app.account_config import AccountGroupService, AccountMergeService
from app.domain import Posting
from app.fund_boundaries import FundBoundaryService
from app.fund_flows import FundFlowService
from test_fund_flows import flow_ledger, filters, write_journal


def scopes_by_id(report, dimension):
    return {row[f"{dimension}_id"]: row for row in report[f"{dimension}_scopes"]}


def assert_boundary_scopes(report):
    flows = {flow["id"]: flow for flow in report["flows"]}
    endpoints = {row["key"]: row for row in report["endpoints"]}
    for scope in [
        report["summary"],
        *report["group_scopes"],
        *report["account_scopes"],
    ]:
        accounts = set(scope["account_ids"])
        incoming = [flows[key] for key in scope["incoming_flow_ids"]]
        outgoing = [flows[key] for key in scope["outgoing_flow_ids"]]
        assert scope["incoming"] == sum(flow["amount"] for flow in incoming)
        assert scope["outgoing"] == sum(flow["amount"] for flow in outgoing)
        assert scope["net"] == scope["incoming"] - scope["outgoing"]
        assert scope["flow_ids"] == sorted(
            set(scope["incoming_flow_ids"] + scope["outgoing_flow_ids"])
        )
        assert scope["count"] == len(
            set(scope["incoming_transaction_ids"] + scope["outgoing_transaction_ids"])
        )
        assert scope["count"] == len(scope["transaction_ids"])
        assert (
            scope["internal_excluded"]
            == scope["paired_internal_excluded"]
            + scope["merged_internal_excluded"]
            + scope["unallocated_internal_excluded"]
        )
        for flow in incoming:
            assert endpoints[flow["target"]].get("account_id") in accounts
            assert (
                endpoints[flow["source"]]["external"]
                or endpoints[flow["source"]].get("account_id") not in accounts
            )
        for flow in outgoing:
            assert endpoints[flow["source"]].get("account_id") in accounts
            assert (
                endpoints[flow["target"]]["external"]
                or endpoints[flow["target"]].get("account_id") not in accounts
            )
        assert not set(scope["flow_ids"]) & set(scope["internal_flow_ids"])


def test_overall_boundary_counts_only_actual_external_money_and_preserves_gross_report(
    flow_ledger,
):
    db, ids = flow_ledger
    source = FundFlowService(db).analyze(filters(ids))
    before = json.dumps(source, ensure_ascii=False, sort_keys=True)
    report = FundBoundaryService.project(source)
    assert json.dumps(source, ensure_ascii=False, sort_keys=True) == before
    assert_boundary_scopes(report)
    summary = report["summary"]
    assert (
        summary["incoming"],
        summary["outgoing"],
        summary["net"],
        summary["count"],
    ) == (15200, 24000, -8800, 5)
    assert summary["internal_excluded"] == 14000 and summary["internal_count"] == 3
    assert summary["unallocated_amount"] == 0
    assert source["totals"]["scope_inflow"] == 29200
    assert source["totals"]["scope_outflow"] == 38000
    assert "totals" not in report
    assert {row["reason"] for row in report["excluded"]} == {
        "OPENING",
        "VALUATION",
        "ADJUSTMENT",
        "REVERSED",
        "REVERSAL",
    }


def test_parent_groups_include_descendants_but_do_not_sum_child_turnover(flow_ledger):
    db, ids = flow_ledger
    report = FundBoundaryService(db).analyze(filters(ids))
    assert_boundary_scopes(report)
    groups = scopes_by_id(report, "group")
    parent, mine, other = (groups[ids[key]] for key in ("family", "mine", "other"))
    assert set(parent["account_ids"]) == set(mine["account_ids"]) | set(
        other["account_ids"]
    )
    assert (parent["incoming"], parent["outgoing"]) == (15200, 24000)
    assert (mine["incoming"], mine["outgoing"], mine["net"]) == (13000, 31000, -18000)
    assert (other["incoming"], other["outgoing"], other["net"]) == (9200, 0, 9200)
    assert mine["internal_excluded"] == 7000 and mine["internal_count"] == 2
    assert other["internal_excluded"] == 0
    assert parent["incoming"] != mine["incoming"] + other["incoming"]
    assert parent["net"] == mine["net"] + other["net"]
    assert ids["boundary"] in mine["outgoing_transaction_ids"]
    assert ids["boundary"] in other["incoming_transaction_ids"]
    assert ids["boundary"] not in parent["transaction_ids"]


def test_accounts_count_peer_borrowing_and_repayment_as_boundary_without_business_income_labels(
    flow_ledger,
):
    db, ids = flow_ledger
    report = FundBoundaryService(db).analyze(filters(ids))
    assert_boundary_scopes(report)
    accounts = scopes_by_id(report, "account")
    bank, credit, wealth = (accounts[ids[key]] for key in ("bank", "credit", "wealth"))
    assert (bank["incoming"], bank["outgoing"], bank["net"]) == (18000, 29000, -11000)
    assert (credit["incoming"], credit["outgoing"], credit["net"]) == (
        2000,
        9000,
        -7000,
    )
    assert ids["loan"] in bank["incoming_transaction_ids"]
    assert ids["repayment"] in bank["outgoing_transaction_ids"]
    assert wealth["incoming"] == wealth["outgoing"] == wealth["count"] == 0
    loan = next(
        flow for flow in report["flows"] if flow["transaction_id"] == ids["loan"]
    )
    assert loan["kind"] == "TRANSFER"


def test_outer_scope_intersects_all_entities_and_retains_outside_actual_name(
    flow_ledger,
):
    db, ids = flow_ledger
    service = FundBoundaryService(db)
    report = service.analyze(
        dict(filters(ids), group_id=ids["mine"], tag="不存在", category_id=ids["food"])
    )
    assert_boundary_scopes(report)
    assert report["scope_mode"] == "intersection_with_selected_accounts"
    assert {"tag", "category_id"} <= set(report["ignored_filters"])
    assert set(scopes_by_id(report, "group")) == {ids["family"], ids["mine"]}
    assert (
        report["summary"]["incoming"] == 13000
        and report["summary"]["outgoing"] == 31000
    )
    assert all(
        set(scope["account_ids"]) <= set(report["scope_account_ids"])
        for scope in report["group_scopes"]
    )
    peer = next(
        row for row in report["endpoints"] if row.get("account_id") == ids["peer"]
    )
    assert peer["name"] == "乙资金" and not peer["in_scope"]
    empty = service.analyze(
        dict(filters(ids), group_id=ids["mine"], account_id=ids["peer"])
    )
    assert (
        empty["summary"]["count"] == 0
        and not empty["group_scopes"]
        and not empty["account_scopes"]
    )


def test_canonical_cancellation_is_internal_exclusion_for_its_group_and_account(
    flow_ledger,
):
    db, ids = flow_ledger
    AccountMergeService(db).merge(dict(source_id=ids["peer"], target_id=ids["bank"]))
    report = FundBoundaryService(db).analyze(filters(ids))
    assert_boundary_scopes(report)
    bank = scopes_by_id(report, "account")[ids["bank"]]
    assert bank["merged_internal_excluded"] == bank["internal_excluded"] == 7000
    assert bank["internal_transaction_ids"] == [ids["boundary"]]
    assert ids["boundary"] not in bank["transaction_ids"]
    assert report["summary"]["internal_excluded"] == 14000
    assert report["summary"]["merged_internal_excluded"] == 7000
    alias = FundBoundaryService(db).analyze(filters(ids, account_id=ids["peer"]))
    assert alias["summary"]["account_ids"] == [ids["bank"]]
    assert alias["summary"]["internal_excluded"] == 7000


def test_multileg_flow_ids_select_exact_partial_amount_but_transaction_stays_full(
    flow_ledger,
):
    db, ids = flow_ledger
    transaction_id = write_journal(
        db,
        "TRANSFER",
        "2026-10-14",
        [
            Posting(ids["bank"], -1000),
            Posting(ids["peer"], 600),
            Posting(ids["third"], 400),
        ],
    )
    report = FundBoundaryService(db).analyze(
        dict(filters(ids), start="2026-10-14", end="2026-10-14")
    )
    assert_boundary_scopes(report)
    peer = scopes_by_id(report, "account")[ids["peer"]]
    mine = scopes_by_id(report, "group")[ids["mine"]]
    assert peer["incoming"] == 600 and peer["count"] == 1 and len(peer["flow_ids"]) == 1
    assert (
        mine["outgoing"] == 1000 and len(mine["flow_ids"]) == 2 and mine["count"] == 1
    )
    assert (
        report["summary"]["count"] == 0
        and report["summary"]["internal_excluded"] == 1000
    )
    detail = next(row for row in report["transactions"] if row["id"] == transaction_id)
    assert detail["amount"] == 1000 and len(detail["entries"]) == 3
    flow = next(row for row in report["flows"] if row["id"] == peer["flow_ids"][0])
    assert flow["amount"] == 600 and flow["transaction_id"] == transaction_id


def test_same_transaction_can_have_boundary_leg_and_internal_leg_without_double_count(
    flow_ledger,
):
    db, ids = flow_ledger
    AccountGroupService(db).assign(ids["mine"], [ids["peer"]])
    AccountGroupService(db).assign(ids["other"], [ids["credit"]])
    transaction_id = write_journal(
        db,
        "TRANSFER",
        "2026-10-14",
        [
            Posting(ids["bank"], -600),
            Posting(ids["credit"], -400),
            Posting(ids["peer"], 1000),
        ],
    )
    report = FundBoundaryService(db).analyze(
        dict(filters(ids), start="2026-10-14", end="2026-10-14")
    )
    assert_boundary_scopes(report)
    mine = scopes_by_id(report, "group")[ids["mine"]]
    assert mine["incoming"] == 400 and mine["outgoing"] == 0 and mine["count"] == 1
    assert mine["internal_excluded"] == 600 and mine["internal_count"] == 1
    assert (
        mine["transaction_ids"] == mine["internal_transaction_ids"] == [transaction_id]
    )
    assert len(mine["incoming_flow_ids"]) == len(mine["internal_flow_ids"]) == 1


def test_ambiguous_internal_journal_is_excluded_when_wholly_inside_scope_and_pending_across_scope(
    flow_ledger,
):
    db, ids = flow_ledger
    transaction_id = write_journal(
        db,
        "TRANSFER",
        "2026-10-14",
        [
            Posting(ids["bank"], -600),
            Posting(ids["credit"], -400),
            Posting(ids["peer"], 500),
            Posting(ids["third"], 500),
        ],
    )
    report = FundBoundaryService(db).analyze(
        dict(filters(ids), start="2026-10-14", end="2026-10-14")
    )
    assert_boundary_scopes(report)
    summary = report["summary"]
    assert summary["incoming"] == summary["outgoing"] == summary["count"] == 0
    assert (
        summary["internal_excluded"] == summary["unallocated_internal_excluded"] == 1000
    )
    assert summary["unallocated_amount"] == 0 and summary[
        "internal_transaction_ids"
    ] == [transaction_id]
    mine = scopes_by_id(report, "group")[ids["mine"]]
    assert mine["unallocated_amount"] == 1000 and mine[
        "unallocated_transaction_ids"
    ] == [transaction_id]
    assert mine["internal_excluded"] == 0
    peer = scopes_by_id(report, "account")[ids["peer"]]
    assert peer["unallocated_amount"] == 500 and peer["incoming"] == 0
    assert len(report["unallocated"]) == 1 and not report["flows"]


def test_ungrouped_boundary_scope_is_supported_without_changing_group_hierarchy(
    flow_ledger,
):
    db, ids = flow_ledger
    AccountGroupService(db).assign(None, [ids["bank"]])
    report = FundBoundaryService(db).analyze(dict(filters(ids), group_id="0"))
    assert_boundary_scopes(report)
    groups = scopes_by_id(report, "group")
    assert set(groups) == {0}
    assert groups[0]["name"] == "未分组" and groups[0]["parent_id"] is None
    assert groups[0]["incoming"] == 18000 and groups[0]["outgoing"] == 29000
