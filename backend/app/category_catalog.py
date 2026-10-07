"""Two-level catalog and reversible identities for historical category references."""

import json
from .models import Category, Bill, BillClassificationHistory
from .domain import Clock, DomainError

DEFAULT_CATEGORIES = {
    "EXPENSE": {
        "餐饮": ["日常用餐", "买菜", "饮品零食"],
        "购物": ["日用品", "衣物饰品", "数码用品"],
        "交通": ["出行", "停车"],
        "居家": ["住房", "水电"],
        "宝宝": ["用品", "衣物"],
        "医疗健康": [],
        "文娱休闲": ["游玩", "会员订阅"],
        "缴费": [],
        "未知用途": [],
    },
    "INCOME": {
        "工资": [],
        "理财收益": [],
        "报销收入": [],
        "红包收入": [],
        "保险赔付": [],
        "退款收入": [],
        "未知用途": [],
    },
}


class CategoryGraph:
    def __init__(self, session):
        self.rows = {c.id: c for c in session.query(Category)}

    def canonical(self, key):
        seen = set()
        key = int(key)
        while key in self.rows:
            if key in seen:
                raise DomainError("分类映射存在循环")
            seen.add(key)
            row = self.rows[key]
            if row.merged_into_id is None:
                return row
            key = row.merged_into_id
        raise DomainError("分类不存在")

    def path(self, key):
        row = self.canonical(key)
        parts = []
        seen = set()
        while row and row.id not in seen:
            seen.add(row.id)
            parts.insert(0, row.name)
            row = self.canonical(row.parent_id) if row.parent_id else None
        return parts


class CategoryCatalog:
    def __init__(self, session):
        self.s = session

    @staticmethod
    def mapped_path(kind, path):
        if not path:
            return ["未知用途"]
        root = path[0]
        leaf = path[-1]
        if kind == "INCOME":
            return [
                (
                    {
                        "报销款": "报销收入",
                        "红包": "红包收入",
                        "赔付": "保险赔付",
                        "其他收入": "未知用途",
                    }.get(root, root)
                    if root
                    in (
                        "工资",
                        "理财收益",
                        "报销收入",
                        "报销款",
                        "红包收入",
                        "红包",
                        "保险赔付",
                        "赔付",
                        "退款收入",
                    )
                    else "未知用途"
                )
            ]
        if root == "餐饮":
            if len(path) == 1:
                return ["餐饮"]
            if leaf in ("买菜", "食品", "食品采购", "买菜食品"):
                return ["餐饮", "买菜"]
            if leaf in ("饮品", "饮品甜点", "零食", "零食烘焙", "食品零食", "饮品零食"):
                return ["餐饮", "饮品零食"]
            return ["餐饮", "日常用餐"]
        if root in ("购物", "日常购物", "服饰", "数码", "购物卡充值"):
            if root == "数码" or leaf in ("数码用品", "配件"):
                return ["购物", "数码用品"]
            if root == "服饰" or leaf in ("服饰", "衣物", "袜子", "饰品", "衣物饰品"):
                return ["购物", "衣物饰品"]
            if leaf in ("日用品", "个护用品"):
                return ["购物", "日用品"]
            return ["购物"]
        if root in ("交通", "交通出行"):
            return (
                ["交通"]
                if len(path) == 1
                else ["交通", "停车" if leaf in ("停车", "停车费") else "出行"]
            )
        if root == "居家":
            return (
                ["居家", "住房"]
                if leaf in ("房租", "住房")
                else (
                    ["居家", "水电"]
                    if leaf in ("水电", "电费", "水电燃气")
                    else ["居家"]
                )
            )
        if root in ("宝宝", "母婴亲子"):
            return (
                ["宝宝", "衣物"]
                if leaf in ("童装", "衣物")
                else ["宝宝", "用品"] if leaf in ("用品", "奶粉", "尿布") else ["宝宝"]
            )
        if root in ("日用健康", "医疗健康"):
            return ["医疗健康"]
        if root == "文娱休闲":
            return (
                ["文娱休闲"]
                if len(path) == 1
                else [
                    "文娱休闲",
                    (
                        "会员订阅"
                        if leaf in ("影视会员", "数字订阅", "数字会员", "会员订阅")
                        else "游玩"
                    ),
                ]
            )
        if root in ("生活缴费", "缴费") or leaf in ("会费缴费", "党费"):
            return ["缴费"]
        return ["未知用途"]

    def resolve(self, kind, path, allow_create=False):
        graph = CategoryGraph(self.s)
        for c in graph.rows.values():
            if c.merged_into_id is None and c.kind == kind and graph.path(c.id) == path:
                if not c.active:
                    raise DomainError("分类已停用：" + c.name)
                return c
        mapped = self.mapped_path(kind, path)
        if not allow_create:
            for c in graph.rows.values():
                if (
                    c.merged_into_id is None
                    and c.active
                    and c.kind == kind
                    and graph.path(c.id) == mapped
                ):
                    return c
            raise DomainError("请先在分类目录创建有效分类")
        if len(path) > 2:
            raise DomainError("分类最多支持两级")
        parent = None
        for name in path:
            c = (
                self.s.query(Category)
                .filter_by(name=name, kind=kind, parent_id=parent, merged_into_id=None)
                .first()
            )
            if not c:
                c = Category(name=name, kind=kind, parent_id=parent, active=True)
                self.s.add(c)
                self.s.flush()
            if not c.active:
                raise DomainError("分类已停用：" + name)
            parent = c.id
        return c

    def normalize(self, labels):
        if not labels or labels["category_path"][0] not in ("支出", "收入"):
            return labels
        kind = "INCOME" if labels["category_path"][0] == "收入" else "EXPENSE"
        result = dict(labels)
        category = self.resolve(kind, labels["category_path"][1:])
        result["category_path"] = [
            labels["category_path"][0],
            *CategoryGraph(self.s).path(category.id),
        ]
        return result

    def consolidate(self):
        existing = list(self.s.query(Category))
        before_graph = CategoryGraph(self.s)
        old_paths = {c.id: before_graph.path(c.id) for c in existing}
        canonical = {}
        for kind, roots in DEFAULT_CATEGORIES.items():
            for name, children in roots.items():
                root = next(
                    (
                        c
                        for c in existing
                        if c.kind == kind
                        and c.name == name
                        and c.parent_id is None
                        and c.merged_into_id is None
                    ),
                    None,
                )
                if not root:
                    root = Category(name=name, kind=kind, parent_id=None, active=True)
                    self.s.add(root)
                    self.s.flush()
                root.active = True
                canonical[(kind, (name,))] = root
                for child in children:
                    c = next(
                        (
                            c
                            for c in existing
                            if c.kind == kind
                            and c.name == child
                            and c.parent_id == root.id
                            and c.merged_into_id is None
                        ),
                        None,
                    )
                    if not c:
                        c = Category(
                            name=child, kind=kind, parent_id=root.id, active=True
                        )
                        self.s.add(c)
                        self.s.flush()
                    c.active = True
                    canonical[(kind, (name, child))] = c
        retained = {c.id for c in canonical.values()}
        for old in existing:
            if old.id in retained:
                continue
            mapped = self.mapped_path(old.kind, old_paths[old.id])
            target = canonical[(old.kind, tuple(mapped))]
            old.merged_into_id = target.id
            old.active = False
        self.s.flush()
        updated = 0
        for bill in self.s.query(Bill):
            labels = json.loads(bill.classification)
            normalized = self.normalize(labels)
            if labels != normalized:
                bill.classification = json.dumps(normalized, ensure_ascii=False)
                bill.revision += 1
                bill.saved_at = Clock.now()
                self.s.add(
                    BillClassificationHistory(
                        bill_id=bill.id,
                        revision=bill.revision,
                        classification=bill.classification,
                        saved_at=bill.saved_at,
                    )
                )
                updated += 1
        self.s.flush()
        return dict(
            categories=len(canonical),
            updated_bills=updated,
            retired=len(existing) - len(retained),
        )
