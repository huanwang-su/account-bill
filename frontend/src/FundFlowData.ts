import type { Row } from "./api";
import { AccountDistribution } from "./AccountDistribution";

export type FundFlowDimension = "account" | "group";
export type FundFlowView = "all" | "internal" | "external";

/** Two copies of each endpoint preserve both directions without Sankey cycles. */
export class FundFlowData extends AccountDistribution {
  private endpoints: Map<string, Row>;
  private scope: Set<number>;
  private visible: Row[];

  constructor(
    public report: Row,
    public dimension: FundFlowDimension = "account",
    public view: FundFlowView = "all",
  ) {
    super(report.groups || [], [], {
      namespace: "fund-flow",
      title: "资金流转",
    });
    this.endpoints = new Map(
      (report.endpoints || []).map((row: Row) => [row.key, row]),
    );
    this.scope = new Set(report.scope_account_ids || []);
    this.visible = (report.flows || []).filter((flow: Row) => {
      const internal =
        !this.endpoint(flow.source).external &&
        !this.endpoint(flow.target).external;
      return view === "all" || (view === "internal" ? internal : !internal);
    });
    const sides: Record<string, Map<string, Row>> = {
      source: new Map(),
      target: new Map(),
    };
    const routes = new Map<string, Row>();
    for (const flow of this.visible) {
      const source = this.entity(this.endpoint(flow.source));
      const target = this.entity(this.endpoint(flow.target));
      for (const [side, entity] of [
        ["source", source],
        ["target", target],
      ] as const) {
        const bucket = sides[side];
        if (!bucket.has(entity.key))
          bucket.set(entity.key, { ...entity, value: 0 });
        bucket.get(entity.key)!.value += flow.amount;
      }
      const key = JSON.stringify([source.key, target.key]);
      if (!routes.has(key)) routes.set(key, { source, target, value: 0 });
      routes.get(key)!.value += flow.amount;
    }
    this.positiveTotal = this.visible.reduce(
      (sum, flow) => sum + flow.amount,
      0,
    );
    this.total = this.positiveTotal;
    this.height = Math.max(
      420,
      Math.max(sides.source.size, sides.target.size) * 46 + 64,
    );
    const nodeName = (side: string, key: string) =>
      `fund-flow:${dimension}:${side}:${key}`;
    for (const [side, depth] of [
      ["source", 0],
      ["target", 1],
    ] as const) {
      for (const row of [...sides[side].values()].sort(
        (a, b) => b.value - a.value || a.key.localeCompare(b.key),
      )) {
        this.nodes.push({
          name: nodeName(side, row.key),
          displayName: row.name,
          path: `${side === "source" ? "转出方" : "转入方"} / ${row.path}`,
          depth,
          value: row.value,
          selection: {
            level: side,
            [side]: row.key,
            dimension,
            label: `${side === "source" ? "转出" : "转入"}：${row.path}`,
          },
          itemStyle: { color: row.color },
        });
      }
    }
    for (const row of [...routes.values()].sort(
      (a, b) =>
        b.value - a.value ||
        a.source.key.localeCompare(b.source.key) ||
        a.target.key.localeCompare(b.target.key),
    )) {
      this.links.push({
        source: nodeName("source", row.source.key),
        target: nodeName("target", row.target.key),
        value: row.value,
        selection: {
          level: "edge",
          source: row.source.key,
          target: row.target.key,
          dimension,
          label: `${row.source.path} → ${row.target.path}`,
        },
        lineStyle: { color: row.source.color },
      });
    }
  }
  private endpoint(key: string): Row {
    return (
      this.endpoints.get(key) || {
        key,
        name: "未识别账户",
        external: true,
        in_scope: false,
      }
    );
  }
  private inScope(endpoint: Row) {
    return (
      !endpoint.external &&
      (endpoint.in_scope ?? this.scope.has(endpoint.account_id))
    );
  }
  private entity(endpoint: Row): Row {
    const group = this.groups.find((row) => row.id === endpoint.group_id);
    const path = group
      ? AccountDistribution.path(this.groups, group.id)
      : "未分组";
    const color = endpoint.external
      ? "#b79a70"
      : AccountDistribution.colors[
          (group?.id ?? 0) % AccountDistribution.colors.length
        ];
    if (endpoint.external) return { ...endpoint, path: endpoint.name, color };
    return this.dimension === "group"
      ? {
          key: `group:${group?.id ?? 0}`,
          name: group?.name || "未分组",
          group_id: group?.id ?? 0,
          path,
          color,
        }
      : { ...endpoint, path: `${path} / ${endpoint.name}`, color };
  }
  flowRows(selection?: Row): Row[] {
    return this.visible.flatMap((flow) => {
      const sourceEndpoint = this.endpoint(flow.source),
        targetEndpoint = this.endpoint(flow.target);
      const source = this.entity(sourceEndpoint),
        target = this.entity(targetEndpoint);
      if (
        selection &&
        ((selection.source !== undefined && selection.source !== source.key) ||
          (selection.target !== undefined && selection.target !== target.key))
      )
        return [];
      return [
        {
          ...flow,
          source_name: source.name,
          target_name: target.name,
          source_account: sourceEndpoint.name,
          target_account: targetEndpoint.name,
          source_group: sourceEndpoint.external
            ? "外部"
            : AccountDistribution.path(this.groups, sourceEndpoint.group_id) ||
              "未分组",
          target_group: targetEndpoint.external
            ? "外部"
            : AccountDistribution.path(this.groups, targetEndpoint.group_id) ||
              "未分组",
          source_external: !!sourceEndpoint.external,
          target_external: !!targetEndpoint.external,
          source_in_scope: this.inScope(sourceEndpoint),
          target_in_scope: this.inScope(targetEndpoint),
        },
      ];
    });
  }
  summary(selection?: Row): Row {
    const flows = this.flowRows(selection);
    const incoming = flows.reduce(
      (sum, row) => sum + (row.target_in_scope ? row.amount : 0),
      0,
    );
    const outgoing = flows.reduce(
      (sum, row) => sum + (row.source_in_scope ? row.amount : 0),
      0,
    );
    return {
      amount: flows.reduce((sum, row) => sum + row.amount, 0),
      incoming,
      outgoing,
      net: incoming - outgoing,
      internal: flows
        .filter((row) => !row.source_external && !row.target_external)
        .reduce((sum, row) => sum + row.amount, 0),
      external_inflow: flows
        .filter((row) => row.source_external && row.target_in_scope)
        .reduce((sum, row) => sum + row.amount, 0),
      external_outflow: flows
        .filter((row) => row.target_external && row.source_in_scope)
        .reduce((sum, row) => sum + row.amount, 0),
      count: new Set(flows.map((row) => row.transaction_id)).size,
    };
  }
  stats(selection?: Row): Row[] {
    const buckets = new Map<string, Row>();
    const add = (endpoint: Row) => {
      const entity = this.entity(endpoint);
      if (!buckets.has(entity.key))
        buckets.set(entity.key, {
          ...entity,
          incoming: 0,
          outgoing: 0,
          internal_amount: 0,
          transactions: new Set<number>(),
          incoming_ids: new Set<number>(),
          outgoing_ids: new Set<number>(),
        });
      return buckets.get(entity.key)!;
    };
    if (!selection)
      for (const endpoint of this.endpoints.values())
        if (this.inScope(endpoint)) add(endpoint);
    for (const flow of this.flowRows(selection)) {
      const source = this.endpoint(flow.source),
        target = this.endpoint(flow.target);
      if (this.inScope(source)) {
        const bucket = add(source);
        bucket.outgoing += flow.amount;
        bucket.transactions.add(flow.transaction_id);
        bucket.outgoing_ids.add(flow.transaction_id);
      }
      if (this.inScope(target)) {
        const bucket = add(target);
        bucket.incoming += flow.amount;
        bucket.transactions.add(flow.transaction_id);
        bucket.incoming_ids.add(flow.transaction_id);
      }
      if (
        this.inScope(source) &&
        this.inScope(target) &&
        this.entity(source).key === this.entity(target).key
      )
        add(source).internal_amount += flow.amount;
    }
    return [...buckets.values()]
      .map(({ transactions, incoming_ids, outgoing_ids, ...row }): Row => ({
        ...row,
        net: row.incoming - row.outgoing,
        transaction_count: transactions.size,
        incoming_count: incoming_ids.size,
        outgoing_count: outgoing_ids.size,
      }))
      .sort(
        (a, b) =>
          b.incoming + b.outgoing - a.incoming - a.outgoing ||
          a.key.localeCompare(b.key),
      );
  }
  transactions(selection?: Row): Row[] {
    const amounts = new Map<number, number>();
    for (const flow of this.flowRows(selection))
      amounts.set(
        flow.transaction_id,
        (amounts.get(flow.transaction_id) || 0) + flow.amount,
      );
    return (this.report.transactions || [])
      .filter(
        (row: Row) =>
          amounts.has(row.id) ||
          (!selection &&
            (row.allocation === "merged_internal"
              ? this.view !== "external"
              : row.allocation === "unallocated" && this.view === "all")),
      )
      .map((row: Row) => ({
        ...row,
        selected_flow_amount: amounts.get(row.id) || 0,
        account_names: row.account_names || [
          ...new Set(
            (row.entries || [])
              .filter((entry: Row) =>
                ["ASSET", "LIABILITY"].includes(entry.role),
              )
              .map((entry: Row) => entry.account),
          ),
        ],
        category_names: row.category_names || [
          ...new Set(
            (row.entries || [])
              .filter((entry: Row) => entry.category)
              .map((entry: Row) => entry.category),
          ),
        ],
      }));
  }
  selection(params: { dataType?: string; data?: Row }): Row | undefined {
    if (params.dataType === "edge")
      return params.data?.selection ? { ...params.data.selection } : undefined;
    return this.selectionFor(params.data?.name || "");
  }
}
