"""Persistence entities. Amounts are always signed integer fen (CNY)."""

from sqlalchemy import (
    Column,
    LargeBinary,
    Integer,
    BigInteger,
    String,
    Text,
    Boolean,
    ForeignKey,
    UniqueConstraint,
    CheckConstraint,
)
from sqlalchemy.orm import declarative_base

Base = declarative_base()


class Account(Base):
    __tablename__ = "accounts"
    id = Column(Integer, primary_key=True)
    name = Column(String, nullable=False, unique=True)
    number = Column(String, default="")
    note = Column(Text, nullable=False, default="")
    role = Column(String, nullable=False, default="ASSET")
    kind = Column(String, default="其他")
    tags = Column(Text, default="[]")
    active = Column(Boolean, default=True)
    opening_set = Column(Boolean, default=False)
    merged_into_id = Column(Integer, ForeignKey("accounts.id"))
    group_id = Column(Integer, ForeignKey("account_groups.id"))
    __table_args__ = (
        CheckConstraint("role IN ('ASSET','LIABILITY','EXTERNAL','SYSTEM')"),
    )


class AccountAlias(Base):
    """Stable provider identity, independent of the editable account display name."""

    __tablename__ = "account_aliases"
    id = Column(Integer, primary_key=True)
    provider = Column(String, nullable=False)
    owner = Column(String, nullable=False)
    source_name = Column(String, nullable=False)
    account_id = Column(Integer, ForeignKey("accounts.id"), nullable=False)
    __table_args__ = (UniqueConstraint("provider", "owner", "source_name"),)


class Category(Base):
    __tablename__ = "categories"
    id = Column(Integer, primary_key=True)
    name = Column(String, nullable=False)
    parent_id = Column(Integer, ForeignKey("categories.id"))
    merged_into_id = Column(Integer, ForeignKey("categories.id"))
    kind = Column(String, nullable=False)
    active = Column(Boolean, default=True)
    __table_args__ = (CheckConstraint("kind IN ('EXPENSE','INCOME')"),)


class Tag(Base):
    __tablename__ = "tags"
    id = Column(Integer, primary_key=True)
    name = Column(String, nullable=False, unique=True)
    parent_id = Column(Integer, ForeignKey("tags.id"), index=True)
    scope = Column(String, nullable=False, default="BOTH")
    active = Column(Boolean, nullable=False, default=True)
    __table_args__ = (CheckConstraint("scope IN ('ACCOUNT','TRANSACTION','BOTH')"),)


class Transaction(Base):
    __tablename__ = "transactions"
    id = Column(Integer, primary_key=True)
    kind = Column(String, nullable=False)
    occurred_at = Column(String, nullable=False, index=True)
    posted_at = Column(String, nullable=False)
    counterparty = Column(String, default="")
    note = Column(Text, default="")
    tags = Column(Text, default="[]")
    status = Column(String, default="POSTED")
    idempotency_key = Column(String, nullable=False, unique=True)
    reversal_of = Column(Integer, ForeignKey("transactions.id"), unique=True)
    related_id = Column(Integer, ForeignKey("transactions.id"))
    source = Column(String, default="手动")
    __table_args__ = (CheckConstraint("status IN ('POSTED','REVERSED')"),)


class Entry(Base):
    __tablename__ = "entries"
    id = Column(Integer, primary_key=True)
    transaction_id = Column(
        Integer, ForeignKey("transactions.id"), nullable=False, index=True
    )
    account_id = Column(Integer, ForeignKey("accounts.id"), nullable=False, index=True)
    amount = Column(BigInteger, nullable=False)
    category_id = Column(Integer, ForeignKey("categories.id"))
    __table_args__ = (CheckConstraint("amount != 0"),)


class ImportBatch(Base):
    __tablename__ = "import_batches"
    id = Column(Integer, primary_key=True)
    filename = Column(String, nullable=False)
    digest = Column(String, nullable=False, unique=True)
    created_at = Column(String, nullable=False)
    owner = Column(String, default="")
    metadata_json = Column(Text, default="{}")


class ImportRow(Base):
    __tablename__ = "import_rows"
    id = Column(Integer, primary_key=True)
    batch_id = Column(
        Integer, ForeignKey("import_batches.id"), nullable=False, index=True
    )
    line = Column(Integer, nullable=False)
    data = Column(Text, nullable=False)
    source_key = Column(String, nullable=False, index=True)
    status = Column(String, nullable=False)
    warning = Column(Text, default="")
    decision = Column(Text, default="{}")
    transaction_id = Column(Integer, ForeignKey("transactions.id"))
    __table_args__ = (UniqueConstraint("batch_id", "line"),)


class ImportSource(Base):
    __tablename__ = "import_sources"
    key = Column(String, primary_key=True)
    transaction_id = Column(Integer, ForeignKey("transactions.id"), nullable=False)
    row_id = Column(Integer, ForeignKey("import_rows.id"), nullable=False)


class AccountValuation(Base):
    __tablename__ = "account_valuations"
    id = Column(Integer, primary_key=True)
    account_id = Column(Integer, ForeignKey("accounts.id"), nullable=False, index=True)
    occurred_at = Column(String, nullable=False)
    recorded_at = Column(String, nullable=False)
    actual = Column(BigInteger, nullable=False)
    calculated = Column(BigInteger, nullable=False)
    change = Column(BigInteger, nullable=False)
    baseline = Column(Boolean, nullable=False, default=False)
    transaction_id = Column(Integer, ForeignKey("transactions.id"), unique=True)
    idempotency_key = Column(String, nullable=False, unique=True)
    note = Column(Text, default="")


class Reconciliation(Base):
    __tablename__ = "reconciliations"
    id = Column(Integer, primary_key=True)
    account_id = Column(Integer, ForeignKey("accounts.id"), nullable=False)
    at = Column(String, nullable=False)
    actual = Column(BigInteger, nullable=False)
    calculated = Column(BigInteger, nullable=False)
    note = Column(Text, default="")


class SavedReport(Base):
    __tablename__ = "saved_reports"
    id = Column(Integer, primary_key=True)
    name = Column(String, nullable=False)
    filters = Column(Text, default="{}")


class Bill(Base):
    """Provider-independent bill facts and separately versioned classification."""

    __tablename__ = "bills"
    id = Column(String, primary_key=True)
    facts = Column(Text, nullable=False)
    classification = Column(Text, default="null", nullable=False)
    revision = Column(Integer, default=0, nullable=False)
    saved_at = Column(String, nullable=False)


class BillClassificationHistory(Base):
    __tablename__ = "bill_classification_history"
    id = Column(Integer, primary_key=True)
    bill_id = Column(String, ForeignKey("bills.id"), nullable=False, index=True)
    revision = Column(Integer, nullable=False)
    classification = Column(Text, nullable=False)
    saved_at = Column(String, nullable=False)
    __table_args__ = (UniqueConstraint("bill_id", "revision"),)


class BillImportRun(Base):
    """One upload attempt; repeated source files still get their own audit trail."""

    __tablename__ = "bill_import_runs"
    id = Column(Integer, primary_key=True)
    batch_id = Column(Integer, ForeignKey("import_batches.id"))
    filename = Column(String, nullable=False)
    created_at = Column(String, nullable=False)
    status = Column(String, nullable=False)
    error = Column(Text, default="", nullable=False)
    summary = Column(Text, default="{}", nullable=False)
    committed_at = Column(String)
    result = Column(Text, default="{}", nullable=False)


class BillImportArtifact(Base):
    """Exact immutable bytes, included in the same transactional SQLite backup."""

    __tablename__ = "bill_import_artifacts"
    id = Column(Integer, primary_key=True)
    run_id = Column(
        Integer, ForeignKey("bill_import_runs.id"), nullable=False, index=True
    )
    stage = Column(String, nullable=False)
    filename = Column(String, nullable=False)
    content = Column(LargeBinary, nullable=False)
    digest = Column(String, nullable=False)
    created_at = Column(String, nullable=False)


class BillLedger(Base):
    """Financial lifecycle of a unified detail; source facts remain immutable."""

    __tablename__ = "bill_ledger"
    bill_id = Column(String, ForeignKey("bills.id"), primary_key=True)
    owner_run_id = Column(Integer, ForeignKey("bill_import_runs.id"), index=True)
    transaction_id = Column(Integer, ForeignKey("transactions.id"), unique=True)
    status = Column(String, nullable=False, default="PENDING")
    reason = Column(Text, nullable=False, default="")
    revoked_at = Column(String)
    __table_args__ = (
        CheckConstraint("status IN ('PENDING','POSTED','IGNORED','LINKED','REVERSED')"),
    )


class BillDisposition(Base):
    """Source bill routing state, independent of journal/settlement state."""

    __tablename__ = "bill_dispositions"
    source_key = Column(String, primary_key=True)
    status = Column(String, nullable=False)
    reason = Column(Text, nullable=False)
    changed_at = Column(String, nullable=False)
    __table_args__ = (CheckConstraint("status IN ('NORMAL','IGNORED','LINKED')"),)


class BillAssociation(Base):
    __tablename__ = "bill_associations"
    source_id = Column(String, ForeignKey("bills.id"), primary_key=True)
    target_id = Column(String, ForeignKey("bills.id"), nullable=False, index=True)
    kind = Column(String, nullable=False)
    note = Column(Text, nullable=False)
    created_at = Column(String, nullable=False)


class AccountGroup(Base):
    __tablename__ = "account_groups"
    id = Column(Integer, primary_key=True)
    name = Column(String, nullable=False, unique=True)
    parent_id = Column(Integer, ForeignKey("account_groups.id"))


class AccountMergeEvent(Base):
    __tablename__ = "account_merge_events"
    id = Column(Integer, primary_key=True)
    source_id = Column(Integer, ForeignKey("accounts.id"), nullable=False)
    target_id = Column(Integer, ForeignKey("accounts.id"), nullable=False)
    action = Column(String, nullable=False)
    created_at = Column(String, nullable=False)
    __table_args__ = (CheckConstraint("action IN ('MERGE','UNMERGE')"),)


class RefundMatch(Base):
    __tablename__ = "refund_matches"
    id = Column(Integer, primary_key=True)
    run_id = Column(Integer, ForeignKey("bill_import_runs.id"), nullable=False)
    batch_id = Column(Integer, ForeignKey("import_batches.id"), nullable=False)
    refund_id = Column(String, nullable=False, unique=True)
    payment_id = Column(String, nullable=False, index=True)
    note = Column(Text, nullable=False)
    matched_by = Column(String, nullable=False)
    created_at = Column(String, nullable=False)


class ClassificationPolicy(Base):
    __tablename__ = "classification_policy"
    id = Column(Integer, primary_key=True)
    revision = Column(Integer, nullable=False)
    content = Column(Text, nullable=False)
    updated_at = Column(String, nullable=False)


class BillNetting(Base):
    __tablename__ = "bill_netting"
    payment_id = Column(String, primary_key=True)
    original_minor = Column(BigInteger, nullable=False)
    refund_minor = Column(BigInteger, nullable=False)
    net_minor = Column(BigInteger, nullable=False)
    updated_at = Column(String, nullable=False)
    __table_args__ = (
        CheckConstraint(
            "original_minor = refund_minor + net_minor AND net_minor >= 0 AND refund_minor > 0"
        ),
    )


class BillJournalHistory(Base):
    __tablename__ = "bill_journal_history"
    transaction_id = Column(Integer, ForeignKey("transactions.id"), primary_key=True)
    bill_id = Column(String, ForeignKey("bills.id"), nullable=False)


class TransferMatch(Base):
    __tablename__ = "transfer_matches"
    id = Column(Integer, primary_key=True)
    outgoing_id = Column(String, ForeignKey("bills.id"), nullable=False, unique=True)
    incoming_id = Column(String, ForeignKey("bills.id"), nullable=False, unique=True)
    transaction_id = Column(Integer, ForeignKey("transactions.id"), nullable=False)
    note = Column(Text, nullable=False)
    created_at = Column(String, nullable=False)


class AnalysisSettings(Base):
    __tablename__ = "analysis_settings"
    id = Column(Integer, primary_key=True)
    revision = Column(Integer, nullable=False)
    content = Column(Text, nullable=False)
    updated_at = Column(String, nullable=False)
