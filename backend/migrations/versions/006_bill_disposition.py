"""Bill routing status: ignored source records never become active transaction details."""

from alembic import op
import sqlalchemy as sa

revision = "006"
down_revision = "005"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "bill_dispositions",
        sa.Column("source_key", sa.String(), primary_key=True),
        sa.Column("status", sa.String(), nullable=False),
        sa.Column("reason", sa.Text(), nullable=False),
        sa.Column("changed_at", sa.String(), nullable=False),
        sa.CheckConstraint("status IN ('NORMAL','IGNORED')"),
    )


def downgrade():
    raise RuntimeError("请恢复升级前备份，避免丢失忽略状态")
