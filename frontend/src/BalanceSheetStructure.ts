import type { Row } from "./api";
import {
  AccountDistribution,
  type DistributionAccountTag,
} from "./AccountDistribution";

/** Exclusive display tags follow the canonical account type, including merges. */
export class BalanceSheetAccountTag {
  static forAccount(account: Row): DistributionAccountTag {
    const kind = String(account.kind || "");
    if (["证券", "理财"].includes(kind))
      return { key: "investment", label: "理财" };
    if (["债权", "应收款"].includes(kind))
      return { key: "receivable", label: "应收款" };
    if (kind.includes("银行") || kind === "信用卡")
      return { key: "bank", label: "银行" };
    if (["支付宝", "微信", "零钱通", "支付宝小荷包", "小荷包"].includes(kind))
      return { key: "payment", label: "支付账户" };
    if (kind === "现金") return { key: "cash", label: "现金" };
    return { key: "other", label: "其他" };
  }
}

/** One statement projection shared by tables and distributions. */
export class BalanceSheetStructure {
  constructor(public snapshot: Row) {}
  accounts(role: string): Row[] {
    return this.snapshot.accounts
      .filter(
        (a: Row) => a.role === role || (a.composite && role === "LIABILITY"),
      )
      .map((a: Row) =>
        a.composite
          ? {
              ...a,
              name:
                a.name + (role === "LIABILITY" ? " · 负债部分" : " · 资产部分"),
              amount:
                role === "LIABILITY" ? a.liability_amount : a.asset_amount,
            }
          : a,
      );
  }
  path(id: number): string {
    return AccountDistribution.path(this.snapshot.groups, id);
  }
  tree(role: string): Row[] {
    const groups: Row[] = this.snapshot.groups;
    const accounts = this.accounts(role);
    const account = (a: Row): Row => ({
      ...a,
      key: `account:${a.id}`,
      nodeType: "account",
    });
    const group = (g: Row): Row | undefined => {
      const children: Row[] = [
        ...groups
          .filter((child) => child.parent_id === g.id)
          .flatMap((child) => {
            const row = group(child);
            return row ? [row] : [];
          }),
        ...accounts.filter((a) => a.group_id === g.id).map(account),
      ];
      if (!children.length) return undefined;
      return {
        key: `group:${g.id}`,
        name: g.name,
        nodeType: "group",
        children,
        amount: children.reduce((sum, row) => sum + row.amount, 0),
      };
    };
    const roots = groups
      .filter((g) => !groups.some((parent) => parent.id === g.parent_id))
      .flatMap((g) => {
        const row = group(g);
        return row ? [row] : [];
      });
    const ungrouped = accounts.filter((a) => a.group_id == null).map(account);
    if (ungrouped.length)
      roots.push({
        key: "ungrouped",
        name: "未分组",
        nodeType: "group",
        children: ungrouped,
        amount: ungrouped.reduce((sum, row) => sum + row.amount, 0),
      });
    return roots;
  }
}

/** Project the shared grouping model onto either side of a balance sheet. */
export class BalanceSheetDistribution extends AccountDistribution {
  constructor(
    public statement: BalanceSheetStructure,
    public role: string,
  ) {
    super(statement.snapshot.groups, statement.accounts(role), {
      namespace: role,
      title: role === "ASSET" ? "资产" : "负债",
      rootColor: role === "ASSET" ? "#326b53" : "#a47856",
      accountTag:
        role === "ASSET" ? BalanceSheetAccountTag.forAccount : undefined,
    });
  }
}
