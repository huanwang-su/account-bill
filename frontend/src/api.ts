export type Row = Record<string, any>;
export class LedgerApi {
  async request(path: string, method = "GET", body?: unknown): Promise<any> {
    const response = await fetch("/api" + path, {
      method,
      headers:
        body instanceof FormData
          ? { "X-Ledger-Client": "local-web" }
          : {
              "Content-Type": "application/json",
              "X-Ledger-Client": "local-web",
            },
      body:
        body === undefined
          ? undefined
          : body instanceof FormData
            ? body
            : JSON.stringify(body),
    });
    if (!response.ok) {
      const error = await response
        .json()
        .catch(() => ({ detail: "服务暂时不可用" }));
      throw new Error(
        typeof error.detail === "string" ? error.detail : "请检查输入内容",
      );
    }
    return response.json();
  }
  query(filters: Row) {
    return new URLSearchParams(
      Object.entries(filters)
        .filter(([, v]) => v !== undefined && v !== null && v !== "")
        .map(([k, v]) => [k, String(v)]),
    ).toString();
  }
  async transaction(id: number): Promise<Row | undefined> {
    const rows: Row[] = await this.request("/transactions?audit=true");
    return rows.find((row) => row.id === id);
  }
}
export class MoneyFormatter {
  static format(fen: number = 0) {
    return (fen / 100).toLocaleString("zh-CN", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  }
  static input(fen: number = 0) {
    return (fen / 100).toFixed(2);
  }
}
export class CategoryTree {
  constructor(private categories: Row[]) {}
  options(kind?: string, parent: number | null = null): any[] {
    return this.categories
      .filter((c) => c.parent_id === parent && (!kind || c.kind === kind))
      .map((c) => ({
        value: c.id,
        title: c.name + (c.active ? "" : "（停用）"),
        disabled: !c.active,
        children: this.options(kind, c.id),
      }));
  }
  path(id: number): string {
    const c = this.categories.find((x) => x.id === id);
    return c
      ? (c.parent_id ? this.path(c.parent_id) + " / " : "") + c.name
      : "";
  }
}

export class AccountGroupTree {
  constructor(private groups: Row[]) {}
  path(id: number): string {
    const group = this.groups.find((g) => g.id === id);
    return group
      ? (group.parent_id ? this.path(group.parent_id) + " / " : "") + group.name
      : "";
  }
  options(): Row[] {
    return this.groups.map((g) => ({ value: g.id, label: this.path(g.id) }));
  }
}

/** Reusable identity traversal for tree pickers and recursive filtering. */
export class LabelHierarchy {
  constructor(public rows: Row[]) {}
  descendants(id: number) {
    const ids = new Set([id]);
    let expanded = true;
    while (expanded) {
      expanded = false;
      for (const row of this.rows)
        if (ids.has(row.parent_id) && !ids.has(row.id)) {
          ids.add(row.id);
          expanded = true;
        }
    }
    return ids;
  }
  path(id: number): string {
    const names: string[] = [],
      seen = new Set<number>();
    while (id && !seen.has(id)) {
      const row = this.rows.find((r) => r.id === id);
      if (!row) break;
      seen.add(id);
      names.unshift(row.name);
      id = row.parent_id;
    }
    return names.join(" / ");
  }
}

export class TagTree extends LabelHierarchy {
  options(
    scope?: string,
    parent: number | null = null,
    numeric = false,
    excluded = new Set<number>(),
  ): any[] {
    return this.rows
      .filter(
        (r) =>
          (r.parent_id ?? null) === parent &&
          r.active !== false &&
          !excluded.has(r.id) &&
          (!scope || r.scope === "BOTH" || r.scope === scope),
      )
      .map((r) => ({
        value: numeric ? r.id : r.name,
        title: r.name,
        children: this.options(scope, r.id, numeric, excluded),
      }));
  }
  matches(values: string[], name: string) {
    const row = this.rows.find((r) => r.name === name);
    const names = row
      ? new Set(
          [...this.descendants(row.id)].map(
            (id) => this.rows.find((r) => r.id === id)?.name,
          ),
        )
      : new Set([name]);
    return values.some((value) => names.has(value));
  }
}

export class BillCategoryTree {
  constructor(
    private categories: Row[],
    private bills: Row[],
  ) {}
  options() {
    const roots: any[] = [];
    const add = (parts: string[]) => {
      let siblings = roots;
      const path: string[] = [];
      for (const part of parts) {
        path.push(part);
        const value = path.join(" / ");
        let node = siblings.find((r: any) => r.value === value);
        if (!node) {
          node = { title: part, value, children: [] };
          siblings.push(node);
        }
        siblings = node.children;
      }
    };
    const tree = new CategoryTree(this.categories);
    for (const row of this.categories)
      add([
        row.kind === "INCOME" ? "收入" : "支出",
        ...tree.path(row.id).split(" / "),
      ]);
    for (const row of this.bills)
      for (const path of row.category_paths ||
        (row.classification ? [row.classification.category_path] : []))
        add(path);
    return roots;
  }
  static matches(path: string[], selected: string) {
    const parts = selected
      .split("/")
      .map((s) => s.trim())
      .filter(Boolean);
    return parts.every((part, index) => path[index] === part);
  }
}
