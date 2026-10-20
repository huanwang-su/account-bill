import json
from .models import Account, Category, Tag, Transaction, Entry
from .domain import DomainError, Clock


from .repository import Repository


class CatalogService:
    def __init__(self, database):
        self.db = database

    def categories(self):
        with self.db.read() as s:
            return [
                dict(
                    id=c.id,
                    name=c.name,
                    parent_id=c.parent_id,
                    kind=c.kind,
                    active=c.active,
                )
                for c in s.query(Category).filter_by(merged_into_id=None)
            ]

    def save_category(self, data, category_id=None):
        with self.db.write() as s:
            repo = Repository(s)
            cat = repo.require(Category, category_id) if category_id else Category()
            name = str(data.get("name", "")).strip()
            kind = data.get("kind", "EXPENSE")
            parent = data.get("parent_id")
            if category_id and cat.merged_into_id:
                raise DomainError("分类已归并，请编辑当前分类目录")
            if parent:
                from .category_catalog import CategoryGraph

                proposed_parent = CategoryGraph(s).canonical(parent)
                parent = proposed_parent.id
                if proposed_parent.parent_id:
                    raise DomainError("分类最多支持两级")
                if (
                    category_id
                    and s.query(Category)
                    .filter_by(parent_id=category_id, merged_into_id=None)
                    .first()
                ):
                    raise DomainError("含子项的一级分类不能移入其他分类")

            if not name or kind not in ("EXPENSE", "INCOME"):
                raise DomainError("分类名称或类型不正确")
            if (
                category_id
                and cat.kind != kind
                and (
                    s.query(Entry).filter_by(category_id=category_id).first()
                    or s.query(Category).filter_by(parent_id=category_id).first()
                )
            ):
                raise DomainError("已使用或包含子分类的分类不能改变类型")
            from .taxonomy import CategoryPath

            old_path = CategoryPath.of(s, category_id) if category_id else []
            cursor = parent
            seen = {category_id} if category_id else set()
            while cursor:
                if cursor in seen:
                    raise DomainError("不能将分类移入自身或子分类")
                seen.add(cursor)
                p = repo.require(Category, cursor)
                if p.kind != kind:
                    raise DomainError("父子分类的收支类型必须相同")
                cursor = p.parent_id
            if (
                s.query(Category)
                .filter(
                    Category.name == name,
                    Category.parent_id == parent,
                    Category.kind == kind,
                    Category.id != (category_id or 0),
                )
                .first()
            ):
                raise DomainError("同级分类名称重复")
            cat.name = name
            cat.kind = kind
            cat.parent_id = parent
            cat.active = bool(data.get("active", True))
            s.add(cat)
            s.flush()
            new_path = CategoryPath.of(s, cat.id)
            if old_path and old_path != new_path:
                from .models import Bill, BillClassificationHistory

                for bill in s.query(Bill):
                    labels = json.loads(bill.classification)
                    if labels and labels["category_path"][: len(old_path)] == old_path:
                        labels["category_path"] = (
                            new_path + labels["category_path"][len(old_path) :]
                        )
                        bill.classification = json.dumps(labels, ensure_ascii=False)
                        bill.revision += 1
                        bill.saved_at = Clock.now()
                        s.add(
                            BillClassificationHistory(
                                bill_id=bill.id,
                                revision=bill.revision,
                                classification=bill.classification,
                                saved_at=bill.saved_at,
                            )
                        )
            return {"id": cat.id}

    def tags(self):
        with self.db.read() as s:
            return [
                dict(
                    id=t.id,
                    name=t.name,
                    scope=t.scope,
                    parent_id=t.parent_id,
                    active=t.active,
                )
                for t in s.query(Tag).order_by(Tag.id)
            ]

    def save_tag(self, data, tag_id=None):
        name = str(data.get("name", "")).strip()
        scope = data.get("scope", "BOTH")
        if (
            not name
            or len(name) > 40
            or scope not in ("ACCOUNT", "TRANSACTION", "BOTH")
        ):
            raise DomainError("标签内容不正确")
        with self.db.write() as s:
            from .models import Bill
            from .taxonomy import TagHierarchy

            repo = Repository(s)
            tag = repo.require(Tag, tag_id) if tag_id else Tag()
            if s.query(Tag).filter(Tag.name == name, Tag.id != (tag_id or 0)).first():
                raise DomainError("标签已存在")
            if (
                tag_id
                and tag.name != name
                and (
                    any(tag.name in json.loads(a.tags) for a in s.query(Account))
                    or any(tag.name in json.loads(t.tags) for t in s.query(Transaction))
                    or any(
                        tag.name in (json.loads(b.classification) or {}).get("tags", [])
                        for b in s.query(Bill)
                    )
                )
            ):
                raise DomainError("已使用标签不能改名，可以调整父标签")
            parent = data.get("parent_id") or None
            hierarchy = TagHierarchy(s)
            if parent:
                parent = int(parent)
                ancestor = repo.require(Tag, parent)
                if not ancestor.active:
                    raise DomainError("请先恢复父标签，再添加或移动子标签")
                if tag_id and parent in hierarchy.descendants(tag_id):
                    raise DomainError("不能将标签移入自身或子标签")
                if ancestor.scope != "BOTH" and ancestor.scope != scope:
                    raise DomainError("子标签适用范围不能超出父标签")
            if tag_id and scope != "BOTH":
                descendants = [
                    hierarchy.rows[k] for k in hierarchy.descendants(tag_id) - {tag_id}
                ]
                if any(t.scope not in (scope,) for t in descendants):
                    raise DomainError("父标签适用范围不能小于子标签")
                if (
                    scope == "ACCOUNT"
                    and (
                        any(
                            tag.name in json.loads(t.tags) for t in s.query(Transaction)
                        )
                        or any(
                            tag.name
                            in (json.loads(b.classification) or {}).get("tags", [])
                            for b in s.query(Bill)
                        )
                    )
                ) or (
                    scope == "TRANSACTION"
                    and any(tag.name in json.loads(a.tags) for a in s.query(Account))
                ):
                    raise DomainError("标签已用于其他范围，不能缩小适用范围")
            tag.name, tag.scope, tag.parent_id = name, scope, parent
            s.add(tag)
            s.flush()
            return {"id": tag.id}

    def set_tag_active(self, tag_id, active):
        """Archive/restore a subtree; existing account and bill labels remain intact."""
        if not isinstance(active, bool):
            raise DomainError("标签启用状态必须为布尔值")
        from .taxonomy import TagHierarchy

        with self.db.write() as s:
            root = Repository(s).require(Tag, tag_id)
            hierarchy = TagHierarchy(s)
            if active and root.parent_id and not hierarchy.rows[root.parent_id].active:
                raise DomainError("请先恢复父标签")
            keys = hierarchy.descendants(tag_id)
            for key in keys:
                hierarchy.rows[key].active = active
            return dict(id=tag_id, active=active, count=len(keys))
