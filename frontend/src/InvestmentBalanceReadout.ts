import type { Row } from "./api";
import { AccountDistribution } from "./AccountDistribution";
import { BalanceSheetStructure } from "./BalanceSheetStructure";

const amount = (value: unknown): number => {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
};
export function positiveShare(
  value: number,
  total: number,
): string | undefined {
  return Number.isFinite(value) &&
    Number.isFinite(total) &&
    value >= 0 &&
    total > 0
    ? `${((value / total) * 100).toFixed(1)}%`
    : undefined;
}

/** Account net results and balance movements use separate, explicit denominators. */
export class InvestmentReadoutData {
  rows: Row[];
  gains: Row[];
  losses: Row[];
  gainTotal: number;
  lossTotal: number;
  positiveEnding: number;
  negativeEnding: number;
  topAsset?: Row;
  change: number;
  bridge: { key: string; label: string; amount: number }[];
  residual: number;

  constructor(report: Row) {
    this.rows = (report.accounts || []).map((row: Row) => ({
      ...row,
      profit: amount(row.profit),
      ending: amount(row.ending),
    }));
    this.gains = this.rows
      .filter((row) => row.profit > 0)
      .sort((a, b) => b.profit - a.profit || a.id - b.id);
    this.losses = this.rows
      .filter((row) => row.profit < 0)
      .sort((a, b) => a.profit - b.profit || a.id - b.id);
    this.gainTotal = this.gains.reduce((sum, row) => sum + row.profit, 0);
    this.lossTotal = this.losses.reduce((sum, row) => sum - row.profit, 0);
    const positive = this.rows
      .filter((row) => row.ending > 0)
      .sort((a, b) => b.ending - a.ending || a.id - b.id);
    this.topAsset = positive[0];
    this.positiveEnding = positive.reduce((sum, row) => sum + row.ending, 0);
    this.negativeEnding = this.rows.reduce(
      (sum, row) => sum + Math.min(0, row.ending),
      0,
    );
    this.change = amount(report.ending) - amount(report.beginning);
    this.bridge = [
      {
        key: "opening_added",
        label: "本期新设期初",
        amount: amount(report.opening_added),
      },
      {
        key: "capital_net",
        label: "本金净转入",
        amount: amount(report.capital_net),
      },
      {
        key: "asset_profit",
        label: "资产账户净收益",
        amount: amount(report.asset_profit ?? report.profit),
      },
      {
        key: "internal_net",
        label: "理财账户内转净额",
        amount: amount(report.internal_net),
      },
      {
        key: "other_changes",
        label: "其他余额变动",
        amount: amount(report.other_changes),
      },
    ];
    this.residual =
      this.change - this.bridge.reduce((sum, item) => sum + item.amount, 0);
  }
}

/** Work from the existing asset/liability projection so composite balances stay split. */
export class BalanceReadoutData {
  assets: Row[];
  liabilities: Row[];
  positiveAssets: number;
  negativeAssets: number;
  positiveDebts: number;
  prepayments: number;
  topAssetGroup?: Row;
  topDebt?: Row;
  debtToAssets?: string;

  constructor(snapshot: Row) {
    const structure = new BalanceSheetStructure(snapshot);
    this.assets = structure
      .accounts("ASSET")
      .map((row) => ({ ...row, amount: amount(row.amount) }));
    this.liabilities = structure
      .accounts("LIABILITY")
      .map((row) => ({ ...row, amount: amount(row.amount) }));
    this.positiveAssets = this.assets.reduce(
      (sum, row) => sum + Math.max(0, row.amount),
      0,
    );
    this.negativeAssets = this.assets.reduce(
      (sum, row) => sum + Math.min(0, row.amount),
      0,
    );
    this.positiveDebts = this.liabilities.reduce(
      (sum, row) => sum + Math.max(0, row.amount),
      0,
    );
    this.prepayments = this.liabilities.reduce(
      (sum, row) => sum + Math.min(0, row.amount),
      0,
    );
    this.topDebt = this.liabilities
      .filter((row) => row.amount > 0)
      .sort((a, b) => b.amount - a.amount || a.id - b.id)[0];
    const groups = new Map<number, Row>();
    for (const row of this.assets) {
      const groupId = snapshot.groups.some(
        (group: Row) => group.id === row.group_id,
      )
        ? row.group_id
        : 0;
      if (!groups.has(groupId))
        groups.set(groupId, {
          id: groupId,
          name: groupId
            ? AccountDistribution.path(snapshot.groups, groupId)
            : "未分组",
          positive: 0,
          negative: 0,
        });
      const group = groups.get(groupId)!;
      group.positive += Math.max(0, row.amount);
      group.negative += Math.min(0, row.amount);
    }
    this.topAssetGroup = [...groups.values()]
      .filter((group) => group.positive > 0)
      .sort((a, b) => b.positive - a.positive || a.id - b.id)[0];
    this.debtToAssets = positiveShare(
      amount(snapshot.liabilities),
      amount(snapshot.assets),
    );
  }
}
