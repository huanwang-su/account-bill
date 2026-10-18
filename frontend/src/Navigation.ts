export interface NavigationTarget {
  key: string;
  label: string;
  page: string;
  reportTab?: string;
}
export interface NavigationSection {
  key: string;
  label: string;
  children?: NavigationTarget[];
  page?: string;
}

/** Shared route definitions keep menu selection and programmatic links aligned. */
export class Navigation {
  static sections: NavigationSection[] = [
    { key: "overview", label: "总览", page: "overview" },
    {
      key: "reports",
      label: "统计报表",
      children: [
        ["balance-sheet", "资产负债表"],
        ["analysis", "收支分析"],
        ["income", "收入分析"],
        ["expenses", "支出分析"],
        ["single-accounts", "单账户分析"],
        ["investments", "理财分析"],
        ["counterparties", "交易方分析"],
        ["fund-flow", "资金流转"],
        ["details", "统计明细"],
      ].map(([reportTab, label]) => ({
        key: `report:${reportTab}`,
        label,
        page: "reports",
        reportTab,
      })),
    },
    { key: "accounts", label: "账户管理", page: "accounts" },
    {
      key: "ledger",
      label: "账务管理",
      children: [
        ["bills", "交易明细"],
        ["transactions", "账户流水"],
        ["imports", "账单导入"],
      ].map(([page, label]) => ({ key: page, page, label })),
    },
    {
      key: "management",
      label: "设置",
      children: [
        ["analysis-settings", "分析配置"],
        ["catalog", "分类与标签"],
        ["data", "数据管理"],
        ["settings", "账本设置"],
      ].map(([page, label]) => ({ key: page, page, label })),
    },
  ];
  static targets(): NavigationTarget[] {
    return this.sections.flatMap(
      (s) => s.children || [{ key: s.key, label: s.label, page: s.page! }],
    );
  }
  static target(page: string, reportTab: string): NavigationTarget {
    return (
      this.targets().find(
        (t) =>
          t.page === page && (page !== "reports" || t.reportTab === reportTab),
      ) || this.targets()[0]
    );
  }
  static parent(key: string): string | undefined {
    return this.sections.find((s) => s.children?.some((t) => t.key === key))
      ?.key;
  }
  static openKeys(keys: string[]): string[] {
    return keys.length ? [keys[keys.length - 1]] : [];
  }
}
