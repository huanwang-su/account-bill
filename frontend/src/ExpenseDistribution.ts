import type { Row } from "./api";
import {
  AccountDistribution,
  type DistributionLink,
  type DistributionNode,
} from "./AccountDistribution";

/** Positive detail amounts flow through direct ownership and both category levels. */
export class ExpenseDistribution {
  nodes: DistributionNode[] = [];
  links: DistributionLink[] = [];
  adjustments: Row[] = [];
  positiveTotal = 0;
  total = 0;
  zeroCount = 0;
  height = 420;
  private selections = new Map<string, Row>();

  constructor(report: Row, groups: Row[]) {
    const detailed = Array.isArray(report.group_category_details);
    const source: Row[] = detailed
      ? report.group_category_details
      : report.group_categories || [];
    const buckets = new Map<string, Row>();
    for (const row of source) {
      const categoryId = Number(row.category_id);
      const parentId = Number(
        detailed ? (row.parent_id ?? categoryId) : categoryId,
      );
      const key = this.leafId(row.group_id, parentId, categoryId);
      const existing = buckets.get(key);
      if (existing) {
        for (const amount of ["amount", "paid", "refunds", "count"])
          existing[amount] += Number(row[amount] || 0);
      } else {
        buckets.set(key, {
          ...row,
          category_id: categoryId,
          parent_id: parentId,
          parent_name: detailed ? row.parent_name : row.name,
          amount: Number(row.amount || 0),
          paid: Number(row.paid || 0),
          refunds: Number(row.refunds || 0),
          count: Number(row.count || 0),
        });
      }
    }
    const rows = [...buckets.values()];
    this.total = rows.reduce((sum, row) => sum + row.amount, 0);
    this.zeroCount = rows.filter((row) => row.amount === 0).length;
    const positive = rows.filter((row) => row.amount > 0);
    this.positiveTotal = positive.reduce((sum, row) => sum + row.amount, 0);
    this.height = Math.max(420, positive.length * 46 + 64);
    const groupName = (id: number) =>
      id === 0
        ? "未分组"
        : AccountDistribution.path(groups, id) || `账户组 #${id}`;
    const leafName = (row: Row) =>
      !detailed
        ? "细分类未提供"
        : row.category_id > 0 && row.category_id === row.parent_id
          ? "未细分"
          : row.name || (row.category_id === -1 ? "未分配退款" : "未分类");
    const path = (row: Row) => {
      const parent =
        row.parent_name || (row.parent_id === -1 ? "退款抵减" : "未分类");
      const leaf = leafName(row);
      return `${groupName(Number(row.group_id || 0))} / ${parent}${leaf === parent ? "" : ` / ${leaf}`}`;
    };
    this.adjustments = rows
      .filter((row) => row.amount < 0)
      .map((row) => {
        const id = this.leafId(row.group_id, row.parent_id, row.category_id);
        const selection = {
          group_id: Number(row.group_id || 0),
          direct_group: true,
          category_id: row.category_id,
          exact_category: detailed ? true : undefined,
        };
        this.selections.set(id, selection);
        return {
          ...row,
          id,
          displayName: leafName(row),
          path: path(row),
          selection,
        };
      });
    if (!positive.length) return;

    const reset = {
      group_id: undefined,
      direct_group: undefined,
      category_id: undefined,
      exact_category: undefined,
    };
    const root = "expense:total";
    this.node({
      name: root,
      displayName: this.adjustments.length
        ? "家庭开支正额合计"
        : "家庭开支总额",
      path: "家庭开支分布",
      depth: 0,
      value: this.positiveTotal,
      itemStyle: { color: "#a47856" },
      selection: reset,
    });
    const groupBuckets = new Map<number, Row[]>();
    for (const row of positive) {
      const id = Number(row.group_id || 0);
      if (!groupBuckets.has(id)) groupBuckets.set(id, []);
      groupBuckets.get(id)!.push(row);
    }
    const amount = (items: Row[]) =>
      items.reduce((sum, row) => sum + row.amount, 0);
    for (const [groupId, items] of [...groupBuckets].sort(
      (a, b) => amount(b[1]) - amount(a[1]) || a[0] - b[0],
    )) {
      const group = groups.find((item) => item.id === groupId);
      const groupKey = `expense:group:${groupId}`;
      const direct =
        group && groups.some((item) => item.parent_id === group.id);
      const color =
        AccountDistribution.colors[
          Math.abs(groupId) % AccountDistribution.colors.length
        ];
      const groupSelection = {
        ...reset,
        group_id: groupId,
        direct_group: true,
      };
      this.node({
        name: groupKey,
        displayName:
          (group?.name || groupName(groupId)) + (direct ? "（直属）" : ""),
        path: groupName(groupId),
        depth: 1,
        value: amount(items),
        itemStyle: { color },
        selection: groupSelection,
      });
      this.link(root, groupKey, amount(items), color);
      const parents = new Map<number, Row[]>();
      for (const row of items) {
        if (!parents.has(row.parent_id)) parents.set(row.parent_id, []);
        parents.get(row.parent_id)!.push(row);
      }
      for (const [parentId, children] of [...parents].sort(
        (a, b) => amount(b[1]) - amount(a[1]) || a[0] - b[0],
      )) {
        const parentKey = `${groupKey}:parent:${parentId}`;
        const parentName =
          children[0].parent_name || (parentId === -1 ? "退款抵减" : "未分类");
        const parentSelection = {
          ...groupSelection,
          category_id: parentId,
          exact_category: undefined,
        };
        this.node({
          name: parentKey,
          displayName: parentName,
          path: `${groupName(groupId)} / ${parentName}`,
          depth: 2,
          value: amount(children),
          itemStyle: { color },
          selection: parentSelection,
        });
        this.link(groupKey, parentKey, amount(children), color);
        for (const row of children.sort(
          (a, b) => b.amount - a.amount || a.category_id - b.category_id,
        )) {
          const leafKey = this.leafId(groupId, parentId, row.category_id);
          this.node({
            ...row,
            name: leafKey,
            displayName: leafName(row),
            path: path(row),
            depth: 3,
            value: row.amount,
            itemStyle: { color },
            selection: {
              ...groupSelection,
              category_id: row.category_id,
              exact_category: detailed ? true : undefined,
            },
          });
          this.link(parentKey, leafKey, row.amount, color);
        }
      }
    }
  }
  private leafId(group: number | null, parent: number, category: number) {
    return `expense:group:${group || 0}:parent:${parent}:category:${category}`;
  }
  private node(node: DistributionNode) {
    this.nodes.push(node);
    if (node.selection) this.selections.set(node.name, node.selection);
  }
  private link(source: string, target: string, value: number, color: string) {
    this.links.push({
      source,
      target,
      value,
      lineStyle: { color },
      selection: this.selections.get(target),
    });
  }
  selectionFor(value: string | { name?: string; target?: string }) {
    const name = typeof value === "string" ? value : value.target || value.name;
    const selection = name ? this.selections.get(name) : undefined;
    return selection ? { ...selection } : undefined;
  }
  selection(params: {
    dataType?: string;
    data?: { name?: string; target?: string };
  }) {
    if (!params.data) return undefined;
    return this.selectionFor(
      params.dataType === "edge"
        ? { target: params.data.target }
        : { name: params.data.name },
    );
  }
}

export class SpendingScenario {
  static estimate(parents: Row[], selected: number[], percent: number) {
    const ratio = Math.max(0, Math.min(100, percent)) / 100;
    const base = parents
      .filter((r) => selected.includes(r.id))
      .reduce((sum, r) => sum + Math.max(0, r.amount), 0);
    return { base, reduction: Math.round(base * ratio), percent: ratio * 100 };
  }
}
