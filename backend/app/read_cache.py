"""Small revision-keyed projection cache; writes and restores always invalidate it."""

from collections import OrderedDict
from copy import deepcopy
from threading import RLock
import json


class ReadCache:
    def __init__(self, limit=8, max_bytes=16 * 1024 * 1024):
        self.limit, self.values, self.lock = limit, OrderedDict(), RLock()
        self.max_bytes, self.bytes = max_bytes, 0

    def get(self, key):
        with self.lock:
            if key not in self.values:
                return None
            self.values.move_to_end(key)
            return deepcopy(self.values[key][0])

    def put(self, key, value):
        size = len(json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode())
        if size > self.max_bytes:
            return
        with self.lock:
            if key in self.values:
                self.bytes -= self.values[key][1]
            self.values[key] = (deepcopy(value), size)
            self.bytes += size
            self.values.move_to_end(key)
            while len(self.values) > self.limit or self.bytes > self.max_bytes:
                _, (_, removed) = self.values.popitem(last=False)
                self.bytes -= removed

    def clear(self):
        with self.lock:
            self.values.clear()
            self.bytes = 0
