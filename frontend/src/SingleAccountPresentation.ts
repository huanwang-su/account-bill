import type { Row } from "./api";

export class SingleAccountPresentation {
  static options = [
    { value: "cashflow", label: "收支分析" },
    { value: "counterparties", label: "交易方分析" },
    { value: "both", label: "两者都看" },
  ];
  static mode(account: Row) {
    return account.analysis_mode || "both";
  }
  static cashflow(account: Row) {
    return ["both", "cashflow"].includes(this.mode(account));
  }
  static counterparties(account: Row) {
    return ["both", "counterparties"].includes(this.mode(account));
  }
  static label(account: Row) {
    return (
      this.options.find((o) => o.value === this.mode(account))?.label ||
      "两者都看"
    );
  }
}
