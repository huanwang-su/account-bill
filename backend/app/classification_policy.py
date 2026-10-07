"""Locally editable reference for offline AI; account/amount guards remain mandatory."""

import json
from pydantic import BaseModel, ConfigDict, Field, StrictBool
from .models import ClassificationPolicy, Bill, BillLedger
from .domain import Clock, DomainError


class PolicyValues(BaseModel):
    model_config = ConfigDict(extra="forbid")
    allow_broad_categories: StrictBool = True
    allow_new_categories: StrictBool = False
    unmatched_refund_income: StrictBool = False
    reference: str = Field(
        min_length=1,
        max_length=20000,
        default="""分类最多两级，优先选择已有目录，不自动新增分类。
分类记录收支用途；标签只补充归属、场景等信息，可选多个，不重复填写分类用途。只使用当前启用的标签目录，历史归档标签不作为新分类建议。
按原账单实际收支方向分类，不猜测具体用途。用途不明统一归收入/未知用途或支出/未知用途，正常入账，不因缺少用途而待核对。
已明确的自有账户转存记内部转账，不计收支；账户、金额、日期及凭证对应关系确认后，只记一笔交易。支付宝、微信通过银行卡付款时，实际扣款账户是银行卡，支付渠道不另扣余额。
同文件退款先按订单等证据匹配原付款；全额退款双方忽略，部分退款记一笔净支出并忽略退款，累计退款不超过付款。未匹配退款按已配置口径记退款收入，分类保持“退款”。
明确的报销、保险赔付、红包等按已确认用途分类。不要自行增加报销冲抵、购物卡资产化等口径；已知用途缺少细分类时用宽泛分类。
只在账户未确定、金额冲突、未完成或疑似重复且无法关联时待核对，并写具体原因。原账单事实和文件保留。""",
    )


class ClassificationPolicyService:
    def __init__(self, db):
        self.db = db

    @staticmethod
    def read_in(s):
        row = s.get(ClassificationPolicy, 1)
        values = PolicyValues().model_dump()
        if row:
            values.update(json.loads(row.content))
        return dict(
            **values,
            revision=row.revision if row else 0,
            updated_at=row.updated_at if row else None
        )

    def get(self):
        with self.db.read() as s:
            return self.read_in(s)

    @classmethod
    def reference_in(cls, s):
        from .models import Category, Tag
        from .taxonomy import Hierarchy

        categories = list(
            s.query(Category).filter_by(merged_into_id=None).order_by(Category.id)
        )
        tags = list(s.query(Tag).filter_by(active=True).order_by(Tag.id))
        category_tree, tag_tree = Hierarchy(categories), Hierarchy(tags)
        return dict(
            **cls.read_in(s),
            taxonomy={
                "categories": [
                    dict(
                        id=c.id,
                        name=c.name,
                        parent_id=c.parent_id,
                        kind=c.kind,
                        active=c.active,
                        path=[
                            "收入" if c.kind == "INCOME" else "支出",
                            *category_tree.path(c.id),
                        ],
                    )
                    for c in categories
                ],
                "tags": [
                    dict(
                        id=t.id,
                        name=t.name,
                        parent_id=t.parent_id,
                        scope=t.scope,
                        path=tag_tree.path(t.id),
                    )
                    for t in tags
                ],
            }
        )

    def reference(self):
        with self.db.read() as s:
            return self.reference_in(s)

    def save(self, data):
        try:
            values = PolicyValues.model_validate(
                {k: v for k, v in data.items() if k != "revision"}
            )
        except ValueError:
            raise DomainError("分类参考配置格式错误") from None
        with self.db.write() as s:
            row = s.get(ClassificationPolicy, 1)
            if data.get("revision") != (row.revision if row else 0):
                raise DomainError("配置已被修改，请刷新后保存")
            if row is None:
                row = ClassificationPolicy(id=1, revision=0)
                s.add(row)
            row.revision += 1
            row.content = values.model_dump_json()
            row.updated_at = Clock.now()
            s.flush()
            return self.read_in(s)

    def reprocess(self):
        from .bill_posting import BillPostingService
        from .bill_status import BillStatusService

        counts = dict(posted=0, pending=0, ignored=0, existing=0)
        with self.db.write() as s:
            for link in s.query(BillLedger).filter_by(status="PENDING").all():
                if not BillStatusService.excluded(s, link.bill_id):
                    counts[
                        BillPostingService(self.db).post_auto(
                            s, link.bill_id, link.owner_run_id
                        )
                    ] += 1
        return counts
