import uuid

import pytest

from app.account_config import AccountGroupService, AccountMergeService
from app.account_movements import AccountMovementService
from app.database import Database
from app.domain import Clock, DomainError, Posting
from app.fund_flows import FundFlowService
from app.models import Account, Entry, Transaction
from app.securities import SecuritiesValuationService
from app.services import (
    AccountService,
    CatalogService,
    ReportService,
    TransactionService,
)


@pytest.fixture
def flow_ledger(tmp_path, monkeypatch):
    monkeypatch.setattr(Clock, "now", staticmethod(lambda: "2026-10-18 12:00:00"))
    db = Database(tmp_path / "flows.db")
    db.initialize()
    groups = AccountGroupService(db)
    family = groups.save(dict(name="流转家庭"))["id"]
    mine = groups.save(dict(name="甲组", parent_id=family))["id"]
    other = groups.save(dict(name="乙组", parent_id=family))["id"]
    accounts = AccountService(db)

    def account(name, group, role="ASSET", kind="银行卡", opening=None):
        key = accounts.save(dict(name=name, role=role, kind=kind, group_id=group))["id"]
        if opening is not None:
            accounts.opening(key, dict(amount=opening, occurred_at="2026-10-01"))
        return key

    bank = account("甲资金", mine, opening="1000")
    peer = account("乙资金", other)
    third = account("第三方资金", other)
    credit = account("借款账户", mine, "LIABILITY", "信用卡", "-300")
    wealth = account("证券资金", mine, kind="证券")
    external = account("实际商户", other, "EXTERNAL")
    categories = CatalogService(db).categories()
    food = next(row["id"] for row in categories if row["name"] == "餐饮")
    salary = next(row["id"] for row in categories if row["name"] == "工资")
    tx = TransactionService(db)

    def post(kind, account, amount, when, **extra):
        return tx.post(
            dict(
                kind=kind,
                account_id=account,
                amount=amount,
                occurred_at=when,
                category_id=salary if kind == "INCOME" else food,
                idempotency_key=str(uuid.uuid4()),
                **extra,
            )
        )["id"]

    income = post("INCOME", bank, "100", "2026-10-02", counterparty="单位")
    payment = post("EXPENSE", bank, "200", "2026-10-03")
    refund = post("REFUND", bank, "30", "2026-10-04", related_id=payment)
    boundary = post("TRANSFER", bank, "70", "2026-10-05", to_account_id=peer)
    loan = post("TRANSFER", credit, "50", "2026-10-06", to_account_id=bank)
    repayment = post("TRANSFER", bank, "20", "2026-10-07", to_account_id=credit)
    credit_payment = post("EXPENSE", credit, "40", "2026-10-08")
    peer_income = post("INCOME", peer, "22", "2026-10-09")
    cancelled = post("EXPENSE", bank, "15", "2026-10-10")
    tx.reverse(cancelled)
    securities = SecuritiesValuationService(db)
    securities.update(
        wealth, dict(actual="500", occurred_at="2026-10-01", idempotency_key="baseline")
    )
    securities.update(
        wealth, dict(actual="580", occurred_at="2026-10-11", idempotency_key="gain")
    )
    securities.update(
        wealth, dict(actual="560", occurred_at="2026-10-12", idempotency_key="loss")
    )
    with db.write() as session:
        adjustment = (
            session.query(Account).filter_by(role="SYSTEM", name="余额调整").one()
        )
        tx._write(
            session,
            dict(
                kind="ADJUSTMENT",
                occurred_at="2026-10-13",
                idempotency_key="adjustment",
            ),
            [Posting(bank, 1000), Posting(adjustment.id, -1000)],
        )
    return db, dict(
        family=family,
        mine=mine,
        other=other,
        bank=bank,
        peer=peer,
        third=third,
        credit=credit,
        wealth=wealth,
        external=external,
        income=income,
        payment=payment,
        refund=refund,
        boundary=boundary,
        loan=loan,
        repayment=repayment,
        credit_payment=credit_payment,
        peer_income=peer_income,
        cancelled=cancelled,
        food=food,
        salary=salary,
    )


def filters(ids, **extra):
    return dict(
        dict(
            start="2026-10-01",
            end="2026-10-18",
            group_id=ids["family"],
            exclude_investment_accounts=False,
            exclude_single_accounts=False,
        ),
        **extra,
    )


def endpoint_map(result):
    return {row["key"]: row for row in result["endpoints"]}


def assert_flows(result):
    endpoints = endpoint_map(result)
    details = {row["id"]: row for row in result["transactions"]}
    assert result["totals"]["amount"] == sum(row["amount"] for row in result["flows"])
    assert result["totals"]["allocated_transaction_count"] == len(
        {row["transaction_id"] for row in result["flows"]}
    )
    totals = result["totals"]
    assert (
        totals["scope_inflow"]
        == totals["external_inflow"]
        + totals["boundary_inflow"]
        + totals["internal_transfer"]
    )
    assert (
        totals["scope_outflow"]
        == totals["external_outflow"]
        + totals["boundary_outflow"]
        + totals["internal_transfer"]
    )
    assert totals["scope_net"] == totals["scope_inflow"] - totals["scope_outflow"]
    for flow in result["flows"]:
        assert flow["amount"] > 0 and flow["source"] != flow["target"]
        assert (
            endpoints[flow["source"]]["in_scope"]
            or endpoints[flow["target"]]["in_scope"]
        )
        assert flow["id"] in details[flow["transaction_id"]]["flow_ids"]
    for row in details.values():
        assert row["flow_amount"] == sum(
            flow["amount"]
            for flow in result["flows"]
            if flow["transaction_id"] == row["id"]
        )
        assert row["status"] == "POSTED" and row["kind"] not in (
            "OPENING",
            "REVERSAL",
            "ADJUSTMENT",
        )


def test_actual_flows_exclude_opening_valuation_and_reversed_and_do_not_double_loans(
    flow_ledger,
):
    db, ids = flow_ledger
    result = FundFlowService(db).analyze(filters(ids))
    assert_flows(result)
    totals = result["totals"]
    assert (
        totals["amount"],
        totals["income"],
        totals["expense"],
        totals["refund"],
        totals["transfer"],
    ) == (53200, 12200, 24000, 3000, 14000)
    assert totals["external_inflow"] == 15200 and totals["external_outflow"] == 24000
    assert (
        totals["internal_transfer"] == 14000
        and totals["boundary_inflow"] == totals["boundary_outflow"] == 0
    )
    assert totals["transaction_count"] == 8 and not result["unallocated"]
    by_id = {row["transaction_id"]: row for row in result["flows"]}
    assert (by_id[ids["loan"]]["source"], by_id[ids["loan"]]["target"]) == (
        f"account:{ids['credit']}",
        f"account:{ids['bank']}",
    )
    assert by_id[ids["repayment"]]["target"] == f"account:{ids['credit']}"
    assert by_id[ids["refund"]]["source"] == "external:refund"
    excluded = {row["reason"]: row for row in result["excluded"]}
    assert excluded["OPENING"]["amount"] == 180000
    assert excluded["VALUATION"]["amount"] == 10000
    assert excluded["ADJUSTMENT"]["amount"] == 1000
    assert excluded["REVERSED"]["transaction_ids"] == [ids["cancelled"]]
    assert excluded["REVERSAL"]["amount"] == 1500


def test_scope_keeps_actual_outside_account_and_filters_cannot_turn_transfer_into_income(
    flow_ledger,
):
    db, ids = flow_ledger
    result = FundFlowService(db).analyze(
        dict(
            filters(ids),
            group_id=ids["mine"],
            category_id=ids["food"],
            tag="不存在",
            q="不存在",
            kind="INCOME",
        )
    )
    assert_flows(result)
    assert {"category_id", "tag", "q", "kind"} <= set(result["ignored_filters"])
    assert ids["peer"] not in result["scope_account_ids"]
    peer = endpoint_map(result)[f"account:{ids['peer']}"]
    assert peer["name"] == "乙资金" and not peer["in_scope"] and not peer["external"]
    assert result["totals"]["boundary_outflow"] == 7000
    assert result["totals"]["income"] == 10000 and result["totals"]["transfer"] == 14000
    one = FundFlowService(db).analyze(filters(ids, account_id=ids["peer"]))
    assert one["scope_account_ids"] == [ids["peer"]]
    assert one["totals"]["boundary_inflow"] == 7000
    assert one["totals"]["scope_inflow"] == 9200
    empty = FundFlowService(db).analyze(
        dict(filters(ids), group_id=ids["mine"], account_id=ids["peer"])
    )
    assert not empty["flows"] and not empty["scope_account_ids"]


@pytest.mark.parametrize("group_id", [0, "0"])
def test_ungrouped_scope_uses_canonical_group_and_keeps_outside_counterparties(
    flow_ledger, group_id
):
    db, ids = flow_ledger
    AccountGroupService(db).assign(None, [ids["bank"]])
    service = FundFlowService(db)
    result = service.analyze(dict(filters(ids), group_id=group_id))
    assert_flows(result)
    assert result["applied_filters"]["group_id"] == 0
    assert ids["bank"] in result["scope_account_ids"]
    assert ids["peer"] not in result["scope_account_ids"]
    assert all(
        endpoint["group_id"] is None
        for endpoint in result["endpoints"]
        if endpoint["in_scope"]
    )
    peer = endpoint_map(result)[f"account:{ids['peer']}"]
    assert peer["name"] == "乙资金" and not peer["in_scope"]
    assert result["totals"]["boundary_inflow"] == 5000
    assert result["totals"]["boundary_outflow"] == 9000
    AccountMergeService(db).merge(dict(source_id=ids["peer"], target_id=ids["bank"]))
    alias = service.analyze(
        dict(filters(ids), group_id=group_id, account_id=ids["peer"])
    )
    assert alias["scope_account_ids"] == [ids["bank"]]
    assert alias["totals"]["income"] == 12200
    empty = service.analyze(
        dict(filters(ids), group_id=group_id, account_id=ids["credit"])
    )
    assert not empty["scope_account_ids"] and not empty["flows"]


def test_canonical_merge_cancels_internal_transfer_and_resolves_alias(flow_ledger):
    db, ids = flow_ledger
    AccountMergeService(db).merge(dict(source_id=ids["peer"], target_id=ids["bank"]))
    result = FundFlowService(db).analyze(filters(ids, account_id=ids["peer"]))
    assert_flows(result)
    assert result["scope_account_ids"] == [ids["bank"]]
    assert result["applied_filters"]["account_id"] == ids["bank"]
    assert ids["boundary"] not in {row["transaction_id"] for row in result["flows"]}
    assert result["merged_internal"] == dict(
        transaction_count=1, amount=7000, transaction_ids=[ids["boundary"]]
    )
    detail = next(row for row in result["transactions"] if row["id"] == ids["boundary"])
    assert detail["allocation"] == "merged_internal" and detail["scope_amount"] == 0
    assert (
        detail["entries"][0]["original_account_id"]
        != detail["entries"][1]["original_account_id"]
    )


def test_composite_merge_cancels_borrowing_and_repayment_without_dropping_credit_payments(
    flow_ledger,
):
    db, ids = flow_ledger
    AccountMergeService(db).merge(dict(source_id=ids["credit"], target_id=ids["bank"]))
    result = FundFlowService(db).analyze(filters(ids, account_id=ids["bank"]))
    assert_flows(result)
    assert result["merged_internal"]["amount"] == 7000
    assert set(result["merged_internal"]["transaction_ids"]) == {
        ids["loan"],
        ids["repayment"],
    }
    payment = next(
        row for row in result["flows"] if row["transaction_id"] == ids["credit_payment"]
    )
    assert payment["source"] == f"account:{ids['bank']}" and payment["amount"] == 4000
    detail = next(
        row for row in result["transactions"] if row["id"] == ids["credit_payment"]
    )
    assert any(
        entry["original_role"] == "LIABILITY" and entry["role"] == "ASSET"
        for entry in detail["entries"]
    )


def test_merged_internal_explanation_counts_only_selected_account_cancellation(
    flow_ledger,
):
    db, ids = flow_ledger
    merges = AccountMergeService(db)
    merges.merge(dict(source_id=ids["credit"], target_id=ids["bank"]))
    merges.merge(dict(source_id=ids["peer"], target_id=ids["third"]))
    transaction_id = write_journal(
        db,
        "TRANSFER",
        "2026-10-14",
        [
            Posting(ids["bank"], -100),
            Posting(ids["credit"], 100),
            Posting(ids["third"], -200),
            Posting(ids["peer"], 200),
        ],
    )
    result = FundFlowService(db).analyze(
        dict(filters(ids), start="2026-10-14", end="2026-10-14", account_id=ids["bank"])
    )
    assert not result["flows"]
    assert result["merged_internal"] == dict(
        transaction_count=1, amount=100, transaction_ids=[transaction_id]
    )


def write_journal(db, kind, when, postings):
    with db.write() as session:
        return (
            TransactionService(db)
            ._write(
                session,
                dict(kind=kind, occurred_at=when, idempotency_key=str(uuid.uuid4())),
                postings,
            )
            .id
        )


def test_unique_split_and_ambiguous_many_to_many_never_invent_pairings(flow_ledger):
    db, ids = flow_ledger
    one_many = write_journal(
        db,
        "TRANSFER",
        "2026-10-14",
        [
            Posting(ids["bank"], -1000),
            Posting(ids["peer"], 600),
            Posting(ids["third"], 400),
        ],
    )
    complex_id = write_journal(
        db,
        "TRANSFER",
        "2026-10-15",
        [
            Posting(ids["bank"], -600),
            Posting(ids["credit"], -400),
            Posting(ids["peer"], 500),
            Posting(ids["third"], 500),
        ],
    )
    result = FundFlowService(db).analyze(
        dict(filters(ids), start="2026-10-14", end="2026-10-15")
    )
    assert_flows(result)
    assert sorted(flow["amount"] for flow in result["flows"]) == [400, 600]
    assert {flow["transaction_id"] for flow in result["flows"]} == {one_many}
    assert (
        result["totals"]["amount"] == 1000
        and result["totals"]["unallocated_amount"] == 1000
    )
    assert result["unallocated"][0]["transaction_id"] == complex_id
    assert sum(leg["amount"] for leg in result["unallocated"][0]["legs"]) == 0
    assert len(result["unallocated"][0]["legs"]) == 4
    limited = FundFlowService(db).analyze(
        dict(
            filters(ids), start="2026-10-14", end="2026-10-15", account_id=ids["credit"]
        )
    )
    assert not limited["flows"] and limited["totals"]["unallocated_amount"] == 400
    assert limited["unallocated"][0]["amount"] == 1000


def test_multi_funding_external_expense_and_mixed_borrow_income_use_actual_amounts(
    flow_ledger,
):
    db, ids = flow_ledger
    with db.read() as session:
        spending = session.query(Account).filter_by(role="SYSTEM", name="消费").one().id
        income = session.query(Account).filter_by(role="SYSTEM", name="收入").one().id
    split = write_journal(
        db,
        "EXPENSE",
        "2026-10-14",
        [
            Posting(ids["bank"], -600),
            Posting(ids["credit"], -400),
            Posting(spending, 1000, ids["food"]),
        ],
    )
    mixed = write_journal(
        db,
        "INCOME",
        "2026-10-15",
        [
            Posting(ids["bank"], 1000),
            Posting(ids["credit"], -400),
            Posting(income, -600, ids["salary"]),
        ],
    )
    result = FundFlowService(db).analyze(
        dict(filters(ids), start="2026-10-14", end="2026-10-15")
    )
    assert_flows(result)
    assert not result["unallocated"]
    assert sorted(
        flow["amount"] for flow in result["flows"] if flow["transaction_id"] == split
    ) == [400, 600]
    assert result["totals"]["income"] == 600 and result["totals"]["transfer"] == 400
    borrowing = next(
        flow
        for flow in result["flows"]
        if flow["transaction_id"] == mixed and flow["kind"] == "TRANSFER"
    )
    assert borrowing["transaction_kind"] == "INCOME"


def test_external_named_transfer_keeps_real_counterparty_and_direction(flow_ledger):
    db, ids = flow_ledger
    write_journal(
        db,
        "TRANSFER",
        "2026-10-14",
        [Posting(ids["bank"], -900), Posting(ids["external"], 900)],
    )
    write_journal(
        db,
        "TRANSFER",
        "2026-10-15",
        [Posting(ids["external"], -300), Posting(ids["bank"], 300)],
    )
    result = FundFlowService(db).analyze(
        dict(filters(ids), start="2026-10-14", end="2026-10-15")
    )
    assert_flows(result)
    external = [row for row in result["endpoints"] if row["external"]]
    assert len(external) == 2 and all(row["name"] == "实际商户" for row in external)
    assert (
        result["totals"]["external_inflow"] == 300
        and result["totals"]["external_outflow"] == 900
    )
    assert result["totals"]["income"] == 0 and result["totals"]["transfer"] == 1200


def test_period_boundaries_validation_and_read_only(flow_ledger):
    db, ids = flow_ledger
    before_integrity = ReportService(db).integrity()
    with db.read() as session:
        before = [
            (row.id, row.account_id, row.amount, row.category_id)
            for row in session.query(Entry)
        ]
        before_transactions = [
            (row.id, row.kind, row.status) for row in session.query(Transaction)
        ]
    service = FundFlowService(db)
    day = service.analyze(dict(filters(ids), start="2026-10-02", end="2026-10-02"))
    assert day["totals"]["amount"] == 10000
    no_midnight = service.analyze(
        dict(filters(ids), start="2026-10-02 00:00:01", end="2026-10-02 23:59:59")
    )
    assert no_midnight["totals"]["amount"] == 0
    zoned = service.analyze(
        dict(
            filters(ids),
            start="2026-10-01T16:00:00+00:00",
            end="2026-10-02T15:59:59+00:00",
        )
    )
    assert zoned["flows"] == day["flows"]
    for extra in ({"start": "bad"}, {"end": "2026-02-30"}, {"start": "2026-10-19"}):
        with pytest.raises(DomainError):
            service.analyze(dict(filters(ids), **extra))
    with db.read() as session:
        assert before == [
            (row.id, row.account_id, row.amount, row.category_id)
            for row in session.query(Entry)
        ]
        assert before_transactions == [
            (row.id, row.kind, row.status) for row in session.query(Transaction)
        ]
    assert ReportService(db).integrity() == before_integrity


def test_period_initialization_is_excluded_from_operating_change_but_real_valuation_remains(
    flow_ledger,
):
    db, ids = flow_ledger
    movements = AccountMovementService(db).analyze(filters(ids))
    rows = {row["id"]: row for row in movements["accounts"]}
    bank, credit, wealth = (rows[ids[key]] for key in ("bank", "credit", "wealth"))
    assert bank["opening_added"] == 100000
    assert credit["opening_added"] == -30000
    assert wealth["opening_added"] == 50000
    assert wealth["operating_change"] == 6000
    assert wealth["operating_inflow"] == 8000 and wealth["operating_outflow"] == 2000
    assert (
        wealth["ending_balance"]
        == wealth["opening_balance"]
        + wealth["opening_added"]
        + wealth["operating_change"]
    )
    assert (
        movements["totals"]["operating_change"]
        == movements["totals"]["net_change"] - 120000
    )
    for row in rows.values():
        assert (
            row["operating_change"]
            == row["operating_inflow"] - row["operating_outflow"]
        )
