"""Versioned legacy upgrades run once, atomically, instead of on every startup."""

from sqlalchemy import text
from .domain import Clock


class MaintenanceRunner:
    def __init__(self, database):
        self.db = database

    def run(self, version, action):
        with self.db.write() as session:
            if session.execute(
                text("SELECT 1 FROM maintenance_history WHERE version=:version"),
                dict(version=version),
            ).first():
                return False
            action()
            session.execute(
                text(
                    "INSERT INTO maintenance_history(version,completed_at) VALUES (:version,:at)"
                ),
                dict(version=version, at=Clock.now()),
            )
            return True
