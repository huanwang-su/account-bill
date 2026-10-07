"""Unified bills and offline classification history."""

from alembic import op
import sqlalchemy as sa

revision = "002"
down_revision = "001"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "bills",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("facts", sa.Text(), nullable=False),
        sa.Column("classification", sa.Text(), nullable=False),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("saved_at", sa.String(), nullable=False),
    )
    op.create_table(
        "bill_classification_history",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("bill_id", sa.String(), sa.ForeignKey("bills.id"), nullable=False),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("classification", sa.Text(), nullable=False),
        sa.Column("saved_at", sa.String(), nullable=False),
        sa.UniqueConstraint("bill_id", "revision"),
    )
    op.create_index(
        "ix_bill_classification_history_bill_id",
        "bill_classification_history",
        ["bill_id"],
    )


def downgrade():
    raise RuntimeError("请恢复升级前备份，避免丢失分类历史")
