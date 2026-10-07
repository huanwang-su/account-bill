"""Classification reference, partial refund netting and paired internal transfers."""

from alembic import op
import sqlalchemy as sa

revision = "008"
down_revision = "007"
branch_labels = None
depends_on = None


def upgrade():
    # Rebuild only this independent audit table to remove payment's old unique constraint.
    op.rename_table("refund_matches", "refund_matches_previous")
    op.create_table(
        "refund_matches",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "run_id", sa.Integer(), sa.ForeignKey("bill_import_runs.id"), nullable=False
        ),
        sa.Column(
            "batch_id", sa.Integer(), sa.ForeignKey("import_batches.id"), nullable=False
        ),
        sa.Column("refund_id", sa.String(), nullable=False, unique=True),
        sa.Column("payment_id", sa.String(), nullable=False),
        sa.Column("note", sa.Text(), nullable=False),
        sa.Column("matched_by", sa.String(), nullable=False),
        sa.Column("created_at", sa.String(), nullable=False),
    )
    op.execute("INSERT INTO refund_matches SELECT * FROM refund_matches_previous")
    op.drop_table("refund_matches_previous")
    op.create_index("ix_refund_matches_payment_id", "refund_matches", ["payment_id"])
    op.create_table(
        "classification_policy",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("updated_at", sa.String(), nullable=False),
    )
    op.create_table(
        "bill_netting",
        sa.Column("payment_id", sa.String(), primary_key=True),
        sa.Column("original_minor", sa.BigInteger(), nullable=False),
        sa.Column("refund_minor", sa.BigInteger(), nullable=False),
        sa.Column("net_minor", sa.BigInteger(), nullable=False),
        sa.Column("updated_at", sa.String(), nullable=False),
        sa.CheckConstraint(
            "original_minor = refund_minor + net_minor AND net_minor >= 0 AND refund_minor > 0"
        ),
    )
    op.create_table(
        "bill_journal_history",
        sa.Column(
            "transaction_id",
            sa.Integer(),
            sa.ForeignKey("transactions.id"),
            primary_key=True,
        ),
        sa.Column("bill_id", sa.String(), sa.ForeignKey("bills.id"), nullable=False),
    )
    op.execute(
        "INSERT INTO bill_journal_history SELECT transaction_id,bill_id FROM bill_ledger WHERE transaction_id IS NOT NULL"
    )
    op.create_table(
        "transfer_matches",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "outgoing_id",
            sa.String(),
            sa.ForeignKey("bills.id"),
            nullable=False,
            unique=True,
        ),
        sa.Column(
            "incoming_id",
            sa.String(),
            sa.ForeignKey("bills.id"),
            nullable=False,
            unique=True,
        ),
        sa.Column(
            "transaction_id",
            sa.Integer(),
            sa.ForeignKey("transactions.id"),
            nullable=False,
        ),
        sa.Column("note", sa.Text(), nullable=False),
        sa.Column("created_at", sa.String(), nullable=False),
    )


def downgrade():
    raise RuntimeError("请恢复升级前备份，避免丢失匹配及配置记录")
