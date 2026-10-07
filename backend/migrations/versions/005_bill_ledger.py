"""Unified bill financial lifecycle and batch ownership."""

from alembic import op
import sqlalchemy as sa

revision = "005"
down_revision = "004"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "bill_ledger",
        sa.Column("bill_id", sa.String(), sa.ForeignKey("bills.id"), primary_key=True),
        sa.Column("owner_run_id", sa.Integer(), sa.ForeignKey("bill_import_runs.id")),
        sa.Column(
            "transaction_id",
            sa.Integer(),
            sa.ForeignKey("transactions.id"),
            unique=True,
        ),
        sa.Column("status", sa.String(), nullable=False),
        sa.Column("reason", sa.Text(), nullable=False),
        sa.Column("revoked_at", sa.String()),
        sa.CheckConstraint("status IN ('PENDING','POSTED','IGNORED','REVERSED')"),
    )
    op.create_index("ix_bill_ledger_owner_run_id", "bill_ledger", ["owner_run_id"])


def downgrade():
    raise RuntimeError("请恢复升级前备份，避免丢失入账和撤销关系")
