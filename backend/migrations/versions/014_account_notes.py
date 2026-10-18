"""Keep account instructions separately from account identities and tags."""

from alembic import op
import sqlalchemy as sa

revision = "014"
down_revision = "013"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "accounts", sa.Column("note", sa.Text(), nullable=False, server_default="")
    )


def downgrade():
    raise RuntimeError("请恢复升级前备份，以保留账户备注")
