"""Explicit valuation cancellation and report lookup indexes."""

from alembic import op
import sqlalchemy as sa

revision = "016"
down_revision = "015"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "transactions",
        sa.Column("purpose", sa.String(), nullable=False, server_default="GENERAL"),
    )
    op.execute(
        "UPDATE transactions SET purpose=CASE WHEN kind='OPENING' THEN 'OPENING' WHEN source='证券余额更新' THEN 'VALUATION' ELSE 'GENERAL' END"
    )
    op.create_table(
        "maintenance_history",
        sa.Column("version", sa.String(), primary_key=True),
        sa.Column("completed_at", sa.String(), nullable=False),
    )
    op.add_column(
        "account_valuations", sa.Column("revoked_at", sa.String(), nullable=True)
    )
    op.create_index(
        "ix_entries_account_transaction", "entries", ["account_id", "transaction_id"]
    )
    op.create_index(
        "ix_transactions_state_time", "transactions", ["status", "occurred_at", "id"]
    )
    op.create_index(
        "ix_valuations_account_time",
        "account_valuations",
        ["account_id", "occurred_at"],
    )
    op.create_index("ix_bill_ledger_status", "bill_ledger", ["status"])


def downgrade():
    raise RuntimeError("估值撤销记录不可丢弃；如需旧版本，请恢复升级前的完整副本")
