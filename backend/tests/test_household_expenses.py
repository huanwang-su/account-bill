import json
import uuid
from collections import defaultdict
import pytest
from fastapi.testclient import TestClient
from app.database import Database
from app.services import (
    AccountService,
    CatalogService,
    TransactionService,
    ReportService,
)
from app.account_config import AccountGroupService, AccountMergeService
from app.models import Category, Entry, Transaction
from app.securities import SecuritiesValuationService
from app.expense_analysis import ExpenseAnalysisService, AnalysisPeriod
from app.financial_analysis import FinancialAnalysisService
from app.overview import OverviewService
from app.balance_sheet import BalanceSheetService
from app.domain import DomainError, Clock
from app.main import LedgerApplication


@pytest.fixture
def household(tmp_path, monkeypatch):
    monkeypatch.setattr(Clock, "now", staticmethod(lambda: "2026-10-03 12:00:00"))
    db = Database(tmp_path / "db")
    db.initialize()
    ac = AccountService(db)
    bank = next(a for a in ac.list() if a["id"] == 6)
    ac.save({**bank, "kind": "银行卡"}, 6)
    groups = AccountGroupService(db)
    family = groups.save(dict(name="测试家庭"))["id"]
    mine = groups.save(dict(name="成员甲", parent_id=family))["id"]
    spouse = groups.save(dict(name="成员乙", parent_id=family))["id"]
    groups.assign(mine, [5])
    groups.assign(spouse, [6])
    ac.opening(5, dict(amount="2000", occurred_at="2026-09-28"))
    wealth = ac.save(dict(name="成员甲证券", kind="证券", role="ASSET", group_id=mine))[
        "id"
    ]
    values = SecuritiesValuationService(db)
    values.update(
        wealth, dict(actual="500", occurred_at="2026-09-28", idempotency_key="baseline")
    )
    cats = CatalogService(db).categories()
    cat = lambda name: next(c["id"] for c in cats if c["name"] == name)
    tx = TransactionService(db)

    def post(
        amount, day="2026-10-01", kind="EXPENSE", category="日常用餐", account=5, **kw
    ):
        return tx.post(
            dict(
                amount=amount,
                occurred_at=day,
                kind=kind,
                category_id=cat(category),
                account_id=account,
                counterparty="测试商户",
                idempotency_key=str(uuid.uuid4()),
                **kw
            )
        )["id"]

    post("30", day="2026-09-28")
    post("100", day="2026-09-29", kind="INCOME", category="工资")
    single = post("100")
    post("25", day="2026-10-02", kind="REFUND", related_id=single)
    split = post(
        "100",
        day="2026-10-02",
        items=[
            dict(amount="40", category_id=cat("买菜")),
            dict(amount="60", category_id=cat("日用品")),
        ],
    )
    post("20", day="2026-10-03", kind="REFUND", related_id=split)
    post("10", day="2026-10-03")
    post("50", account=6, category="住房")
    post("5", category="未知用途")
    post("1000", kind="INCOME", category="工资")
    post("3", day="2026-10-02", kind="INCOME", category="理财收益")
    cancelled = post("99")
    tx.reverse(cancelled)
    post("200", kind="TRANSFER", to_account_id=6)
    post("100", day="2026-10-02", kind="TRANSFER", to_account_id=wealth)
    values.update(
        wealth, dict(actual="580", occurred_at="2026-10-03", idempotency_key="loss")
    )
    cats = CatalogService(db).categories()
    fee = post("8", day="2026-10-02", category="投资亏损")
    post("2", day="2026-10-03", kind="REFUND", related_id=fee)
    post("3", day="2026-10-03", account=wealth)
    post("2", day="2026-10-03", kind="INCOME", category="理财收益", account=wealth)
    return db, dict(family=family, mine=mine, spouse=spouse, food=cat("餐饮"))


def assert_group_category_details_reconcile(result):
    details = result["group_category_details"]
    assert all(
        set(row)
        == {
            "group_id",
            "category_id",
            "name",
            "parent_id",
            "parent_name",
            "amount",
            "paid",
            "refunds",
            "count",
        }
        for row in details
    )
    assert sum(row["amount"] for row in details) == result["expense"]
    assert sum(row["paid"] for row in details) == result["paid"]
    assert sum(row["refunds"] for row in details) == result["refunds"]
    by_group_parent = defaultdict(lambda: defaultdict(int))
    by_category = defaultdict(lambda: defaultdict(int))
    for row in details:
        assert row["amount"] == row["paid"] - row["refunds"]
        for field in ("amount", "paid", "refunds"):
            by_group_parent[row["group_id"], row["parent_id"]][field] += row[field]
            by_category[row["category_id"]][field] += row[field]
    assert set(by_group_parent) == {
        (row["group_id"], row["category_id"]) for row in result["group_categories"]
    }
    for row in result["group_categories"]:
        for field in ("amount", "paid", "refunds"):
            assert (
                by_group_parent[row["group_id"], row["category_id"]][field]
                == row[field]
            )
    assert set(by_category) == {row["id"] for row in result["categories"]}
    for row in result["categories"]:
        for field in ("amount", "paid", "refunds"):
            assert by_category[row["id"]][field] == row[field]


def test_household_conservation_exclusions_and_refunds(household):
    db, ids = household
    result = ExpenseAnalysisService(db).analyze(
        dict(start="2026-10-01", end="2026-10-03"), large_amount="80"
    )
    assert (
        result["expense"],
        result["paid"],
        result["refunds"],
        result["income"],
        result["net"],
    ) == (22000, 26500, 4500, 100000, 78000)
    assert (
        result["count"],
        result["refund_count"],
        result["large_count"],
        result["large_paid"],
    ) == (5, 2, 2, 20000)
    assert (
        result["excluded_investment_expense"] == 2900
        and result["excluded_investment_income"] == 500
    )
    baseline = FinancialAnalysisService(db).analyze(
        dict(
            start="2026-10-01",
            end="2026-10-03",
            exclude_investment_accounts=False,
            exclude_single_accounts=False,
        )
    )
    assert (
        baseline["expense"] == result["expense"] + result["excluded_investment_expense"]
    )
    assert baseline["income"] == result["income"] + result["excluded_investment_income"]
    for rows in (
        result["categories"],
        result["group_categories"],
        result["group_category_details"],
        result["parents"],
        result["merchants"],
        result["transactions"],
    ):
        assert sum(r["amount"] for r in rows) == result["expense"]
    assert sum(r["expense"] for r in result["trend"]) == result["expense"]
    assert (
        result["previous_start"] == "2026-09-28"
        and result["previous_end"] == "2026-09-30"
    )
    assert result["previous_expense"] == 3000 and result["change"] == 19000
    names = {r["name"]: r["amount"] for r in result["parents"]}
    assert names["餐饮"] == 12500 and names["退款抵减"] == -2000
    assert result["unknown_amount"] == 500
    assert_group_category_details_reconcile(result)
    unallocated = next(
        row for row in result["group_category_details"] if row["category_id"] == -1
    )
    assert (
        unallocated["name"],
        unallocated["parent_id"],
        unallocated["parent_name"],
        unallocated["amount"],
        unallocated["paid"],
        unallocated["refunds"],
        unallocated["count"],
    ) == ("未分配退款", -1, "退款抵减", -2000, 0, 2000, 0)
    filtered = ExpenseAnalysisService(db).analyze(
        dict(start="2026-10-01", end="2026-10-03", category_id=ids["food"]),
        large_amount="80",
    )
    assert (
        filtered["expense"] == 12500
        and filtered["refunds"] == 2500
        and filtered["large_count"] == 1
    )
    # Split payment contributes only its selected 40, not the whole 100.
    assert sorted(r["amount"] for r in filtered["transactions"]) == [
        -2500,
        1000,
        4000,
        10000,
    ]
    assert_group_category_details_reconcile(filtered)


def test_group_merge_and_merchant_statistics_remain_consistent(household):
    db, ids = household
    service = ExpenseAnalysisService(db)
    base = dict(start="2026-10-01", end="2026-10-03")
    family = service.analyze(dict(base, group_id=ids["family"]))
    mine = service.analyze(dict(base, group_id=ids["mine"]))
    spouse = service.analyze(dict(base, group_id=ids["spouse"]))
    for result in (family, mine, spouse):
        assert_group_category_details_reconcile(result)
    assert mine["expense"] + spouse["expense"] == family["expense"]
    assert {r["group_id"] for r in family["group_categories"]} == {
        ids["mine"],
        ids["spouse"],
    }
    assert (
        sum(
            r["amount"]
            for r in family["group_categories"]
            if r["group_id"] == ids["mine"]
        )
        == mine["expense"]
    )
    AccountMergeService(db).merge(dict(source_id=6, target_id=5))
    merged = service.analyze(dict(base, group_id=ids["mine"]))
    assert merged["expense"] == family["expense"] and merged["count"] == family["count"]
    assert {r["group_id"] for r in merged["group_categories"]} == {ids["mine"]}
    assert sum(r["amount"] for r in merged["group_categories"]) == family["expense"]
    assert_group_category_details_reconcile(merged)
    assert {r["group_id"] for r in merged["group_category_details"]} == {ids["mine"]}
    # Merchant repeats are observed counts, never guessed subscriptions.
    assert family["merchants"][0]["count"] == 5
    assert family["merchants"][0]["active_days"] == 3
    assert family["merchants"][0]["amount"] == 22000


def test_overview_is_read_only_and_uses_explicit_month_to_date(household):
    db, ids = household
    with db.read() as s:
        before = [(e.id, e.account_id, e.amount) for e in s.query(Entry)]
        tx_before = [(t.id, t.status) for t in s.query(Transaction)]
    overview = OverviewService(db).snapshot("2026-10-03")
    assert overview["month_start"] == "2026-10-01"
    assert (
        overview["household"]["expense"] == 22000
        and overview["household"]["income"] == 100000
    )
    assert (
        overview["household"]["net"] == 78000
        and overview["investments"]["profit"] == -2100
    )
    sheet = BalanceSheetService(db).snapshot("2026-10-03")
    assert all(overview[k] == sheet[k] for k in ("assets", "liabilities", "net_assets"))
    assert sum(g["net_assets"] for g in overview["groups"]) == overview["net_assets"]
    assert all(r["kind"] not in ("OPENING", "REVERSAL") for r in overview["recent"])
    assert len(overview["recent"]) <= 5
    earlier = OverviewService(db).snapshot("2026-09-30")
    assert (
        earlier["household"]["expense"] == 3000
        and earlier["household"]["income"] == 10000
    )
    with db.read() as s:
        assert before == [(e.id, e.account_id, e.amount) for e in s.query(Entry)]
        assert tx_before == [(t.id, t.status) for t in s.query(Transaction)]
    assert ReportService(db).integrity()["ok"]


def test_refund_only_period_finds_original_outside_comparison_window(household):
    db, ids = household
    housing = next(
        c["id"] for c in CatalogService(db).categories() if c["name"] == "住房"
    )
    tx = TransactionService(db)
    original = tx.post(
        dict(
            kind="EXPENSE",
            account_id=5,
            amount="80",
            category_id=housing,
            occurred_at="2026-09-28",
            idempotency_key="earlier-housing",
        )
    )["id"]
    tx.post(
        dict(
            kind="REFUND",
            account_id=5,
            amount="80",
            related_id=original,
            occurred_at="2026-10-03",
            idempotency_key="late-refund",
        )
    )
    result = ExpenseAnalysisService(db).analyze(
        dict(start="2026-10-03", end="2026-10-03", category_id=housing)
    )
    assert (
        result["expense"] == -8000 and result["paid"] == 0 and result["refunds"] == 8000
    )
    assert result["categories"][0]["id"] == housing and result["count"] == 0
    assert_group_category_details_reconcile(result)
    assert result["group_category_details"][0]["category_id"] == housing
    assert result["group_category_details"][0]["count"] == 0


def test_sankey_unsubdivided_leaf_does_not_include_its_child_categories(household):
    db, ids = household
    TransactionService(db).post(
        dict(
            kind="EXPENSE",
            account_id=5,
            amount="13",
            category_id=ids["food"],
            occurred_at="2026-10-03",
            idempotency_key="broad-food",
        )
    )
    service = ExpenseAnalysisService(db)
    filters = dict(start="2026-10-01", end="2026-10-03", category_id=ids["food"])
    assert service.analyze(filters)["expense"] == 13800
    exact = service.analyze(dict(filters, exact_category="true"))
    assert exact["expense"] == 1300 and exact["count"] == 1
    assert_group_category_details_reconcile(exact)
    assert exact["group_category_details"] == [
        dict(
            group_id=ids["mine"],
            category_id=ids["food"],
            name="餐饮",
            parent_id=ids["food"],
            parent_name="餐饮",
            amount=1300,
            paid=1300,
            refunds=0,
            count=1,
        )
    ]


def test_new_report_api_empty_and_validation(tmp_path):
    app = LedgerApplication(tmp_path / "api.db")
    with TestClient(app.app) as client:
        empty = client.get(
            "/api/reports/expenses", params=dict(start="2026-10-01", end="2026-10-18")
        ).json()
        assert empty["expense"] == empty["count"] == 0 and empty["categories"] == []
        assert empty["group_category_details"] == []
        for category_id in (0, -1):
            reserved = client.get(
                "/api/reports/expenses",
                params=dict(
                    start="2026-10-01",
                    end="2026-10-18",
                    category_id=category_id,
                    exact_category="true",
                ),
            )
            assert reserved.status_code == 200
            assert reserved.json()["group_category_details"] == []
        assert (
            client.get(
                "/api/reports/overview", params=dict(as_of="2026-10-18", group_id=99999)
            ).status_code
            == 200
        )
        for params in (
            dict(start="bad"),
            dict(start="2026-10-20", end="2026-10-01"),
            dict(large_amount="0"),
            dict(large_amount="NaN"),
            dict(group_id=99999),
            dict(account_id=99999),
            dict(category_id=99999),
        ):
            assert client.get("/api/reports/expenses", params=params).status_code == 400
        assert (
            client.get("/api/reports/overview", params=dict(as_of="bad")).status_code
            == 400
        )


def test_group_flow_drilldown_direct_ownership_and_refund_receiving_group(household):
    db, ids = household
    service = ExpenseAnalysisService(db)
    tx = TransactionService(db)
    cat = ids["food"]
    base = dict(start="2026-10-01", end="2026-10-03")
    original = tx.post(
        dict(
            kind="EXPENSE",
            account_id=5,
            amount="30",
            category_id=cat,
            occurred_at="2026-10-01",
            idempotency_key="group-payer",
        )
    )["id"]
    tx.post(
        dict(
            kind="REFUND",
            account_id=6,
            amount="10",
            related_id=original,
            occurred_at="2026-10-03",
            idempotency_key="other-group-refund",
        )
    )
    # Direct household ownership excludes both members (no double counting).
    assert (
        service.analyze(dict(base, group_id=ids["family"], direct_group=True))[
            "expense"
        ]
        == 0
    )
    result = service.analyze(base)
    assert_group_category_details_reconcile(result)
    for row in result["group_categories"]:
        if row["category_id"] > 0:
            filtered = service.analyze(
                dict(
                    base,
                    group_id=row["group_id"],
                    category_id=row["category_id"],
                    direct_group="true",
                )
            )
            assert filtered["expense"] == row["amount"]
    spouse_food = next(
        r
        for r in result["group_categories"]
        if r["group_id"] == ids["spouse"] and r["category_id"] == cat
    )
    assert spouse_food["amount"] == -1000 and spouse_food["refunds"] == 1000
    for row in result["group_category_details"]:
        filtered = service.analyze(
            dict(
                base,
                group_id=row["group_id"] or 0,
                category_id=row["category_id"],
                direct_group=True,
                exact_category=True,
            )
        )
        assert filtered["expense"] == row["amount"]
        assert filtered["paid"] == row["paid"]
        assert filtered["refunds"] == row["refunds"]
        assert filtered["count"] == row["count"]
        assert_group_category_details_reconcile(filtered)
    # Ungrouped accounts retain their own flow and a functioning drilldown.
    AccountService(db).save(
        {
            **next(a for a in AccountService(db).list() if a["id"] == 6),
            "group_id": None,
        },
        6,
    )
    ungrouped = service.analyze(dict(base, group_id="0", direct_group="true"))
    assert ungrouped["expense"] == 4000
    assert all(r["group_id"] is None for r in ungrouped["group_categories"])
    assert_group_category_details_reconcile(ungrouped)
    assert all(r["group_id"] is None for r in ungrouped["group_category_details"])
    assert ReportService(db).integrity()["ok"]


def test_group_category_details_keep_direct_parent_and_distinct_payment_counts(
    household,
):
    db, ids = household
    daily = next(
        c["id"] for c in CatalogService(db).categories() if c["name"] == "日常用餐"
    )
    TransactionService(db).post(
        dict(
            kind="EXPENSE",
            account_id=5,
            amount="23",
            items=[
                dict(category_id=daily, amount="8"),
                dict(category_id=daily, amount="2"),
                dict(category_id=ids["food"], amount="13"),
            ],
            occurred_at="2026-10-03",
            idempotency_key="same-category-split",
        )
    )
    with db.read() as s:
        entries = [
            (e.id, e.account_id, e.category_id, e.amount) for e in s.query(Entry)
        ]
        transactions = [(t.id, t.status) for t in s.query(Transaction)]
    result = ExpenseAnalysisService(db).analyze(
        dict(start="2026-10-01", end="2026-10-03")
    )
    assert_group_category_details_reconcile(result)
    details = {r["category_id"]: r for r in result["group_category_details"]}
    leaf = details[daily]
    assert (leaf["amount"], leaf["paid"], leaf["refunds"], leaf["count"]) == (
        9500,
        12000,
        2500,
        3,
    )
    direct = details[ids["food"]]
    assert direct["name"] == direct["parent_name"] == "餐饮"
    assert direct["category_id"] == direct["parent_id"]
    assert (direct["amount"], direct["count"]) == (1300, 1)
    parent = next(
        r
        for r in result["group_categories"]
        if r["group_id"] == ids["mine"] and r["category_id"] == ids["food"]
    )
    assert (parent["amount"], parent["count"]) == (14800, 4)
    # A single payment can contribute to both a parent and its child; the
    # existing parent count remains a union, while each detail is distinct.
    assert (
        sum(r["count"] for r in details.values() if r["parent_id"] == ids["food"]) == 5
    )
    with db.read() as s:
        assert entries == [
            (e.id, e.account_id, e.category_id, e.amount) for e in s.query(Entry)
        ]
        assert transactions == [(t.id, t.status) for t in s.query(Transaction)]


def test_group_category_details_resolve_historical_category_alias(household):
    db, ids = household
    catalog = CatalogService(db)
    grocery = next(c["id"] for c in catalog.categories() if c["name"] == "买菜")
    legacy = catalog.save_category(
        dict(name="历史买菜分类", kind="EXPENSE", parent_id=ids["food"])
    )["id"]
    TransactionService(db).post(
        dict(
            kind="EXPENSE",
            account_id=5,
            category_id=legacy,
            amount="7",
            occurred_at="2026-10-03",
            idempotency_key="historical-category",
        )
    )
    with db.write() as s:
        s.get(Category, legacy).merged_into_id = grocery
    result = ExpenseAnalysisService(db).analyze(
        dict(start="2026-10-01", end="2026-10-03", category_id=legacy)
    )
    assert_group_category_details_reconcile(result)
    assert result["expense"] == 4700
    assert result["group_category_details"] == [
        dict(
            group_id=ids["mine"],
            category_id=grocery,
            name="买菜",
            parent_id=ids["food"],
            parent_name="餐饮",
            amount=4700,
            paid=4700,
            refunds=0,
            count=2,
        )
    ]


@pytest.mark.parametrize("category_id", [0, "0", -1, "-1"])
def test_reserved_group_category_filters_do_not_become_all_categories(
    household, category_id
):
    db, ids = household
    for exact in (True, False):
        result = ExpenseAnalysisService(db).analyze(
            dict(
                start="2026-10-01",
                end="2026-10-03",
                group_id=ids["mine"],
                direct_group=True,
                category_id=category_id,
                exact_category=exact,
            )
        )
        assert_group_category_details_reconcile(result)
        if int(category_id) == 0:
            assert result["expense"] == result["count"] == 0
            assert result["group_category_details"] == []
        else:
            assert (
                result["expense"],
                result["paid"],
                result["refunds"],
                result["count"],
            ) == (
                -2000,
                0,
                2000,
                0,
            )
            assert len(result["group_category_details"]) == 1
            assert result["group_category_details"][0]["category_id"] == -1


def test_group_category_details_preserve_scope_for_legacy_null_category(household):
    db, ids = household
    legacy = TransactionService(db).post(
        dict(
            kind="EXPENSE",
            account_id=5,
            category_id=ids["food"],
            amount="9",
            occurred_at="2026-10-03",
            idempotency_key="legacy-null-category",
        )
    )["id"]
    with db.write() as s:
        entry = (
            s.query(Entry)
            .filter_by(transaction_id=legacy)
            .filter(Entry.category_id.is_not(None))
            .one()
        )
        entry.category_id = None
    service = ExpenseAnalysisService(db)
    filters = dict(start="2026-10-01", end="2026-10-03")
    result = service.analyze(filters)
    assert result["expense"] == 22000
    assert_group_category_details_reconcile(result)
    assert all(r["category_id"] != 0 for r in result["group_category_details"])
    assert service.analyze(dict(filters, category_id=0))["expense"] == 0


def test_group_category_details_use_already_netted_partial_refund_once(tmp_path):
    from app.bills import BillClassification
    from app.import_workflow import BillImportWorkflow
    from app.refund_matching import RefundMatchService

    db = Database(tmp_path / "netted.db")
    db.initialize()
    flow = BillImportWorkflow(db)
    source = (
        "支付宝账户：test\n"
        "交易时间,交易分类,交易对方,商品说明,收/支,金额,收/付款方式,交易状态,交易订单号\n"
        "2026-10-01 12:00:00,餐饮,餐厅,午餐,支出,100,账户余额,交易成功,pay\n"
        "2026-10-02 12:00:00,餐饮,餐厅,退款午餐,收入,25,账户余额,退款成功,refund\n"
    ).encode()
    run = flow.stage(source, "partial.csv")["run_id"]
    with db.read() as s:
        document = flow.artifacts.document(s, run, "NORMALIZED")
    for bill in document.bills:
        bill.classification = BillClassification(
            category_path=["退款"] if bill.facts.flow == "IN" else ["支出", "餐饮"],
            tags=[],
            status="CLASSIFIED",
            classified_by="测试",
        )
    flow.classify(run, document.model_dump_json().encode())
    refunds = RefundMatchService(db)
    candidates = refunds.candidates(run)
    candidate = candidates["refunds"][0]
    refunds.apply(
        run,
        json.dumps(
            dict(
                run_id=run,
                candidates_digest=candidates["candidates_digest"],
                decisions=[
                    dict(
                        refund_id=candidate["refund"]["id"],
                        payment_id=candidate["payments"][0]["id"],
                        decision="MATCHED",
                        note="同订单退款",
                        matched_by="测试",
                    )
                ],
            )
        ).encode(),
    )
    flow.commit(run)
    result = ExpenseAnalysisService(db).analyze(
        dict(start="2026-10-01", end="2026-10-03")
    )
    assert_group_category_details_reconcile(result)
    assert (result["expense"], result["paid"], result["refunds"], result["count"]) == (
        7500,
        7500,
        0,
        1,
    )
    assert len(result["group_category_details"]) == 1
    assert result["group_category_details"][0]["amount"] == 7500
    assert result["group_category_details"][0]["name"] == "餐饮"
    assert ReportService(db).integrity()["ok"]
