import type { Row } from "./api";

/** Diagram drilldowns intersect the current filters; explicit reset is separate. */
export class AnalysisFlowSelection {
  static descendant(rows: Row[], child: number, parent: number): boolean {
    const seen = new Set<number>();
    let id: number | undefined = child;
    while (id !== undefined && !seen.has(id)) {
      if (id === parent) return true;
      seen.add(id);
      id = rows.find((row) => row.id === id)?.parent_id ?? undefined;
    }
    return false;
  }

  static narrow(
    current: Row,
    selection: Row,
    groups: Row[],
    categories: Row[],
  ): Row {
    const filters = { ...current };
    for (const [key, hierarchy, exactKey] of [
      ["group_id", groups, "direct_group"],
      ["category_id", categories, "exact_category"],
    ] as const) {
      const next = selection[key];
      if (next === undefined || next === null) continue;
      const previous = current[key];
      if (previous === undefined || previous === null) {
        filters[key] = next;
        filters[exactKey] = selection[exactKey];
      } else if (previous === next) {
        // A parent-node click must not relax an existing exact/direct scope.
        filters[exactKey] = current[exactKey] || selection[exactKey];
      } else if (
        !current[exactKey] &&
        this.descendant(hierarchy, next, previous)
      ) {
        filters[key] = next;
        filters[exactKey] = selection[exactKey];
      }
      // Ancestor or unrelated selections never replace a narrower main filter.
    }
    return filters;
  }
}
