import { TransactionSemantics } from "./TransactionSemantics";
import type { Row } from "./api";
import type { DistributionLink, DistributionNode } from "./AccountDistribution";
import type { SingleAccountSelection } from "./SingleAccountDrilldown";

export type SingleAccountFlowMode = "cashflow" | "counterparties";

interface Movement {
  id: number;
  row: Row;
  change: number;
  amount: number;
  direction: "incoming" | "outgoing";
}

interface Part {
  key: string;
  label: string;
  amount: number;
}

interface Bucket {
  key: string;
  label: string;
  amount: number;
  ids: Set<number>;
  children: Map<string, Bucket>;
}

/** Build signed, traceable flows from actual movements, without scaled amounts. */
export class SingleAccountFlowData {
  nodes: DistributionNode[] = [];
  links: DistributionLink[] = [];
  adjustments: Row[] = [];
  positiveTotal = 0;
  total = 0;
  signedTotal = 0;
  incoming = 0;
  outgoing = 0;
  height = 380;
  unallocated = 0;
  unavailableCount = 0;
  excludedValuationCount = 0;
  partyCount = 0;
  displayedPartyCount = 0;
  allocationNotes: string[] = [];
  readonly namespace: string;
  private ids = new Set<number>();
  private records: Map<number, Row>;

  constructor(
    public account: Row,
    public mode: SingleAccountFlowMode,
    options: { partyLimit?: number } = {},
  ) {
    this.namespace = `single-account:${account.id}:${mode}`;
    this.records = new Map(
      (account.transactions || []).map((row: Row) => [Number(row.id), row]),
    );
    if (mode === "cashflow") this.cashflow();
    else this.counterparties(options.partyLimit);
    this.total = this.positiveTotal;
    this.signedTotal = this.incoming - this.outgoing;
    this.height = Math.max(
      380,
      this.nodes.filter((node) => node.depth === 2).length * 44 + 64,
    );
  }

  private change(row: Row): number | undefined {
    if (row.account_change !== undefined && row.account_change !== null) {
      const value = Number(row.account_change);
      if (Number.isFinite(value)) return value;
    }
    const entries: Row[] = (row.entries || []).filter(
      (entry: Row) => Number(entry.account_id) === Number(this.account.id),
    );
    if (
      entries.length &&
      entries.every((entry) => Number.isFinite(Number(entry.amount)))
    )
      return entries.reduce((sum, entry) => sum + Number(entry.amount), 0);
    return undefined;
  }

  private movement(row: Row): Movement | undefined {
    const id = Number(row.id);
    const original = this.records.get(id);
    const change =
      this.change(row) ?? (original ? this.change(original) : undefined);
    if (!Number.isInteger(id) || change === undefined) {
      this.unavailableCount++;
      return undefined;
    }
    if (!change) return undefined;
    return {
      id,
      row: { ...original, ...row },
      change,
      amount: Math.abs(change),
      direction: change > 0 ? "incoming" : "outgoing",
    };
  }

  private record(movement: Movement) {
    this.ids.add(movement.id);
    this.positiveTotal += movement.amount;
    if (movement.change > 0) this.incoming += movement.amount;
    else this.outgoing += movement.amount;
  }

  private scope(
    key: string,
    label: string,
    ids: Iterable<number>,
  ): SingleAccountSelection {
    return {
      movement: {
        key: `${this.namespace}:${key}`,
        label,
        mode: this.mode,
        transaction_ids: [...new Set(ids)].sort((a, b) => a - b),
      },
    };
  }

  all(): SingleAccountSelection {
    return this.scope(
      "all",
      this.mode === "cashflow"
        ? "图中全部账户变动"
        : "图中全部交易方往来（不含估值）",
      this.ids,
    );
  }

  private node(
    key: string,
    label: string,
    path: string,
    depth: number,
    value: number,
    ids: Iterable<number>,
    color: string,
    sign?: number,
  ) {
    const name = `${this.namespace}:${key}`;
    this.nodes.push({
      name,
      displayName: label,
      path: `${this.account.name || "当前账户"} / ${path}`,
      depth,
      value,
      signedValue: sign === undefined ? undefined : value * sign,
      shareTotal: this.positiveTotal,
      shareLabel: "期间流入流出总额",
      selection: this.scope(key, path, ids),
      itemStyle: { color },
    });
    return name;
  }

  private link(source: string, target: string, value: number, sign: number) {
    const node = this.nodes.find((item) => item.name === target)!;
    this.links.push({
      source,
      target,
      value,
      signedValue: value * sign,
      shareTotal: this.positiveTotal,
      shareLabel: "期间流入流出总额",
      selection: this.selectionFor(target),
      lineStyle: { color: node.itemStyle.color },
    });
  }

  private bucket(buckets: Map<string, Bucket>, key: string, label: string) {
    if (!buckets.has(key))
      buckets.set(key, {
        key,
        label,
        amount: 0,
        ids: new Set(),
        children: new Map(),
      });
    return buckets.get(key)!;
  }

  private add(bucket: Bucket, movement: Movement, amount = movement.amount) {
    bucket.amount += amount;
    bucket.ids.add(movement.id);
  }

  private ordered(buckets: Map<string, Bucket>) {
    return [...buckets.values()].sort(
      (a, b) => b.amount - a.amount || a.key.localeCompare(b.key),
    );
  }

  /** Validate a complete kind before exposing any of its category allocations. */
  private categories(
    rows: Movement[],
    kind: "INCOME" | "EXPENSE",
  ): Map<number, Part[]> | undefined {
    if (!rows.length) return new Map();
    const categories: Row[] = (this.account.categories || []).filter(
      (row: Row) => row.kind === kind,
    );
    const total = rows.reduce((sum, row) => sum + row.amount, 0);
    const expectedSign = kind === "INCOME" ? 1 : -1;
    if (
      rows.some((row) => Math.sign(row.change) !== expectedSign) ||
      !categories.length ||
      categories.some(
        (row) =>
          !Array.isArray(row.transaction_ids) || !(Number(row.amount) > 0),
      ) ||
      categories.reduce((sum, row) => sum + Number(row.amount), 0) !== total
    )
      return undefined;
    const byId = new Map(categories.map((row) => [Number(row.id), row]));
    if (byId.size !== categories.length) return undefined;
    const memberships = new Map<number, number[]>();
    for (const row of rows) {
      const ids = categories
        .filter((category) => category.transaction_ids.includes(row.id))
        .map((category) => Number(category.id));
      if (!ids.length) return undefined;
      memberships.set(row.id, ids);
    }
    const entryRoots = new Map<number, Set<number>>();
    const publicEntries = (row: Movement): Row[] =>
      (row.row.entries || []).filter(
        (entry: Row) =>
          entry.role === "SYSTEM" &&
          entry.category_id !== undefined &&
          entry.category_id !== null,
      );
    for (const row of rows) {
      const candidates = memberships.get(row.id)!;
      for (const entry of publicEntries(row)) {
        const id = Number(entry.category_id);
        const allowed = byId.has(id)
          ? candidates.filter((key) => key === id)
          : candidates;
        const previous = entryRoots.get(id);
        entryRoots.set(
          id,
          new Set(
            previous ? allowed.filter((key) => previous.has(key)) : allowed,
          ),
        );
      }
    }
    const result = new Map<number, Part[]>();
    const sums = new Map<number, number>();
    const transactions = new Map<number, Set<number>>();
    for (const row of rows) {
      const candidates = memberships.get(row.id)!;
      const entries = publicEntries(row);
      const value = (entry: Row) =>
        Number(entry.amount) * (kind === "INCOME" ? -1 : 1);
      if (
        entries.length &&
        (entries.some((entry) => !(value(entry) > 0)) ||
          entries.reduce((sum, entry) => sum + value(entry), 0) !== row.amount)
      )
        return undefined;
      const amounts = new Map<number, number>();
      if (candidates.length === 1) amounts.set(candidates[0], row.amount);
      else {
        if (!entries.length) return undefined;
        for (const entry of entries) {
          const roots = entryRoots.get(Number(entry.category_id));
          if (!roots || roots.size !== 1) return undefined;
          const root = [...roots][0];
          amounts.set(root, (amounts.get(root) || 0) + value(entry));
        }
      }
      const parts: Part[] = [];
      for (const [id, amount] of amounts) {
        const category = byId.get(id)!;
        parts.push({
          key: `category:${kind}:${id}`,
          label: category.name || "未分类",
          amount,
        });
        sums.set(id, (sums.get(id) || 0) + amount);
        if (!transactions.has(id)) transactions.set(id, new Set());
        transactions.get(id)!.add(row.id);
      }
      result.set(row.id, parts);
    }
    for (const category of categories) {
      const id = Number(category.id);
      const actual = transactions.get(id) || new Set();
      const expected = new Set<number>(category.transaction_ids);
      if (
        sums.get(id) !== Number(category.amount) ||
        actual.size !== expected.size ||
        [...actual].some((key) => !expected.has(key))
      )
        return undefined;
    }
    return result;
  }

  private type(row: Movement) {
    if (row.row.kind === "OPENING")
      return { key: "opening", label: "期初余额录入" };
    if (TransactionSemantics.isValuation(row.row))
      return { key: "valuation", label: "证券估值变动" };
    if (row.row.kind === "INCOME") return { key: "income", label: "收入" };
    if (row.row.kind === "EXPENSE")
      return { key: "payments", label: "付款原额" };
    if (row.row.kind === "REFUND") return { key: "refunds", label: "退款" };
    if (row.row.kind === "TRANSFER")
      return row.change > 0
        ? { key: "transfer-in", label: "内部转入" }
        : { key: "transfer-out", label: "内部转出" };
    return { key: "adjustments", label: "账户调整" };
  }

  private leaf(row: Movement, type: string): Part {
    if (type === "transfer-in" || type === "transfer-out") {
      const accounts = new Map<string, string>();
      for (const entry of row.row.entries || [])
        if (
          ["ASSET", "LIABILITY"].includes(entry.role) &&
          Number(entry.account_id) !== Number(this.account.id)
        )
          accounts.set(
            String(entry.account_id),
            entry.account || `账户 #${entry.account_id}`,
          );
      const ids = [...accounts.keys()].sort();
      return {
        key: `accounts:${ids.join(",") || "unknown"}`,
        label: ids.length
          ? ids.map((id) => accounts.get(id)).join("、")
          : "对端账户未提供",
        amount: row.amount,
      };
    }
    const labels: Record<string, string> = {
      valuation: row.change > 0 ? "估值增加" : "估值减少",
      refunds: row.row.related_id ? "已关联原付款" : "未关联原付款",
      opening: "期初余额的实际录入",
      adjustments: "其他实际账户调整",
    };
    return {
      key: labels[type] || "unallocated",
      label: labels[type] || "分类未分配",
      amount: row.amount,
    };
  }

  private cashflow() {
    const rows: Movement[] = [];
    const seen = new Set<number>();
    for (const transaction of this.account.transactions || []) {
      const row = this.movement(transaction);
      if (!row || seen.has(row.id)) continue;
      seen.add(row.id);
      rows.push(row);
      this.record(row);
    }
    const allocations = new Map<string, Map<number, Part[]> | undefined>();
    for (const kind of ["INCOME", "EXPENSE"] as const) {
      const normal = rows.filter(
        (row) =>
          row.row.kind === kind && !TransactionSemantics.isValuation(row.row),
      );
      const parts = this.categories(normal, kind);
      allocations.set(kind, parts);
      if (!parts && normal.length) {
        this.unallocated += normal.reduce((sum, row) => sum + row.amount, 0);
        this.allocationNotes.push(
          `${kind === "INCOME" ? "收入" : "付款"}未能细分分类，点击“分类未分配”查看原交易。`,
        );
      }
    }
    const directions = new Map<string, Bucket>();
    for (const row of rows) {
      const direction = this.bucket(
        directions,
        row.direction,
        row.change > 0 ? "期间流入总额" : "期间流出总额",
      );
      const type = this.type(row);
      const middle = this.bucket(direction.children, type.key, type.label);
      this.add(direction, row);
      this.add(middle, row);
      const parts = allocations.get(row.row.kind)?.get(row.id) || [
        this.leaf(row, type.key),
      ];
      for (const part of parts)
        this.add(
          this.bucket(middle.children, part.key, part.label),
          row,
          part.amount,
        );
    }
    for (const direction of directions.values()) {
      const sign = direction.key === "incoming" ? 1 : -1;
      const color = sign > 0 ? "#73a58f" : "#b78863";
      const root = this.node(
        direction.key,
        direction.label,
        direction.label,
        0,
        direction.amount,
        direction.ids,
        color,
        sign,
      );
      for (const middle of this.ordered(direction.children)) {
        const path = `${direction.label} / ${middle.label}`;
        const middleKey = `${direction.key}:${middle.key}`;
        const name = this.node(
          middleKey,
          middle.label,
          path,
          1,
          middle.amount,
          middle.ids,
          color,
          sign,
        );
        this.link(root, name, middle.amount, sign);
        for (const leaf of this.ordered(middle.children)) {
          const target = this.node(
            `${middleKey}:${leaf.key}`,
            leaf.label,
            `${path} / ${leaf.label}`,
            2,
            leaf.amount,
            leaf.ids,
            color,
            sign,
          );
          this.link(name, target, leaf.amount, sign);
        }
      }
    }
  }

  private counterparties(limit?: number) {
    const parties = new Map<
      string,
      { key: string; label: string; rows: Movement[]; amount: number }
    >();
    const seen = new Set<number>();
    const valuations = new Set<number>();
    for (const group of this.account.counterparties?.valuations || [])
      for (const row of group.transactions || [])
        if (
          row.kind !== "OPENING" &&
          this.records.get(Number(row.id))?.kind !== "OPENING"
        )
          valuations.add(Number(row.id));
    for (const [index, party] of (
      this.account.counterparties?.parties || []
    ).entries()) {
      const key =
        party.key === undefined ? `unkeyed:${index}` : String(party.key);
      if (!parties.has(key))
        parties.set(key, {
          key,
          label: party.counterparty || "未填写交易方",
          rows: [],
          amount: 0,
        });
      const group = parties.get(key)!;
      for (const transaction of party.transactions || []) {
        const original = this.records.get(Number(transaction.id));
        if (transaction.kind === "OPENING" || original?.kind === "OPENING")
          continue;
        if (
          party.valuation ||
          TransactionSemantics.isValuation(transaction) ||
          TransactionSemantics.isValuation(original)
        ) {
          valuations.add(Number(transaction.id));
          continue;
        }
        const row = this.movement(transaction);
        if (!row || seen.has(row.id)) continue;
        seen.add(row.id);
        group.rows.push(row);
        group.amount += row.amount;
        this.record(row);
      }
    }
    this.excludedValuationCount = Math.max(
      valuations.size,
      Number(this.account.counterparties?.valuation_count || 0),
    );
    const ranked = [...parties.values()]
      .filter((party) => party.rows.length)
      .sort((a, b) => b.amount - a.amount || a.key.localeCompare(b.key));
    this.partyCount = ranked.length;
    const count = limit && limit > 0 ? Math.floor(limit) : ranked.length;
    const visible = new Set(ranked.slice(0, count).map((party) => party.key));
    this.displayedPartyCount = visible.size;
    const directions = new Map<string, Bucket>();
    const hidden = new Map<string, Set<string>>();
    for (const party of ranked)
      for (const row of party.rows) {
        const direction = this.bucket(
          directions,
          row.direction,
          row.change > 0 ? "收款" : "付款",
        );
        this.add(direction, row);
        const other = !visible.has(party.key);
        const key = other ? "other-parties" : `party:${party.key}`;
        if (other) {
          if (!hidden.has(row.direction)) hidden.set(row.direction, new Set());
          hidden.get(row.direction)!.add(party.key);
        }
        this.add(this.bucket(direction.children, key, party.label), row);
      }
    if (!this.positiveTotal) return;
    const root = this.node(
      "all",
      "往来总额（收款＋付款）",
      "全部交易方往来（不含估值）",
      0,
      this.positiveTotal,
      this.ids,
      "#5b819c",
    );
    for (const direction of directions.values()) {
      const sign = direction.key === "incoming" ? 1 : -1;
      const color = sign > 0 ? "#73a58f" : "#b78863";
      const name = this.node(
        direction.key,
        direction.label,
        direction.label,
        1,
        direction.amount,
        direction.ids,
        color,
        sign,
      );
      this.link(root, name, direction.amount, sign);
      for (const leaf of this.ordered(direction.children)) {
        const label =
          leaf.key === "other-parties"
            ? `其他 ${hidden.get(direction.key)!.size} 个交易方`
            : leaf.label;
        const target = this.node(
          `${direction.key}:${leaf.key}`,
          label,
          `${direction.label} / ${label}`,
          2,
          leaf.amount,
          leaf.ids,
          color,
          sign,
        );
        this.link(name, target, leaf.amount, sign);
      }
    }
  }

  selectionFor(
    value: string | { name?: string; target?: string },
  ): SingleAccountSelection | undefined {
    const name = typeof value === "string" ? value : value.target || value.name;
    const movement = this.nodes.find((node) => node.name === name)?.selection
      ?.movement;
    return movement
      ? {
          movement: {
            ...movement,
            transaction_ids: [...movement.transaction_ids],
          },
        }
      : undefined;
  }

  selection(params: {
    dataType?: string;
    data?: { name?: string; target?: string };
  }): SingleAccountSelection | undefined {
    if (!params.data || !["node", "edge"].includes(params.dataType || ""))
      return undefined;
    return this.selectionFor(
      params.dataType === "edge"
        ? { target: params.data.target }
        : { name: params.data.name },
    );
  }
}
