/** Money fields are integer fen; API timestamps use Asia/Shanghai. */
export type AccountRole = "ASSET" | "LIABILITY" | "EXTERNAL" | "SYSTEM";
export type TransactionKind =
  "INCOME" | "EXPENSE" | "REFUND" | "TRANSFER" | "OPENING" | "REVERSAL";
export type LedgerStatus =
  "PENDING" | "POSTED" | "IGNORED" | "LINKED" | "REVERSED";
export interface AccountRecord {
  id: number;
  name: string;
  number: string;
  role: AccountRole;
  kind: string;
  tags: string[];
  active: boolean;
  is_followed?: boolean;
  balance: number;
  group_id: number | null;
  opening_set: boolean;
  opening_status: "UNSET" | "PARTIAL" | "COMPLETE";
  merged_into_id: number | null;
}
export interface TransactionEntry {
  account_id: number;
  original_account_id: number;
  account: string;
  role: AccountRole;
  amount: number;
  category_id: number | null;
  category: string;
}
export interface TransactionRecord {
  id: number;
  bill_id: string | null;
  kind: TransactionKind;
  occurred_at: string;
  posted_at: string;
  amount: number;
  counterparty: string;
  note: string;
  tags: string[];
  status: "POSTED" | "REVERSED";
  purpose: "GENERAL" | "VALUATION" | "OPENING";
  entries: TransactionEntry[];
}
export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  page_size: number;
}
export interface WorkspaceSnapshot {
  accounts: AccountRecord[];
  groups: Record<string, any>[];
  categories: Record<string, any>[];
  tags: Record<string, any>[];
  pending_bill_count: number;
  revision: string;
}
