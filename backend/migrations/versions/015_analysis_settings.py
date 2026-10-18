"""Persist report exclusions and explicitly selected single-account reports."""

from alembic import op
import sqlalchemy as sa

revision = "015"
down_revision = "014"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "analysis_settings",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("updated_at", sa.String(), nullable=False),
    )


def downgrade():
    raise RuntimeError("请恢复升级前备份，以保留分析配置")
