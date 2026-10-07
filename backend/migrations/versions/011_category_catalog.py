"""Canonical two-level categories keep every old journal category reference."""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.orm import Session

revision = "011"
down_revision = "010"
branch_labels = None
depends_on = None


def upgrade():
    with op.batch_alter_table("categories") as batch:
        batch.add_column(sa.Column("merged_into_id", sa.Integer(), nullable=True))
        batch.create_foreign_key(
            "fk_categories_canonical", "categories", ["merged_into_id"], ["id"]
        )
    from app.models import Category
    from app.category_catalog import CategoryCatalog

    session = Session(bind=op.get_bind())
    try:
        if session.query(Category).count():
            CategoryCatalog(session).consolidate()
        session.flush()
    finally:
        session.close()


def downgrade():
    raise RuntimeError("请恢复升级前备份，以保留原分类与目录映射")
