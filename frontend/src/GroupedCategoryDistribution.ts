import type { Row } from "./api";
import { AccountDistribution } from "./AccountDistribution";

/** A shared three-column flow: signed amount -> direct account group -> category. */
export class GroupedCategoryDistribution extends AccountDistribution {
  readonly selections: Map<number, Row>;
  static uncategorized(report: Row, groupId: number): Row {
    const buckets: Row[] = (report.group_categories || []).filter(
      (row: Row) =>
        Number(row.category_id) === 0 && (row.group_id ?? 0) === groupId,
    );
    const exact =
      buckets.length > 0 &&
      buckets.every((row) => Array.isArray(row.transaction_ids));
    let ambiguous = false;
    const ids = exact
      ? buckets.flatMap((row) => row.transaction_ids)
      : (report.transactions || [])
          .filter((row: Row) => {
            if (
              (row.entries || []).some(
                (entry: Row) =>
                  entry.role === "SYSTEM" &&
                  entry.category_id &&
                  entry.selected !== false,
              )
            )
              return false;
            const funding = [
              ...new Set(
                (row.entries || [])
                  .filter((entry: Row) =>
                    ["ASSET", "LIABILITY"].includes(entry.role),
                  )
                  .map((entry: Row) => entry.account_id),
              ),
            ];
            const owners = funding.map((id) =>
              (report.accounts || []).find((account: Row) => account.id === id),
            );
            const known = owners.length > 0 && owners.every(Boolean);
            const groups = new Set(
              owners.filter(Boolean).map((owner) => owner.group_id ?? 0),
            );
            if (known && !groups.has(groupId)) return false;
            if (!known || groups.size > 1) ambiguous = true;
            return true;
          })
          .map((row: Row) => row.id);
    return {
      group_id: groupId,
      transaction_ids: [...new Set<number>(ids)].sort((a, b) => a - b),
      amount: buckets.reduce((sum, row) => sum + row.amount, 0),
      exact: exact || !ambiguous,
    };
  }
  constructor(
    report: Row,
    groups: Row[],
    title: string,
    namespace: string,
    color: string,
  ) {
    const rows = (report.group_categories || []).map(
      (c: Row, index: number) => ({ ...c, id: index + 1 }),
    );
    super(groups, rows, { namespace, title, rootColor: color });
    this.selections = new Map(
      rows.map((r: Row) => [
        r.id,
        { group_id: r.group_id ?? 0, category_id: r.category_id },
      ]),
    );
    const reset = {
      group_id: undefined,
      direct_group: undefined,
      category_id: undefined,
      exact_category: undefined,
    };
    for (const node of this.nodes) {
      if (node.depth === 0) node.selection = { ...reset };
      else if (node.depth === 1) {
        const key = node.name.slice(`${namespace}:group:`.length);
        node.selection = {
          ...reset,
          group_id: key === "ungrouped" ? 0 : Number(key),
          direct_group: true,
        };
      } else {
        const selection = this.selections.get(node.accountId!);
        node.selection =
          selection?.category_id > 0
            ? { ...reset, ...selection, direct_group: true }
            : {
                income_detail: GroupedCategoryDistribution.uncategorized(
                  report,
                  selection?.group_id ?? 0,
                ),
              };
      }
    }
    for (const link of this.links)
      link.selection = this.selectionFor(link.target);
  }

  selectionFor(
    value: string | { name?: string; target?: string },
  ): Row | undefined {
    const name = typeof value === "string" ? value : value.target || value.name;
    const selection = this.nodes.find((node) => node.name === name)?.selection;
    return selection
      ? {
          ...selection,
          ...(selection.income_detail && {
            income_detail: {
              ...selection.income_detail,
              transaction_ids: [...selection.income_detail.transaction_ids],
            },
          }),
        }
      : undefined;
  }

  selection(params: {
    dataType?: string;
    data?: { name?: string; target?: string };
  }): Row | undefined {
    if (!params.data || !["node", "edge"].includes(params.dataType || ""))
      return undefined;
    return this.selectionFor(params.data);
  }
}
export class IncomeDistribution extends GroupedCategoryDistribution {
  constructor(report: Row, groups: Row[]) {
    super(report, groups, "家庭收入", "income", "#326b53");
  }
}
