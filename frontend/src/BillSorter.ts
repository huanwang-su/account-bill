import { Row } from "./api";

export type BillSortOrder = "ascend" | "descend";

/** Sort the complete filtered set before PagedTable takes a page. */
export class BillSorter {
  static fields = [
    { value: "occurred_at", label: "交易时间" },
    { value: "amount", label: "交易金额" },
    { value: "counterparty", label: "交易对方" },
    { value: "description", label: "交易描述" },
    { value: "account", label: "资金账户" },
    { value: "category", label: "分类" },
    { value: "classification_status", label: "分类状态" },
    { value: "ledger_status", label: "入账状态" },
  ];
  private static collator = new Intl.Collator("zh-CN", { numeric: true });
  private static value(row: Row, field: string): string | number {
    switch (field) {
      case "amount":
        return row.effective_amount_minor ?? row.facts.amount_minor;
      case "occurred_at":
        return row.facts.occurred_at;
      case "counterparty":
        return row.facts.counterparty || "";
      case "description":
        return row.display_description || row.facts.description || "";
      case "account":
        return row.account_name || "";
      case "category":
        return (
          row.display_category_path ||
          row.classification?.category_path ||
          []
        ).join(" / ");
      default:
        return row[field] || "";
    }
  }
  static sort(rows: Row[], field: string, order: BillSortOrder): Row[] {
    return [...rows].sort((a, b) => {
      const x = this.value(a, field),
        y = this.value(b, field);
      const compared =
        typeof x === "number" && typeof y === "number"
          ? x - y
          : this.collator.compare(String(x), String(y));
      const stable = compared || this.collator.compare(a.id, b.id);
      return order === "ascend" ? stable : -stable;
    });
  }
}
