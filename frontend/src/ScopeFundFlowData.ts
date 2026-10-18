import type { Row } from "./api";
import {
  AccountDistribution,
  type DistributionNode,
  type DistributionLink,
} from "./AccountDistribution";
import { FundFlowData } from "./FundFlowData";

/** A single scope counts only lines with one endpoint inside and one outside. */
export class ScopeFundFlowData extends AccountDistribution {
  scope: Row;
  private endpoints: Map<string, Row>;
  private boundary: Row[];
  constructor(
    public report: Row,
    scopeKey = "total",
  ) {
    super(report.groups || [], [], {
      namespace: "boundary",
      title: "范围资金进出",
    });
    this.scope =
      [
        report.summary,
        ...(report.group_scopes || []),
        ...(report.account_scopes || []),
      ].find((row) => row?.key === scopeKey) || report.summary;
    this.endpoints = new Map(
      (report.endpoints || []).map((row: Row) => [row.key, row]),
    );
    const incoming = new Set(this.scope.incoming_flow_ids || []);
    const outgoing = new Set(this.scope.outgoing_flow_ids || []);
    this.boundary = (report.flows || []).flatMap((flow: Row) => {
      const direction = incoming.has(flow.id)
        ? "IN"
        : outgoing.has(flow.id)
          ? "OUT"
          : undefined;
      if (!direction) return [];
      const counterpart = this.endpoints.get(
        direction === "IN" ? flow.source : flow.target,
      )!;
      return [
        {
          ...flow,
          direction,
          counterpart_key: counterpart.key,
          counterpart_name: counterpart.name,
          scope_group_id:
            this.endpoints.get(direction === "IN" ? flow.target : flow.source)
              ?.group_id ?? 0,
          scope_account_id: this.endpoints.get(
            direction === "IN" ? flow.target : flow.source,
          )?.account_id,
          scope_account_name: this.endpoints.get(
            direction === "IN" ? flow.target : flow.source,
          )?.name,
          source_name: this.endpoints.get(flow.source)?.name,
          target_name: this.endpoints.get(flow.target)?.name,
        },
      ];
    });
    this.positiveTotal = this.boundary.reduce(
      (sum, row) => sum + row.amount,
      0,
    );
    this.total = (this.scope.incoming || 0) - (this.scope.outgoing || 0);
    const nodes = new Map<string, DistributionNode>(),
      links = new Map<string, DistributionLink>();
    for (const row of this.boundary) {
      const title = row.direction === "IN" ? "流入" : "流出";
      const color = row.direction === "IN" ? "#73a58f" : "#b78863";
      const group = (report.groups || []).find(
        (group: Row) => group.id === row.scope_group_id,
      );
      const base = { scope_key: this.scope.key, direction: row.direction };
      const groupKey = `boundary:${row.direction}:group:${row.scope_group_id}`;
      const accountKey = `${groupKey}:account:${row.scope_account_id}`;
      const path = [
        {
          name: `boundary:${row.direction === "IN" ? "income" : "expense"}:total`,
          displayName: `${title}合计`,
          selection: {
            ...base,
            label: `${this.scope.name} · ${title}`,
            level: "direction",
          },
        },
        {
          name: groupKey,
          displayName: group?.name || "未分组",
          selection: {
            ...base,
            scope_group_id: row.scope_group_id,
            label: `${title} · ${group?.name || "未分组"}`,
            level: "group",
          },
        },
        {
          name: accountKey,
          displayName: row.scope_account_name,
          selection: {
            ...base,
            scope_group_id: row.scope_group_id,
            scope_account_id: row.scope_account_id,
            label: `${title} · ${row.scope_account_name}`,
            level: "account",
          },
        },
        {
          name: `${accountKey}:counterpart:${row.counterpart_key}`,
          displayName: row.counterpart_name,
          selection: {
            ...base,
            scope_group_id: row.scope_group_id,
            scope_account_id: row.scope_account_id,
            counterpart_key: row.counterpart_key,
            label: `${row.scope_account_name} · ${title} · ${row.counterpart_name}`,
            level: "counterpart",
          },
        },
      ];
      for (let depth = 0; depth < path.length; depth++) {
        const item = path[depth];
        if (!nodes.has(item.name))
          nodes.set(item.name, {
            ...item,
            path: `${this.scope.name} / ${path
              .slice(0, depth + 1)
              .map((item) => item.displayName)
              .join(" / ")}`,
            depth,
            value: 0,
            itemStyle: { color },
          });
        nodes.get(item.name)!.value += row.amount;
        if (depth) {
          const key = path[depth - 1].name + "->" + item.name;
          if (!links.has(key))
            links.set(key, {
              source: path[depth - 1].name,
              target: item.name,
              value: 0,
              selection: item.selection,
              lineStyle: { color },
            });
          links.get(key)!.value += row.amount;
        }
      }
    }
    // This model is a tree. Keep descendants contiguous in every column so
    // chronological import order cannot weave incoming and outgoing branches.
    const children = new Map<string, string[]>();
    for (const link of links.values()) {
      if (!children.has(link.source)) children.set(link.source, []);
      children.get(link.source)!.push(link.target);
    }
    const ordered: DistributionNode[] = [];
    const visit = (name: string) => {
      ordered.push(nodes.get(name)!);
      const branch = (children.get(name) || []).sort(
        (a, b) =>
          nodes.get(b)!.value - nodes.get(a)!.value || a.localeCompare(b),
      );
      branch.forEach(visit);
    };
    for (const direction of ["income", "expense"]) {
      const root = `boundary:${direction}:total`;
      if (nodes.has(root)) visit(root);
    }
    this.nodes = ordered;
    const rank = new Map(ordered.map((node, index) => [node.name, index]));
    this.links = [...links.values()].sort(
      (a, b) =>
        rank.get(a.source)! - rank.get(b.source)! ||
        rank.get(a.target)! - rank.get(b.target)!,
    );
    for (const row of [...this.nodes, ...this.links]) {
      row.shareTotal = this.positiveTotal;
      row.shareLabel = "跨范围进出合计";
    }
    this.height = Math.max(
      380,
      Math.max(
        ...[0, 1, 2, 3].map(
          (depth) => this.nodes.filter((row) => row.depth === depth).length,
        ),
      ) *
        46 +
        64,
    );
  }
  flowRows(selection?: Row): Row[] {
    return this.boundary.filter(
      (row) =>
        (!selection?.direction || row.direction === selection.direction) &&
        (selection?.scope_group_id === undefined ||
          row.scope_group_id === selection.scope_group_id) &&
        (!selection?.scope_account_id ||
          row.scope_account_id === selection.scope_account_id) &&
        (!selection?.counterpart_key ||
          row.counterpart_key === selection.counterpart_key),
    );
  }
  summary(selection?: Row): Row {
    const rows = this.flowRows(selection);
    const incoming = rows
      .filter((row) => row.direction === "IN")
      .reduce((sum, row) => sum + row.amount, 0);
    const outgoing = rows
      .filter((row) => row.direction === "OUT")
      .reduce((sum, row) => sum + row.amount, 0);
    return {
      incoming,
      outgoing,
      net: incoming - outgoing,
      count: new Set(rows.map((row) => row.transaction_id)).size,
    };
  }
  transactions(selection?: Row): Row[] {
    const matched = new Map<number, Row>();
    for (const flow of this.flowRows(selection)) {
      if (!matched.has(flow.transaction_id))
        matched.set(flow.transaction_id, { incoming: 0, outgoing: 0 });
      matched.get(flow.transaction_id)![
        flow.direction === "IN" ? "incoming" : "outgoing"
      ] += flow.amount;
    }
    return new FundFlowData(this.report)
      .transactions()
      .filter((row) => matched.has(row.id))
      .map((row) => {
        const amount = matched.get(row.id)!;
        return {
          ...row,
          boundary_incoming: amount.incoming,
          boundary_outgoing: amount.outgoing,
          boundary_amount: amount.incoming + amount.outgoing,
        };
      });
  }
}
