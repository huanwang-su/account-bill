"""Configurable account merges, groups and auditable same-file refund decisions."""

from alembic import op
import sqlalchemy as sa

revision = "007"
down_revision = "006"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "account_groups",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("name", sa.String(), nullable=False, unique=True),
        sa.Column("parent_id", sa.Integer(), sa.ForeignKey("account_groups.id")),
    )
    with op.batch_alter_table("accounts") as batch:
        batch.add_column(sa.Column("merged_into_id", sa.Integer()))
        batch.add_column(sa.Column("group_id", sa.Integer()))
        batch.create_foreign_key(
            "fk_account_merge", "accounts", ["merged_into_id"], ["id"]
        )
        batch.create_foreign_key(
            "fk_account_group", "account_groups", ["group_id"], ["id"]
        )
    op.create_table(
        "account_merge_events",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "source_id", sa.Integer(), sa.ForeignKey("accounts.id"), nullable=False
        ),
        sa.Column(
            "target_id", sa.Integer(), sa.ForeignKey("accounts.id"), nullable=False
        ),
        sa.Column("action", sa.String(), nullable=False),
        sa.Column("created_at", sa.String(), nullable=False),
        sa.CheckConstraint("action IN ('MERGE','UNMERGE')"),
    )
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
        sa.Column("payment_id", sa.String(), nullable=False, unique=True),
        sa.Column("note", sa.Text(), nullable=False),
        sa.Column("matched_by", sa.String(), nullable=False),
        sa.Column("created_at", sa.String(), nullable=False),
    )


def downgrade():
    raise RuntimeError("请恢复升级前备份，避免丢失账户配置和退款匹配记录")
