import { DisplayMoneyFormatter as Money, type Row } from "./api";

/** Explain the snapshot without treating missing history or deposits as returns. */
export class OverviewReading {
  constructor(public data: Row) {}

  get headline() {
    const cash = this.data.household;
    if (!cash.income && !cash.expense && !cash.count && !cash.refunds)
      return "本月尚无生活收支记录，资产余额与理财表现可分别查看。";
    if (cash.expense < 0)
      return "本月退款抵减超过付款，净开支为负；生活收支与理财盈亏分别列示。";
    return `${cash.net > 0 ? "本月生活收支有结余" : cash.net < 0 ? "本月生活开支高于收入" : "本月生活收支持平"}；资产余额是截至日期的存量，不等于本月结余。`;
  }

  get mainExpense(): Row | undefined {
    return [...(this.data.household.categories || [])]
      .filter((row) => row.amount > 0)
      .sort((a, b) => b.amount - a.amount || a.id - b.id)[0];
  }

  get comparison() {
    const cash = this.data.household;
    const previous = cash.expense - cash.change;
    return {
      previous,
      value:
        previous <= 0
          ? "暂不比较增幅"
          : cash.change === 0
            ? "账面净开支持平"
            : `${cash.change > 0 ? "增加" : "减少"} ¥ ${Money.format(Math.abs(cash.change))}`,
      detail:
        previous <= 0
          ? "前一等长区间没有正额净开支，不能用它计算增长率。"
          : "比较已入账的净开支金额；未导入的记录不会计入。",
    };
  }

  get trend(): Row[] {
    let cumulative = 0;
    return (this.data.household.trend || []).map((row: Row) => {
      cumulative += row.expense;
      return { ...row, cumulative };
    });
  }

  get liabilityRatio(): string | undefined {
    const { assets, liabilities } = this.data;
    return assets > 0 && liabilities >= 0
      ? ((100 * liabilities) / assets).toFixed(1) + "%"
      : undefined;
  }

  get investmentShare(): string | undefined {
    const assets = this.data.assets,
      investments = this.data.investments.assets;
    return assets > 0 && investments >= 0 && investments <= assets
      ? ((100 * investments) / assets).toFixed(1) + "%"
      : undefined;
  }
}
