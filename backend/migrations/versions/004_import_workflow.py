"""Staged imports with original, normalized and classified file snapshots."""

from alembic import op
import sqlalchemy as sa

revision = "004"
down_revision = "003"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "bill_import_runs",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("batch_id", sa.Integer(), sa.ForeignKey("import_batches.id")),
        sa.Column("filename", sa.String(), nullable=False),
        sa.Column("created_at", sa.String(), nullable=False),
        sa.Column("status", sa.String(), nullable=False),
        sa.Column("error", sa.Text(), nullable=False),
        sa.Column("summary", sa.Text(), nullable=False),
        sa.Column("committed_at", sa.String()),
        sa.Column("result", sa.Text(), nullable=False),
    )
    op.create_table(
        "bill_import_artifacts",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "run_id", sa.Integer(), sa.ForeignKey("bill_import_runs.id"), nullable=False
        ),
        sa.Column("stage", sa.String(), nullable=False),
        sa.Column("filename", sa.String(), nullable=False),
        sa.Column("content", sa.LargeBinary(), nullable=False),
        sa.Column("digest", sa.String(), nullable=False),
        sa.Column("created_at", sa.String(), nullable=False),
    )
    op.create_index(
        "ix_bill_import_artifacts_run_id", "bill_import_artifacts", ["run_id"]
    )


def downgrade():
    raise RuntimeError("请恢复升级前备份，避免丢失导入文件")
