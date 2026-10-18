import type { Row } from "./api";
import {
  AccountDistribution,
  type DistributionAccountTag,
} from "./AccountDistribution";
import { BalanceSheetAccountTag } from "./BalanceSheetStructure";

/** Attribute period changes after excluding opening entries, once per account. */
export class AccountMovementDistribution extends AccountDistribution {
  accounts: Row[];
  increase: number;
  decrease: number;
  /** Older reports retain enough opening detail to separate business changes. */
  static amounts(row: Row): Row {
    const finite = (value: unknown): number | undefined =>
      typeof value === "number" && Number.isFinite(value) ? value : undefined;
    const openings: Row[] = (row.breakdown || []).filter(
      (part: Row) => part.kind === "OPENING",
    );
    const opening_added =
      finite(row.opening_added) ??
      openings.reduce(
        (sum, part) =>
          sum +
          (finite(part.net_change) ??
            (finite(part.inflow) ?? 0) - (finite(part.outflow) ?? 0)),
        0,
      );
    const net_change =
      finite(row.net_change) ??
      (finite(row.ending_balance) ?? 0) - (finite(row.opening_balance) ?? 0);
    const operating_change =
      finite(row.operating_change) ?? net_change - opening_added;
    const openingIn = openings.length
      ? openings.reduce(
          (sum, part) =>
            sum + (finite(part.inflow) ?? Math.max(0, part.net_change || 0)),
          0,
        )
      : Math.max(0, opening_added);
    const openingOut = openings.length
      ? openings.reduce(
          (sum, part) =>
            sum + (finite(part.outflow) ?? Math.max(0, -part.net_change || 0)),
          0,
        )
      : Math.max(0, -opening_added);
    return {
      opening_added,
      operating_change,
      operating_inflow:
        finite(row.operating_inflow) ??
        (finite(row.inflow) !== undefined
          ? row.inflow - openingIn
          : Math.max(0, operating_change)),
      operating_outflow:
        finite(row.operating_outflow) ??
        (finite(row.outflow) !== undefined
          ? row.outflow - openingOut
          : Math.max(0, -operating_change)),
    };
  }
  static tag(account: Row): DistributionAccountTag {
    return account.role === "LIABILITY"
      ? { key: "liability", label: "负债" }
      : BalanceSheetAccountTag.forAccount(account);
  }
  constructor(
    public report: Row,
    groups: Row[],
  ) {
    super(groups, [], { namespace: "movement", title: "账户净变动" });
    const accounts: Row[] = (this.accounts = (report.accounts || []).map(
      (row: Row) => ({
        ...row,
        ...AccountMovementDistribution.amounts(row),
      }),
    ));
    this.increase = accounts.reduce(
      (sum, row) => sum + Math.max(0, row.operating_change),
      0,
    );
    this.decrease = accounts.reduce(
      (sum, row) => sum + Math.max(0, -row.operating_change),
      0,
    );
    this.positiveTotal = this.increase + this.decrease;
    this.total = this.increase - this.decrease;
    this.zeroCount = accounts.filter(
      (row) => row.operating_change === 0,
    ).length;
    const nonzero = accounts.filter((row) => row.operating_change !== 0);
    this.height = Math.max(420, nonzero.length * 46 + 64);
    for (const [direction, sign, title, color] of [
      ["increase", 1, "期间净增加", "#73a58f"],
      ["decrease", -1, "期间净减少", "#b78863"],
    ] as const) {
      const part = new AccountDistribution(
        groups,
        accounts
          .filter((row) => row.operating_change * sign > 0)
          .map((row) => ({ ...row, amount: Math.abs(row.operating_change) })),
        {
          namespace: "movement:" + direction,
          title,
          rootLabel: title + "合计",
          rootColor: direction === "increase" ? "#326b53" : "#a47856",
          color,
          accountTag: AccountMovementDistribution.tag,
        },
      );
      for (const row of [...part.nodes, ...part.links]) {
        row.signedValue = sign * row.value;
        row.shareTotal = this.positiveTotal;
        row.shareLabel = "期间增减幅度";
      }
      this.nodes.push(...part.nodes);
      this.links.push(...part.links);
    }
  }
  /** Chart selections affect only the local account table, never report scope. */
  rows(selection?: Row): Row[] {
    const accounts = this.accounts;
    if (!selection) return accounts;
    if (selection.account_id !== undefined)
      return accounts.filter((row) => row.id === selection.account_id);
    const direction =
      selection.namespace === "movement:increase"
        ? 1
        : selection.namespace === "movement:decrease"
          ? -1
          : undefined;
    const groupIds = new Set<number>([selection.group_id]);
    if (selection.group_id !== undefined && !selection.direct_group) {
      let added = true;
      while (added) {
        added = false;
        for (const group of this.groups)
          if (groupIds.has(group.parent_id) && !groupIds.has(group.id)) {
            groupIds.add(group.id);
            added = true;
          }
      }
    }
    return accounts.filter((row) => {
      const groupId = this.groups.some((group) => group.id === row.group_id)
        ? row.group_id
        : 0;
      return (
        (direction === undefined || row.operating_change * direction > 0) &&
        (selection.group_id === undefined || groupIds.has(groupId)) &&
        (selection.account_tag === undefined ||
          AccountMovementDistribution.tag(row).key === selection.account_tag)
      );
    });
  }
}
