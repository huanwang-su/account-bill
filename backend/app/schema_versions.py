"""Resolve schema identity from trusted migrations, never hard-coded API versions."""

from pathlib import Path
from alembic.config import Config
from alembic.script import ScriptDirectory


class SchemaVersions:
    @staticmethod
    def config(path=None):
        root = Path(__file__).resolve().parents[1]
        config = Config(str(root / "alembic.ini"))
        config.set_main_option("script_location", str(root / "migrations"))
        if path is not None:
            config.set_main_option(
                "sqlalchemy.url", "sqlite:///" + str(path).replace("%", "%%")
            )
        return config

    @classmethod
    def known(cls):
        return {
            revision.revision
            for revision in ScriptDirectory.from_config(cls.config()).walk_revisions()
        }

    @classmethod
    def head(cls):
        return ScriptDirectory.from_config(cls.config()).get_current_head()
