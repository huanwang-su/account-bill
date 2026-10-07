"""Synthetic sorting, partial refund and grouped financial position fixtures."""

import json
import sys
from app.database import Database
from app.import_workflow import BillImportWorkflow
from app.refund_matching import RefundMatchService
from app.account_config import AccountGroupService, AccountMergeService
from app.services import AccountService, CatalogService, TransactionService
from pagination_fixture import create

db = Database(sys.argv[1])
db.initialize()
flow = BillImportWorkflow(db)
create(flow, 65, "排序")
create(flow, 2, "待核对排序", mixed=True)
csv = "交易时间,交易分类,交易对方,商品说明,收/支,金额,收/付款方式,交易状态,交易订单号\n2026-09-03 12:00:00,购物,部分退款商户,部分退款商品,支出,100.00,账户余额,交易成功,partial-pay\n2026-09-04 12:00:00,购物,部分退款商户,部分退款商品,收入,90.00,账户余额,退款成功,partial-refund\n"
run = flow.stage(csv.encode("utf-8-sig"), "部分退款排序.csv")["run_id"]
with db.read() as s:
    doc = flow.artifacts.document(s, run, "NORMALIZED").model_dump()
for row in doc["bills"]:
    row["classification"] = dict(
        category_path=["支出", "购物"] if row["facts"]["flow"] == "OUT" else ["退款"],
        tags=[],
        status="CLASSIFIED",
        classified_by="测试",
    )
flow.classify(run, json.dumps(doc, ensure_ascii=False).encode())
candidates = RefundMatchService(db).candidates(run)
refund = candidates["refunds"][0]
RefundMatchService(db).apply(
    run,
    json.dumps(
        dict(
            schema_version="local-ledger.refund-matches.v1",
            run_id=run,
            candidates_digest=candidates["candidates_digest"],
            decisions=[
                dict(
                    refund_id=refund["refund"]["id"],
                    payment_id=refund["payments"][0]["id"],
                    decision="MATCHED",
                    note="合成订单一致",
                    matched_by="测试",
                )
            ],
        )
    ).encode(),
)
flow.commit(run)

groups = AccountGroupService(db)
family = groups.save(dict(name="排序测试家庭"))["id"]
mine = groups.save(dict(name="排序测试成员甲", parent_id=family))["id"]
spouse = groups.save(dict(name="排序测试成员乙", parent_id=family))["id"]
accounts = AccountService(db)


def account(name, group, balance, role="ASSET"):
    key = accounts.save(dict(name=name, group_id=group, role=role))["id"]
    if balance is not None:
        accounts.opening(key, dict(amount=balance, occurred_at="2026-09-01"))
    return key


bank = account("测试主资产", mine, "800")
source = account("隐藏合并来源", mine, "200")
account("测试另一成员资产", spouse, "600")
credit = account("测试停用信用卡", mine, "-200", "LIABILITY")
account("测试外部商户", mine, "9000", "EXTERNAL")
account("测试零余额未设期初", mine, None)
AccountMergeService(db).merge(dict(source_id=source, target_id=bank))
accounts.save(
    dict(name="测试停用信用卡", role="LIABILITY", group_id=mine, active=False), credit
)
income = next(c["id"] for c in CatalogService(db).categories() if c["name"] == "工资")
TransactionService(db).post(
    dict(
        kind="INCOME",
        account_id=bank,
        amount="500",
        category_id=income,
        occurred_at="2026-09-20",
        idempotency_key="future-income",
    )
)
print(json.dumps(dict(family=family, mine=mine, spouse=spouse)))
