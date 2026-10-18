import json
import uuid
import pytest
from fastapi.testclient import TestClient
from app.database import Database
from app.domain import Clock, Posting
from app.account_config import AccountGroupService, AccountMergeService
from app.services import (
    AccountService,
    CatalogService,
    TransactionService,
    ReportService,
)
from app.models import Account, Entry, Transaction
from app.income_analysis import IncomeAnalysisService
from app.expense_analysis import ExpenseAnalysisService
from app.main import LedgerApplication


@pytest.fixture
def income_ledger(tmp_path, monkeypatch):
    monkeypatch.setattr(Clock, "now", staticmethod(lambda: "2026-10-03 12:00:00"))
    db = Database(tmp_path / "income.db")
    db.initialize()
    accounts = AccountService(db)
    groups = AccountGroupService(db)
    family = groups.save(dict(name="收入家庭"))["id"]
    person = groups.save(dict(name="成员甲", parent_id=family))["id"]
    for key in (5, 6):
        original = next(a for a in accounts.list() if a["id"] == key)
        accounts.save(
            {**original, "kind": "银行卡", "group_id": person if key == 5 else family},
            key,
        )
    wealth = accounts.save(
        dict(name="测试证券", kind="证券", role="ASSET", group_id=person)
    )["id"]
    accounts.opening(5, dict(amount="5000", occurred_at="2026-09-28"))
    CatalogService(db).save_category(dict(name="投资亏损", kind="EXPENSE"))
    cats = CatalogService(db).categories()
    cat = lambda name: next(c["id"] for c in cats if c["name"] == name)
    tx = TransactionService(db)

    def post(amount, account=5, kind="INCOME", category="工资", day="2026-10-01", **kw):
        return tx.post(
            dict(
                amount=amount,
                account_id=account,
                kind=kind,
                category_id=cat(category),
                occurred_at=day,
                idempotency_key=str(uuid.uuid4()),
                **kw
            )
        )["id"]

    post("200", day="2026-09-28")
    post("10", account=wealth, category="理财收益", day="2026-09-28")
    post("1000", counterparty="公司")
    post(
        "200",
        day="2026-10-02",
        counterparty="公司",
        items=[
            dict(amount="150", category_id=cat("工资")),
            dict(amount="50", category_id=cat("红包收入")),
        ],
    )
    post("100", account=6, category="红包收入")
    post("30", account=wealth, category="理财收益")
    post("3", account=6, category="理财收益")  # Ordinary bank interest is still income.
    post("500", kind="TRANSFER", to_account_id=wealth)
    deleted = post("999")
    tx.reverse(deleted)
    purchase = post("75", kind="EXPENSE", category="买菜")
    post("25", kind="REFUND", category="买菜", related_id=purchase)
    post("4", account=wealth, kind="EXPENSE", category="投资亏损")
    return db, dict(wealth=wealth, family=family, person=person, salary=cat("工资"))


def test_income_conservation_comparison_scope_and_drilldown(income_ledger):
    db, ids = income_ledger
    service = IncomeAnalysisService(db)
    result = service.analyze(large_amount="150")
    assert (
        result["income"],
        result["count"],
        result["previous_income"],
        result["change"],
    ) == (130300, 4, 20000, 110300)
    assert ids["wealth"] in result["excluded_account_ids"]
    assert result["large_count"] == 2 and result["large_income"] == 120000
    for field in (
        "categories",
        "accounts",
        "sources",
        "transactions",
        "group_categories",
    ):
        assert sum(row["amount"] for row in result[field]) == result["income"]
    assert sum(row["income"] for row in result["trend"]) == result["income"]
    assert len(result["trend"]) == 3 and result["trend"][2]["income"] == 0
    assert all(
        row["kind"] == "INCOME" and row["status"] == "POSTED"
        for row in result["transactions"]
    )
    for row in result["group_categories"]:
        assert row["transaction_ids"] == sorted(set(row["transaction_ids"]))
        assert row["count"] == len(row["transaction_ids"])
        filtered = service.analyze(
            dict(
                group_id=row["group_id"],
                direct_group=True,
                category_id=row["category_id"],
            )
        )
        assert filtered["income"] == row["amount"]
        assert row["transaction_ids"] == sorted(
            transaction["id"] for transaction in filtered["transactions"]
        )
    # Parent ownership is direct on node clicks, and recursive in the group picker.
    assert (
        service.analyze(dict(group_id=ids["family"], direct_group=True))["income"]
        == 10300
    )
    assert service.analyze(dict(group_id=ids["family"]))["income"] == 130300
    split = service.analyze(dict(category_id=ids["salary"]), large_amount="175")
    assert split["income"] == 115000 and split["large_income"] == 100000
    assert sorted(row["amount"] for row in split["transactions"]) == [15000, 100000]
    monthly = service.analyze(grain="month", level=2)
    assert monthly["trend"] == [dict(period="2026-10", income=130300)]


def test_group_category_transaction_ids_cover_legacy_uncategorized_and_split_income(
    income_ledger,
):
    db, ids = income_ledger
    with db.write() as session:
        income_account = (
            session.query(Account).filter_by(role="SYSTEM", name="收入").one()
        )
        uncategorized_id = (
            TransactionService(db)
            ._write(
                session,
                dict(
                    kind="INCOME",
                    occurred_at="2026-10-02",
                    idempotency_key="uncategorized-income",
                ),
                [Posting(5, 1234), Posting(income_account.id, -1234)],
            )
            .id
        )
    report = IncomeAnalysisService(db).analyze()
    unclassified = next(
        row for row in report["group_categories"] if row["category_id"] == 0
    )
    assert unclassified["group_id"] == ids["person"]
    assert unclassified["amount"] == 1234 and unclassified["count"] == 1
    assert unclassified["transaction_ids"] == [uncategorized_id]
    split = next(row for row in report["transactions"] if row["amount"] == 20000)
    split_categories = [
        row
        for row in report["group_categories"]
        if split["id"] in row["transaction_ids"]
    ]
    assert len(split_categories) == 2
    selected = IncomeAnalysisService(db).analyze(dict(category_id=ids["salary"]))
    assert all(
        uncategorized_id not in row["transaction_ids"]
        for row in selected["group_categories"]
    )


def test_explicit_exclusions_inclusion_merge_and_empty_scope(income_ledger):
    db, ids = income_ledger
    income = IncomeAnalysisService(db)
    expenses = ExpenseAnalysisService(db)
    before = income.analyze()
    all_accounts = income.analyze(dict(excluded_account_ids="[]"))
    assert all_accounts["income"] == 133300 and all_accounts["previous_income"] == 21000
    assert all_accounts["count"] == before["count"] + 1
    exclude = json.dumps([5, ids["wealth"]])
    filtered = income.analyze(dict(excluded_account_ids=exclude))
    assert filtered["income"] == 10300 and filtered["previous_income"] == 0
    assert all(
        5 not in [e["account_id"] for e in row["entries"]]
        for row in filtered["transactions"]
    )
    assert (
        income.analyze(dict(account_id=5, excluded_account_ids=exclude))["count"] == 0
    )
    assert expenses.analyze()["expense"] == 5000
    assert expenses.analyze(dict(excluded_account_ids="[]"))["expense"] == 5400
    hidden = expenses.analyze(dict(excluded_account_ids=exclude))
    assert (
        hidden["expense"]
        == hidden["paid"]
        == hidden["refunds"]
        == hidden["previous_expense"]
        == 0
    )
    assert (
        hidden["transactions"] == hidden["group_categories"] == hidden["parents"] == []
    )
    AccountMergeService(db).merge(dict(source_id=6, target_id=5))
    # An old source ID excludes the merged bank in every report.
    assert (
        income.analyze(dict(excluded_account_ids=json.dumps([6, ids["wealth"]])))[
            "income"
        ]
        == 0
    )
    assert (
        expenses.analyze(dict(excluded_account_ids=json.dumps([6, ids["wealth"]])))[
            "expense"
        ]
        == 0
    )
    assert ReportService(db).integrity()["ok"]


def test_income_api_validation_empty_and_read_only(tmp_path):
    app = LedgerApplication(tmp_path / "api.db")
    with TestClient(app.app) as client:
        response = client.get(
            "/api/reports/income", params=dict(start="2026-10-01", end="2026-10-03")
        )
        assert response.status_code == 200
        result = response.json()
        assert result["income"] == result["count"] == result["previous_income"] == 0
        assert (
            result["categories"]
            == result["group_categories"]
            == result["transactions"]
            == []
        )
        assert len(result["trend"]) == 3
        for params in (
            dict(start="bad"),
            dict(start="2026-10-03", end="2026-10-01"),
            dict(grain="hour"),
            dict(level=3),
            dict(large_amount="0"),
            dict(account_id=999999),
            dict(group_id=999999),
            dict(group_id=999999, direct_group=True),
            dict(category_id=999999),
        ):
            assert client.get("/api/reports/income", params=params).status_code == 400
        for endpoint in ("income", "expenses"):
            for invalid in (
                "bad",
                "{}",
                "[true]",
                "[0]",
                "[-1]",
                "[1.2]",
                '["5"]',
                "[999999]",
                "[1]",
            ):
                result = client.get(
                    "/api/reports/" + endpoint,
                    params=dict(excluded_account_ids=invalid),
                )
                assert result.status_code == 400, (endpoint, invalid, result.text)
            assert (
                client.get(
                    "/api/reports/" + endpoint, params=dict(excluded_account_ids="[]")
                ).status_code
                == 200
            )


def test_income_and_exclusions_do_not_mutate_journals(income_ledger):
    db, ids = income_ledger
    with db.read() as session:
        before_entries = [(e.id, e.account_id, e.amount) for e in session.query(Entry)]
        before_tx = [(t.id, t.kind, t.status) for t in session.query(Transaction)]
    IncomeAnalysisService(db).analyze(dict(excluded_account_ids="[]"))
    ExpenseAnalysisService(db).analyze(dict(excluded_account_ids="[5]"))
    with db.read() as session:
        assert before_entries == [
            (e.id, e.account_id, e.amount) for e in session.query(Entry)
        ]
        assert before_tx == [
            (t.id, t.kind, t.status) for t in session.query(Transaction)
        ]


def test_posted_refund_income_is_income_but_refund_adjustment_is_not(income_ledger):
    db, ids = income_ledger
    catalog = CatalogService(db)
    categories = catalog.categories()
    category = next(
        (c for c in categories if c["name"] == "退款收入" and c["kind"] == "INCOME"),
        None,
    )
    if category is None:
        category = catalog.save_category(dict(name="退款收入", kind="INCOME"))
    TransactionService(db).post(
        dict(
            kind="INCOME",
            account_id=5,
            category_id=category["id"],
            amount="20",
            occurred_at="2026-10-03",
            idempotency_key="unmatched-refund-income",
        )
    )
    result = IncomeAnalysisService(db).analyze()
    assert result["income"] == 132300 and result["count"] == 5
    assert (
        next(c for c in result["categories"] if c["id"] == category["id"])["amount"]
        == 2000
    )
    assert all(r["kind"] == "INCOME" for r in result["transactions"])
