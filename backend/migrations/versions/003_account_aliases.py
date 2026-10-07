"""Persist provider account identities across account renames."""

from alembic import op
import sqlalchemy as sa

revision = "003"
down_revision = "002"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "account_aliases",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("provider", sa.String(), nullable=False),
        sa.Column("owner", sa.String(), nullable=False),
        sa.Column("source_name", sa.String(), nullable=False),
        sa.Column(
            "account_id", sa.Integer(), sa.ForeignKey("accounts.id"), nullable=False
        ),
        sa.UniqueConstraint("provider", "owner", "source_name"),
    )


def downgrade():
    raise RuntimeError("请恢复升级前备份，避免丢失账户关联")
