import type { Row } from "./api";

export class ReportMetrics {
  static percentage(
    numerator: number,
    denominator: number,
  ): string | undefined {
    if (
      !Number.isFinite(numerator) ||
      !Number.isFinite(denominator) ||
      denominator <= 0 ||
      numerator < 0 ||
      numerator > denominator
    )
      return undefined;
    const value = (numerator / denominator) * 100;
    if (value > 0 && value < 0.1) return "<0.1%";
    if (value > 99.9 && numerator < denominator) return ">99.9%";
    return `${value.toFixed(1)}%`;
  }
}

/** Rank both directions by gross activity; net alone hides repeated transfers. */
export class PartyMetrics {
  static gross(row: Row) {
    return (Number(row.incoming) || 0) + (Number(row.outgoing) || 0);
  }
  static rank(rows: Row[]) {
    return [...rows].sort(
      (a, b) =>
        this.gross(b) - this.gross(a) ||
        Math.abs((b.incoming || 0) - (b.outgoing || 0)) -
          Math.abs((a.incoming || 0) - (a.outgoing || 0)) ||
        (b.count || 0) - (a.count || 0) ||
        String(a.counterparty || "").localeCompare(
          String(b.counterparty || ""),
        ),
    );
  }
}
