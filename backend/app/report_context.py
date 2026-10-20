"""Report composition uses one immutable SQLite snapshot and shared lookup maps."""

from functools import wraps
from copy import deepcopy
import json


def consistent_read(method):
    @wraps(method)
    def analyze(self, *args, **kwargs):
        with self.db.read():
            return method(self, *args, **kwargs)

    return analyze


def snapshot_cached(method):
    """Reuse a projection only within the caller's immutable read transaction."""

    @wraps(method)
    def project(self, *args, **kwargs):
        with self.db.read() as session:
            if not session.info.get("read_only"):
                return method(self, *args, **kwargs)
            key = (
                method.__qualname__,
                json.dumps([args, kwargs], sort_keys=True, default=str),
            )
            cache = session.info.setdefault("projections", {})
            if key not in cache:
                cache[key] = method(self, *args, **kwargs)
            return deepcopy(cache[key])

    return project


def snapshot_rows(session, model):
    if not session.info.get("read_only"):
        return session.query(model).all()
    cache = session.info.setdefault("rows", {})
    if model not in cache:
        cache[model] = session.query(model).all()
    return cache[model]
