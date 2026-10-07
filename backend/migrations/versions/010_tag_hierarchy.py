"""Tags have configurable parents; Baby is an expense root category."""

from alembic import op
import sqlalchemy as sa

revision = "010"
down_revision = "009"
branch_labels = None
depends_on = None


def upgrade():
    with op.batch_alter_table("tags") as batch:
        batch.add_column(sa.Column("parent_id", sa.Integer(), nullable=True))
        batch.create_foreign_key("fk_tags_parent", "tags", ["parent_id"], ["id"])
        batch.create_index("ix_tags_parent_id", ["parent_id"])
        batch.create_check_constraint(
            "ck_tags_scope", "scope IN ('ACCOUNT','TRANSACTION','BOTH')"
        )
    op.execute(
        "INSERT INTO categories (name,parent_id,kind,active) SELECT '宝宝',NULL,'EXPENSE',1 WHERE EXISTS (SELECT 1 FROM categories) AND NOT EXISTS (SELECT 1 FROM categories WHERE name='宝宝' AND kind='EXPENSE' AND parent_id IS NULL)"
    )


def downgrade():
    raise RuntimeError("请恢复升级前备份，保留标签结构配置")
