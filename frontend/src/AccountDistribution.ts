import type { Row } from "./api";

export interface DistributionNode {
  name: string;
  displayName: string;
  path: string;
  depth: number;
  value: number;
  accountId?: number;
  signedValue?: number;
  shareTotal?: number;
  shareLabel?: string;
  selection?: Row;
  itemStyle: { color: string };
}
export interface DistributionLink {
  source: string;
  target: string;
  value: number;
  signedValue?: number;
  shareTotal?: number;
  shareLabel?: string;
  selection?: Row;
  lineStyle: { color: string };
}
export interface DistributionAccountTag {
  key: string;
  label: string;
}

/** Direct ownership with an optional, exclusive tag between group and account. */
export class AccountDistribution {
  static colors = [
    "#6d9e8a",
    "#819ec0",
    "#b79a70",
    "#9b8fbb",
    "#6aa6aa",
    "#c28a86",
  ];
  static path(groups: Row[], id: number): string {
    const names: string[] = [],
      seen = new Set<number>();
    while (!seen.has(id)) {
      const group = groups.find((g: Row) => g.id === id);
      if (!group) break;
      seen.add(id);
      names.unshift(group.name);
      if (group.parent_id == null) break;
      id = group.parent_id;
    }
    return names.join(" / ");
  }
  nodes: DistributionNode[] = [];
  links: DistributionLink[] = [];
  adjustments: Row[];
  positiveTotal: number;
  total: number;
  zeroCount: number;
  height: number;
  constructor(
    public groups: Row[],
    rows: Row[],
    options: {
      namespace: string;
      title: string;
      rootColor?: string;
      rootLabel?: string;
      color?: string;
      accountTag?: (row: Row) => DistributionAccountTag;
    },
  ) {
    const { namespace, title } = options;
    const positive = rows.filter((a) => a.amount > 0);
    this.adjustments = rows.filter((a) => a.amount < 0);
    this.positiveTotal = positive.reduce((sum, a) => sum + a.amount, 0);
    this.total = rows.reduce((sum, a) => sum + a.amount, 0);
    this.zeroCount = rows.filter((a) => a.amount === 0).length;
    this.height = Math.max(380, positive.length * 46 + 64);
    if (!positive.length) return;
    const root = `${namespace}:total`;
    this.nodes.push({
      name: root,
      displayName:
        options.rootLabel ||
        title + (this.adjustments.length ? "正额合计" : "总额"),
      depth: 0,
      value: this.positiveTotal,
      path: title + "分布",
      selection: {
        namespace,
        level: "root",
        label: title,
        group_id: undefined,
        direct_group: undefined,
        account_id: undefined,
      },
      itemStyle: { color: options.rootColor || "#326b53" },
    });
    const buckets = new Map<
      string,
      { group?: Row; rows: Row[]; amount: number }
    >();
    for (const row of positive) {
      const group = groups.find((g: Row) => g.id === row.group_id);
      const key = group ? String(group.id) : "ungrouped";
      if (!buckets.has(key)) buckets.set(key, { group, rows: [], amount: 0 });
      const bucket = buckets.get(key)!;
      bucket.rows.push(row);
      bucket.amount += row.amount;
    }
    for (const [key, bucket] of [...buckets].sort(
      (a, b) => b[1].amount - a[1].amount || a[0].localeCompare(b[0]),
    )) {
      const groupId = `${namespace}:group:${key}`;
      const groupName = bucket.group?.name || "未分组";
      const direct =
        bucket.group &&
        groups.some((g: Row) => g.parent_id === bucket.group!.id);
      const path = bucket.group
        ? AccountDistribution.path(groups, bucket.group.id)
        : "未分组";
      const color =
        options.color ||
        AccountDistribution.colors[
          (bucket.group?.id ?? 0) % AccountDistribution.colors.length
        ];
      this.nodes.push({
        name: groupId,
        displayName: groupName + (direct ? "（直属）" : ""),
        path,
        depth: 1,
        value: bucket.amount,
        selection: {
          namespace,
          level: "group",
          label: path,
          group_id: bucket.group?.id ?? 0,
          direct_group: true,
          account_id: undefined,
        },
        itemStyle: { color },
      });
      this.links.push({
        source: root,
        target: groupId,
        value: bucket.amount,
        selection: this.nodes[this.nodes.length - 1].selection,
        lineStyle: { color },
      });
      const tagBuckets = new Map<
        string,
        {
          tag?: DistributionAccountTag;
          rows: Row[];
          amount: number;
        }
      >();
      for (const row of bucket.rows) {
        const tag = options.accountTag?.(row);
        const key = tag?.key || "";
        if (!tagBuckets.has(key))
          tagBuckets.set(key, { tag, rows: [], amount: 0 });
        const tagged = tagBuckets.get(key)!;
        tagged.rows.push(row);
        tagged.amount += row.amount;
      }
      for (const [, tagged] of [...tagBuckets].sort(
        (a, b) => b[1].amount - a[1].amount || a[0].localeCompare(b[0]),
      )) {
        const tag = tagged.tag;
        const tagId = tag && `${groupId}:tag:${tag.key}`;
        const tagSelection = tag && {
          namespace,
          level: "tag",
          label: path + " / " + tag.label,
          group_id: bucket.group?.id ?? 0,
          direct_group: true,
          account_tag: tag.key,
          account_tag_label: tag.label,
        };
        if (tag && tagId) {
          this.nodes.push({
            name: tagId,
            displayName: tag.label,
            path: path + " / " + tag.label,
            depth: 2,
            value: tagged.amount,
            selection: tagSelection,
            itemStyle: { color },
          });
          this.links.push({
            source: groupId,
            target: tagId,
            value: tagged.amount,
            selection: tagSelection,
            lineStyle: { color },
          });
        }
        for (const row of tagged.rows.sort(
          (a, b) => b.amount - a.amount || a.id - b.id,
        )) {
          const accountId = `${namespace}:account:${row.id}`;
          this.nodes.push({
            name: accountId,
            accountId: row.id,
            displayName: row.name,
            path: [path, tag?.label, row.name].filter(Boolean).join(" / "),
            depth: tag ? 3 : 2,
            value: row.amount,
            selection: {
              namespace,
              level: "account",
              label: row.name,
              group_id: bucket.group?.id ?? 0,
              direct_group: true,
              account_id: row.id,
              ...(tag && {
                account_tag: tag.key,
                account_tag_label: tag.label,
              }),
            },
            itemStyle: { color },
          });
          this.links.push({
            source: tagId || groupId,
            target: accountId,
            value: row.amount,
            selection: this.nodes[this.nodes.length - 1].selection,
            lineStyle: { color },
          });
        }
      }
    }
  }
  selectionFor(
    value: string | { name?: string; target?: string },
  ): Row | undefined {
    const name = typeof value === "string" ? value : value.target || value.name;
    const selection = this.nodes.find((node) => node.name === name)?.selection;
    return selection ? { ...selection } : undefined;
  }
  selection(params: {
    dataType?: string;
    data?: { name?: string; target?: string };
  }): Row | undefined {
    if (!params.data) return undefined;
    return this.selectionFor(
      params.dataType === "edge"
        ? { target: params.data.target }
        : { name: params.data.name },
    );
  }
}
