"""Shared identity and label persistence within a caller-owned transaction."""

import json
from .models import Tag
from .domain import DomainError, TagValues


class Repository:
    """Shared identity lookup; all writes use the caller's unit of work."""

    def __init__(self, session):
        self.session = session

    def require(self, model, key):
        obj = self.session.get(model, key)
        if obj is None:
            raise DomainError("记录不存在")
        return obj

    def tag_values(self, values, scope):
        encoded = TagValues.encode(values)
        for name in json.loads(encoded):
            tag = self.session.query(Tag).filter_by(name=name).first()
            if tag and tag.scope not in (scope, "BOTH"):
                raise DomainError("标签适用范围不匹配：" + name)
            if not tag:
                self.session.add(Tag(name=name, scope="BOTH"))
        return encoded
