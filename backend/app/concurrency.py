"""Concurrent WAL readers/writers; only replacement takes the exclusive barrier."""

from contextlib import contextmanager
from threading import Condition, RLock, get_ident


class RestoreBarrier:
    def __init__(self):
        self.condition = Condition(RLock())
        self.readers = 0
        self.owner = None
        self.depth = 0
        self.waiting = 0

    @contextmanager
    def shared(self):
        owner = get_ident()
        with self.condition:
            own = self.owner == owner
            if not own:
                self.condition.wait_for(lambda: self.owner is None and not self.waiting)
                self.readers += 1
        try:
            yield
        finally:
            if not own:
                with self.condition:
                    self.readers -= 1
                    self.condition.notify_all()

    @contextmanager
    def exclusive(self):
        owner = get_ident()
        with self.condition:
            if self.owner != owner:
                self.waiting += 1
                try:
                    self.condition.wait_for(
                        lambda: self.owner is None and self.readers == 0
                    )
                    self.owner = owner
                finally:
                    self.waiting -= 1
            self.depth += 1
        try:
            yield
        finally:
            with self.condition:
                self.depth -= 1
                if not self.depth:
                    self.owner = None
                    self.condition.notify_all()
