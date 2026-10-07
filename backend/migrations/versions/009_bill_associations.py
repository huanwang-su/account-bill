"""Linked source vouchers never generate duplicate financial movements."""

from alembic import op
import sqlalchemy as sa

revision = "009"
down_revision = "008"
branch_labels = None
depends_on = None


def upgrade():
    op.rename_table("bill_ledger", "bill_ledger_previous")
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
        sa.CheckConstraint(
            "status IN ('PENDING','POSTED','IGNORED','LINKED','REVERSED')"
        ),
    )
    op.execute("INSERT INTO bill_ledger SELECT * FROM bill_ledger_previous")
    op.drop_table("bill_ledger_previous")
    op.create_index("ix_bill_ledger_owner_run_id", "bill_ledger", ["owner_run_id"])
    op.rename_table("bill_dispositions", "bill_dispositions_previous")
    op.create_table(
        "bill_dispositions",
        sa.Column("source_key", sa.String(), primary_key=True),
        sa.Column("status", sa.String(), nullable=False),
        sa.Column("reason", sa.Text(), nullable=False),
        sa.Column("changed_at", sa.String(), nullable=False),
        sa.CheckConstraint("status IN ('NORMAL','IGNORED','LINKED')"),
    )
    op.execute("INSERT INTO bill_dispositions SELECT * FROM bill_dispositions_previous")
    op.drop_table("bill_dispositions_previous")
    op.create_table(
        "bill_associations",
        sa.Column(
            "source_id", sa.String(), sa.ForeignKey("bills.id"), primary_key=True
        ),
        sa.Column("target_id", sa.String(), sa.ForeignKey("bills.id"), nullable=False),
        sa.Column("kind", sa.String(), nullable=False),
        sa.Column("note", sa.Text(), nullable=False),
        sa.Column("created_at", sa.String(), nullable=False),
    )
    op.create_index(
        "ix_bill_associations_target_id", "bill_associations", ["target_id"]
    )
    op.execute(
        "INSERT INTO bill_associations SELECT incoming_id,outgoing_id,'TRANSFER',note,created_at FROM transfer_matches"
    )
    op.execute(
        "UPDATE bill_dispositions SET status='LINKED' WHERE source_key IN (SELECT source_id FROM bill_associations)"
    )
    op.execute(
        "UPDATE bill_ledger SET status='LINKED' WHERE status='IGNORED' AND bill_id IN (SELECT source_id FROM bill_associations)"
    )
    op.execute(
        "UPDATE import_rows SET status='LINKED' WHERE source_key IN (SELECT source_id FROM bill_associations) AND status='IGNORED'"
    )


def downgrade():
    raise RuntimeError("请恢复升级前备份，保留凭证关联记录")
