const assert = require("node:assert/strict"),
  path = require("node:path");
const { renderToStaticMarkup } = require("react-dom/server");
const { loadTs } = require("./source-loader.cjs");
const source = (name) => loadTs(path.resolve(__dirname, "../src", name));
const { InvestmentWorkspace } = source("InvestmentWorkspace.tsx"),
  { BalanceSheetWorkspace } = source("BalanceSheetWorkspace.tsx");
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
const investmentPage = new InvestmentWorkspace({
  groups,
  accounts: [],
  refreshKey: "test",
  onDetail() {},
  onUpdate() {},
  onAccounts() {},
});
investmentPage.state = {
  ...investmentPage.state,
  report: investment,
  loading: false,
};
const balancePage = new BalanceSheetWorkspace({
  groups,
  refreshKey: "test",
  onAccounts() {},
});
balancePage.state = { ...balancePage.state, snapshot, loading: false };
for (const page of [investmentPage, balancePage]) {
  const html = renderToStaticMarkup(page.render());
  assert.ok(!html.includes("结构看点"));
  assert.ok(!html.includes("本期看点"));
  assert.ok(!html.match(/NaN|Infinity|undefined%/));
}
console.log("Investment and balance presentation SSR passed.");
