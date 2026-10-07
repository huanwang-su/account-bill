"""Shared hierarchy traversal and provider-independent classification path matching."""

from .models import Tag, Category


class Hierarchy:
    def __init__(self, rows):
        self.rows = {r.id: r for r in rows}

    def descendants(self, key):
        keys = {int(key)}
        while True:
            more = {r.id for r in self.rows.values() if r.parent_id in keys} - keys
            if not more:
                return keys
            keys |= more

    def path(self, key):
        names = []
        seen = set()
        while key and key in self.rows and key not in seen:
            seen.add(key)
            row = self.rows[key]
            names.insert(0, row.name)
            key = row.parent_id
        return names


class TagHierarchy(Hierarchy):
    def __init__(self, session):
        super().__init__(session.query(Tag).all())
        self.cache = {}

    def names(self, name):
        if name in self.cache:
            return self.cache[name]
        row = next((r for r in self.rows.values() if r.name == name), None)
        names = {self.rows[k].name for k in self.descendants(row.id)} if row else {name}
        self.cache[name] = names
        return names

    def matches(self, values, name):
        return bool(set(values) & self.names(name))


class CategoryPath:
    @staticmethod
    def matches(path, selected):
        parts = [p.strip() for p in selected.split("/") if p.strip()]
        # Bare names remain compatible with older saved filter conditions.
        return parts[0] in path if len(parts) == 1 else path[: len(parts)] == parts

    @staticmethod
    def of(session, key):
        from .category_catalog import CategoryGraph

        graph = CategoryGraph(session)
        category = graph.canonical(key)
        return [
            "收入" if category.kind == "INCOME" else "支出",
            *graph.path(category.id),
        ]
