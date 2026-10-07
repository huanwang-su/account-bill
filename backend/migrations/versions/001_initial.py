"""Initial schema snapshot. Never modify an applied migration."""

from alembic import op

revision = "001"
down_revision = None
branch_labels = None
depends_on = None
STATEMENTS = [
    "\n"
    "CREATE TABLE accounts (\n"
    "\tid INTEGER NOT NULL, \n"
    "\tname VARCHAR NOT NULL, \n"
    "\tnumber VARCHAR, \n"
    "\trole VARCHAR NOT NULL, \n"
    "\tkind VARCHAR, \n"
    "\ttags TEXT, \n"
    "\tactive BOOLEAN, \n"
    "\topening_set BOOLEAN, \n"
    "\tPRIMARY KEY (id), \n"
    "\tCHECK (role IN ('ASSET','LIABILITY','EXTERNAL','SYSTEM')), \n"
    "\tUNIQUE (name)\n"
    ")\n"
    "\n",
    "\n"
    "CREATE TABLE categories (\n"
    "\tid INTEGER NOT NULL, \n"
    "\tname VARCHAR NOT NULL, \n"
    "\tparent_id INTEGER, \n"
    "\tkind VARCHAR NOT NULL, \n"
    "\tactive BOOLEAN, \n"
    "\tPRIMARY KEY (id), \n"
    "\tCHECK (kind IN ('EXPENSE','INCOME')), \n"
    "\tFOREIGN KEY(parent_id) REFERENCES categories (id)\n"
    ")\n"
    "\n",
    "\n"
    "CREATE TABLE import_batches (\n"
    "\tid INTEGER NOT NULL, \n"
    "\tfilename VARCHAR NOT NULL, \n"
    "\tdigest VARCHAR NOT NULL, \n"
    "\tcreated_at VARCHAR NOT NULL, \n"
    "\towner VARCHAR, \n"
    "\tmetadata_json TEXT, \n"
    "\tPRIMARY KEY (id), \n"
    "\tUNIQUE (digest)\n"
    ")\n"
    "\n",
    "\n"
    "CREATE TABLE saved_reports (\n"
    "\tid INTEGER NOT NULL, \n"
    "\tname VARCHAR NOT NULL, \n"
    "\tfilters TEXT, \n"
    "\tPRIMARY KEY (id)\n"
    ")\n"
    "\n",
    "\n"
    "CREATE TABLE tags (\n"
    "\tid INTEGER NOT NULL, \n"
    "\tname VARCHAR NOT NULL, \n"
    "\tscope VARCHAR NOT NULL, \n"
    "\tPRIMARY KEY (id), \n"
    "\tCHECK (scope IN ('ACCOUNT','TRANSACTION','BOTH')), \n"
    "\tUNIQUE (name)\n"
    ")\n"
    "\n",
    "\n"
    "CREATE TABLE transactions (\n"
    "\tid INTEGER NOT NULL, \n"
    "\tkind VARCHAR NOT NULL, \n"
    "\toccurred_at VARCHAR NOT NULL, \n"
    "\tposted_at VARCHAR NOT NULL, \n"
    "\tcounterparty VARCHAR, \n"
    "\tnote TEXT, \n"
    "\ttags TEXT, \n"
    "\tstatus VARCHAR, \n"
    "\tidempotency_key VARCHAR NOT NULL, \n"
    "\treversal_of INTEGER, \n"
    "\trelated_id INTEGER, \n"
    "\tsource VARCHAR, \n"
    "\tPRIMARY KEY (id), \n"
    "\tCHECK (status IN ('POSTED','REVERSED')), \n"
    "\tUNIQUE (idempotency_key), \n"
    "\tUNIQUE (reversal_of), \n"
    "\tFOREIGN KEY(reversal_of) REFERENCES transactions (id), \n"
    "\tFOREIGN KEY(related_id) REFERENCES transactions (id)\n"
    ")\n"
    "\n",
    "CREATE INDEX ix_transactions_occurred_at ON transactions (occurred_at)",
    "\n"
    "CREATE TABLE entries (\n"
    "\tid INTEGER NOT NULL, \n"
    "\ttransaction_id INTEGER NOT NULL, \n"
    "\taccount_id INTEGER NOT NULL, \n"
    "\tamount BIGINT NOT NULL, \n"
    "\tcategory_id INTEGER, \n"
    "\tPRIMARY KEY (id), \n"
    "\tCHECK (amount != 0), \n"
    "\tFOREIGN KEY(transaction_id) REFERENCES transactions (id), \n"
    "\tFOREIGN KEY(account_id) REFERENCES accounts (id), \n"
    "\tFOREIGN KEY(category_id) REFERENCES categories (id)\n"
    ")\n"
    "\n",
    "CREATE INDEX ix_entries_transaction_id ON entries (transaction_id)",
    "CREATE INDEX ix_entries_account_id ON entries (account_id)",
    "\n"
    "CREATE TABLE import_rows (\n"
    "\tid INTEGER NOT NULL, \n"
    "\tbatch_id INTEGER NOT NULL, \n"
    "\tline INTEGER NOT NULL, \n"
    "\tdata TEXT NOT NULL, \n"
    "\tsource_key VARCHAR NOT NULL, \n"
    "\tstatus VARCHAR NOT NULL, \n"
    "\twarning TEXT, \n"
    "\tdecision TEXT, \n"
    "\ttransaction_id INTEGER, \n"
    "\tPRIMARY KEY (id), \n"
    "\tUNIQUE (batch_id, line), \n"
    "\tFOREIGN KEY(batch_id) REFERENCES import_batches (id), \n"
    "\tFOREIGN KEY(transaction_id) REFERENCES transactions (id)\n"
    ")\n"
    "\n",
    "CREATE INDEX ix_import_rows_batch_id ON import_rows (batch_id)",
    "CREATE INDEX ix_import_rows_source_key ON import_rows (source_key)",
    "\n"
    "CREATE TABLE reconciliations (\n"
    "\tid INTEGER NOT NULL, \n"
    "\taccount_id INTEGER NOT NULL, \n"
    "\tat VARCHAR NOT NULL, \n"
    "\tactual BIGINT NOT NULL, \n"
    "\tcalculated BIGINT NOT NULL, \n"
    "\tnote TEXT, \n"
    "\tPRIMARY KEY (id), \n"
    "\tFOREIGN KEY(account_id) REFERENCES accounts (id)\n"
    ")\n"
    "\n",
    "\n"
    "CREATE TABLE import_sources (\n"
    '\t"key" VARCHAR NOT NULL, \n'
    "\ttransaction_id INTEGER NOT NULL, \n"
    "\trow_id INTEGER NOT NULL, \n"
    '\tPRIMARY KEY ("key"), \n'
    "\tFOREIGN KEY(transaction_id) REFERENCES transactions (id), \n"
    "\tFOREIGN KEY(row_id) REFERENCES import_rows (id)\n"
    ")\n"
    "\n",
]


def upgrade():
    for statement in STATEMENTS:
        op.get_bind().exec_driver_sql(statement)


def downgrade():
    raise RuntimeError("账本不支持破坏性降级，请恢复升级前备份")
