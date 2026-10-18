import type { Row } from "./api";
import { AccountDistribution } from "./AccountDistribution";

/** Signed net returns use separate positive-width gain/loss roots. */
export class InvestmentDistribution {
  assets: AccountDistribution;
  returns: AccountDistribution;
  constructor(report: Row, accounts: Row[], groups: Row[]) {
    const rows = report.accounts.map((row: Row) => ({
      ...row,
      group_id: accounts.find((a) => a.id === row.id)?.group_id ?? null,
    }));
    this.assets = new AccountDistribution(
      groups,
      rows.map((r: Row) => ({ ...r, amount: r.ending })),
      {
        namespace: "investment:asset",
        title: "理财资产",
        rootColor: "#326b53",
      },
    );
    const positive = rows.filter((r: Row) => r.profit > 0);
    const negative = rows.filter((r: Row) => r.profit < 0);
    const gain = new AccountDistribution(
      groups,
      positive.map((r: Row) => ({ ...r, amount: r.profit })),
      {
        namespace: "investment:gain",
        title: "盈利",
        rootLabel: "盈利账户合计",
        rootColor: "#326b53",
        color: "#73a58f",
      },
    );
    const loss = new AccountDistribution(
      groups,
      negative.map((r: Row) => ({ ...r, amount: -r.profit })),
      {
        namespace: "investment:loss",
        title: "亏损",
        rootLabel: "亏损账户合计",
        rootColor: "#a47856",
        color: "#b78863",
      },
    );
    for (const [part, sign, label] of [
      [gain, 1, "盈利"],
      [loss, -1, "亏损"],
    ] as const) {
      for (const row of [...part.nodes, ...part.links]) {
        row.signedValue = sign * row.value;
        row.shareTotal = part.positiveTotal;
        row.shareLabel = label;
      }
    }
    this.returns = gain;
    this.returns.nodes = [...gain.nodes, ...loss.nodes];
    this.returns.links = [...gain.links, ...loss.links];
    this.returns.total = rows.reduce(
      (sum: number, row: Row) => sum + row.profit,
      0,
    );
    this.returns.positiveTotal = gain.positiveTotal + loss.positiveTotal;
    this.returns.zeroCount = rows.filter((r: Row) => r.profit === 0).length;
    this.returns.height = Math.max(
      380,
      (positive.length + negative.length) * 46 + 64,
    );
  }
}
