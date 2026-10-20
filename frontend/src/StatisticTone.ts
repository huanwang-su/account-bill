export type StatisticRole =
  | "income"
  | "expense"
  | "net"
  | "balance"
  | "liability"
  | "transfer"
  | "neutral";

/** Financial meaning determines color; principal movements never imply profit. */
export class StatisticTone {
  static of(value: number, role: StatisticRole = "balance") {
    if (!Number.isFinite(value) || value === 0 || role === "neutral")
      return "muted";
    if (role === "transfer") return "primary";
    if (role === "expense") return value > 0 ? "expense" : "positive";
    if (role === "liability") return value > 0 ? "negative" : "positive";
    if (value < 0) return "negative";
    return role === "income" || role === "net" ? "positive" : "primary";
  }
}
