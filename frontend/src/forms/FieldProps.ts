import type { Row, CategoryTree } from "../api";
export interface LedgerFieldProps {
  modal?: string;
  editing?: Row;
  formKind: string;
  groups: Row[];
  tags: Row[];
  transactions: Row[];
  tree: CategoryTree;
  tagOptions: Row[];
  accountsOptions: Row[];
}
