"""Securities valuation audit records link to ordinary balanced transactions."""

from alembic import op
import sqlalchemy as sa

revision = "013"
down_revision = "012"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "account_valuations",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "account_id", sa.Integer(), sa.ForeignKey("accounts.id"), nullable=False
        ),
        sa.Column("occurred_at", sa.String(), nullable=False),
        sa.Column("recorded_at", sa.String(), nullable=False),
        sa.Column("actual", sa.BigInteger(), nullable=False),
        sa.Column("calculated", sa.BigInteger(), nullable=False),
        sa.Column("change", sa.BigInteger(), nullable=False),
        sa.Column("baseline", sa.Boolean(), nullable=False),
        sa.Column(
            "transaction_id",
            sa.Integer(),
            sa.ForeignKey("transactions.id"),
            unique=True,
        ),
        sa.Column("idempotency_key", sa.String(), nullable=False, unique=True),
        sa.Column("note", sa.Text(), nullable=True),
    )
    op.create_index(
        "ix_account_valuations_account_id", "account_valuations", ["account_id"]
    )


def downgrade():
    raise RuntimeError("请恢复升级前备份，以保留证券估值历史")
