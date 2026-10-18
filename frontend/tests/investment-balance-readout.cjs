const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { renderToStaticMarkup } = require("react-dom/server");
const { loadTs } = require("./source-loader.cjs");
const source = (name) => loadTs(path.resolve(__dirname, "../src", name));
const { InvestmentReadoutData, BalanceReadoutData, positiveShare } = source(
  "InvestmentBalanceReadout.ts",
);
const { InvestmentWorkspace } = source("InvestmentWorkspace.tsx");
const { BalanceSheetWorkspace } = source("BalanceSheetWorkspace.tsx");
function freeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(freeze);
  }
  return value;
}
const groups = [
  { id: 1, name: "家庭", parent_id: null },
  { id: 2, name: "成员", parent_id: 1 },
];
const metric = {
  gain: 0,
  loss: 0,
  ending: 0,
  profit: 0,
  beginning: 0,
  capital_net: 0,
  capital_in: 0,
  capital_out: 0,
  internal_net: 0,
  valuation_profit: 0,
  other_profit: 0,
  opening_added: 0,
  asset_profit: 0,
  other_changes: 0,
  active: true,
  kind: "证券",
  role: "ASSET",
};
const investment = freeze({
  ...metric,
  start: "2026-01-01",
  end: "2026-10-18",
  account_count: 4,
  asset_account_count: 4,
  beginning: 100,
  ending: 900,
  opening_added: 500,
  capital_net: 200,
  asset_profit: 100,
  profit: 100,
  gain: 500,
  loss: 400,
  reconciled: true,
  missing_opening_ids: [],
  trend: [],
  profits: [],
  transfers: [],
  accounts: [
    {
      ...metric,
      id: 1,
      name: "盈利账户",
      group_id: 1,
      ending: 600,
      profit: 200,
      gain: 400,
      loss: 200,
    },
    {
      ...metric,
      id: 2,
      name: "亏损账户",
      group_id: 2,
      ending: 400,
      profit: -100,
      gain: 100,
      loss: 200,
    },
    { ...metric, id: 3, name: "负余额账户", group_id: null, ending: -100 },
    { ...metric, id: 4, name: "零余额账户", group_id: 1 },
  ],
});
const originalInvestment = JSON.stringify(investment);
const data = new InvestmentReadoutData(investment);
assert.equal(data.change, 800);
assert.equal(
  data.bridge.reduce((sum, item) => sum + item.amount, 0),
  800,
);
assert.equal(data.residual, 0);
assert.equal(
  data.gainTotal,
  200,
  "Account net-profit contribution must not use gross positive transactions (500)",
);
assert.equal(
  data.lossTotal,
  100,
  "Account net-loss contribution must not use gross negative transactions (400)",
);
assert.equal(data.gains[0].id, 1);
assert.equal(data.losses[0].id, 2);
assert.equal(data.positiveEnding, 1000);
assert.equal(data.negativeEnding, -100);
assert.equal(
  positiveShare(data.topAsset.ending, data.positiveEnding),
  "60.0%",
  "Concentration must use positive balances, not the net balance after offsets",
);
assert.equal(JSON.stringify(investment), originalInvestment);
let selected;
const workspace = new InvestmentWorkspace({
  accounts: investment.accounts,
  groups,
  refreshKey: "test",
  onDetail() {},
  onUpdate() {},
  onAccounts() {},
});
workspace.state = {
  ...workspace.state,
  loading: false,
  report: investment,
  filters: { start: investment.start, end: investment.end },
};
const mainInvestmentHtml = renderToStaticMarkup(workspace.render());
assert.ok(!mainInvestmentHtml.includes("本期看点"));
assert.ok(!mainInvestmentHtml.includes('class="analysis-readout'));
assert.ok(!mainInvestmentHtml.match(/NaN|Infinity|undefined%/));

const snapshot = freeze({
  as_of: "2026-10-18",
  groups,
  assets: 580,
  liabilities: 120,
  net_assets: 460,
  missing_opening_ids: [],
  accounts: [
    {
      id: 10,
      name: "直属资产",
      role: "ASSET",
      group_id: 1,
      amount: 100,
      active: true,
    },
    {
      id: 11,
      name: "子组资产",
      role: "ASSET",
      group_id: 2,
      amount: 200,
      active: true,
    },
    {
      id: 12,
      name: "综合账户",
      role: "ASSET",
      group_id: 2,
      composite: true,
      amount: 250,
      asset_amount: 300,
      liability_amount: 50,
      active: true,
    },
    {
      id: 13,
      name: "负资产",
      role: "ASSET",
      group_id: null,
      amount: -20,
      active: true,
    },
    {
      id: 14,
      name: "欠款",
      role: "LIABILITY",
      group_id: 1,
      amount: 80,
      active: true,
    },
    {
      id: 15,
      name: "预付款",
      role: "LIABILITY",
      group_id: 2,
      amount: -10,
      active: true,
    },
  ],
});
const originalSnapshot = JSON.stringify(snapshot);
const balance = new BalanceReadoutData(snapshot);
assert.equal(
  balance.assets.reduce((sum, row) => sum + row.amount, 0),
  snapshot.assets,
);
assert.equal(
  balance.liabilities.reduce((sum, row) => sum + row.amount, 0),
  snapshot.liabilities,
);
assert.equal(balance.assets.find((row) => row.id === 12).amount, 300);
assert.equal(balance.liabilities.find((row) => row.id === 12).amount, 50);
assert.equal(balance.positiveAssets, 600);
assert.equal(balance.negativeAssets, -20);
assert.equal(balance.topAssetGroup.id, 2);
assert.equal(
  balance.topAssetGroup.positive,
  500,
  "Direct ownership must not repeat a child group's assets inside its parent",
);
assert.equal(
  positiveShare(balance.topAssetGroup.positive, balance.positiveAssets),
  "83.3%",
);
assert.equal(balance.positiveDebts, 130);
assert.equal(balance.prepayments, -10);
assert.equal(balance.topDebt.id, 14);
assert.equal(
  positiveShare(balance.topDebt.amount, balance.positiveDebts),
  "61.5%",
);
assert.equal(
  balance.debtToAssets,
  "20.7%",
  "Balance-sheet ratio uses net liabilities / net assets-side amount, distinct from concentration denominators",
);
assert.equal(JSON.stringify(snapshot), originalSnapshot);
const balanceWorkspace = new BalanceSheetWorkspace({
  groups,
  refreshKey: "test",
  onAccounts() {},
});
balanceWorkspace.state = {
  ...balanceWorkspace.state,
  snapshot,
  loading: false,
};
const mainBalanceHtml = renderToStaticMarkup(balanceWorkspace.render());
assert.ok(!mainBalanceHtml.includes("结构看点"));
assert.ok(!mainBalanceHtml.includes('class="analysis-readout'));
assert.ok(!mainBalanceHtml.match(/NaN|Infinity|undefined%/));
assert.equal(positiveShare(-1, 100), undefined);
assert.equal(positiveShare(1, 0), undefined);
assert.equal(positiveShare(1, -1), undefined);
assert.equal(positiveShare(Infinity, 1), undefined);
console.log(
  "Investment/balance findings passed: stock-flow bridge, net contribution and positive-balance denominators, signed/composite ownership, zero/negative safety, readout removal and immutable source data.",
);

for (const filename of process.argv.slice(2)) {
  const bundle = JSON.parse(fs.readFileSync(filename, "utf8"));
  const report = bundle.investments || bundle.report;
  if (report) {
    const current = new InvestmentReadoutData(report);
    if (report.reconciled) assert.equal(current.residual, 0);
    workspace.state.report = report;
    assert.ok(
      !renderToStaticMarkup(workspace.render()).match(
        /NaN|Infinity|undefined%/,
      ),
    );
  }
  if (bundle.balanceSheet) {
    const current = new BalanceReadoutData(bundle.balanceSheet);
    assert.equal(
      current.assets.reduce((sum, row) => sum + row.amount, 0),
      bundle.balanceSheet.assets,
    );
    assert.equal(
      current.liabilities.reduce((sum, row) => sum + row.amount, 0),
      bundle.balanceSheet.liabilities,
    );
    balanceWorkspace.state.snapshot = bundle.balanceSheet;
    assert.ok(
      !renderToStaticMarkup(balanceWorkspace.render()).match(
        /NaN|Infinity|undefined%/,
      ),
    );
  }
  console.log("Read-only report bundle analysis validated.");
}
