const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const { renderToStaticMarkup } = require("react-dom/server");
const { loadTs } = require("./source-loader.cjs");
const src = path.resolve(__dirname, "../src");
const source = (name) => loadTs(path.join(src, name));
const { ReportDrilldown, AnalysisDrilldownBar } = source(
  "AnalysisDrilldown.tsx",
);

assert.deepEqual(ReportDrilldown.period("2026-10-07"), {
  start: "2026-10-07",
  end: "2026-10-07",
  label: "2026-10-07",
});
assert.deepEqual(
  ReportDrilldown.period("2026-10", "month", {
    start: "2026-10-06",
    end: "2026-10-18",
  }),
  {
    start: "2026-10-06",
    end: "2026-10-18",
    label: "2026-10-06 至 2026-10-18",
  },
);
assert.equal(
  ReportDrilldown.period("2026-09", "month", { start: "2026-10-01" }),
  undefined,
);
assert.equal(ReportDrilldown.period("2026-02-30"), undefined);
assert.equal(ReportDrilldown.period(0), undefined);
assert.equal(
  ReportDrilldown.contains(
    ReportDrilldown.period("2026-10-07"),
    "2026-10-07 23:59:59",
  ),
  true,
);
assert.equal(
  ReportDrilldown.contains(
    ReportDrilldown.period("2026-10-07"),
    "2026-10-08 00:00:00",
  ),
  false,
);
assert.equal(ReportDrilldown.contains(undefined, undefined), true);
let clearCount = 0,
  resetCount = 0;
const bar = new AnalysisDrilldownBar({
  label: "当前明细",
  items: [{ key: "day", label: "10月7日", onClear: () => clearCount++ }],
  onReset: () => resetCount++,
});
const markup = renderToStaticMarkup(bar.render());
assert.ok(markup.includes("当前明细") && markup.includes("10月7日"));
const barTree = bar.render();
barTree.props.children[0].props.children[1][0].props.onClose({
  preventDefault() {},
});
barTree.props.children[1].props.onClick();
assert.equal(clearCount, 1);
assert.equal(resetCount, 1);
assert.equal(
  new AnalysisDrilldownBar({ items: [], onReset() {} }).render().props
    .children[1].props.disabled,
  true,
);

function instance(Component, props, state) {
  const value = new Component(props);
  value.state = { ...value.state, ...state };
  value.setState = (patch, done) => {
    value.state = {
      ...value.state,
      ...(typeof patch === "function" ? patch(value.state) : patch),
    };
    done?.();
  };
  return value;
}
console.log(
  "Shared chart-period boundaries and local scope clear/reset checks passed.",
);

const { IncomeDistribution } = source("GroupedCategoryDistribution.ts");
const { IncomeWorkspace } = source("IncomeWorkspace.tsx");
const { FinancialAnalysisWorkspace } = source("FinancialAnalysisWorkspace.tsx");
const { SingleAccountDrilldown, PartyMovement } = source(
  "SingleAccountDrilldown.ts",
);
const { SingleAccountWorkspace } = source("SingleAccountWorkspace.tsx");
const { CounterpartyWorkspace } = source("CounterpartyWorkspace.tsx");
const { BalanceSheetWorkspace } = source("BalanceSheetWorkspace.tsx");
const { BalanceSheetDistribution, BalanceSheetStructure } = source(
  "BalanceSheetStructure.ts",
);
const { InvestmentWorkspace } = source("InvestmentWorkspace.tsx");
const { InvestmentDistribution } = source("InvestmentDistribution.ts");

const groups = [
  { id: 1, name: "家庭" },
  { id: 2, parent_id: 1, name: "甲" },
  { id: 3, parent_id: 1, name: "乙" },
  { id: 4, parent_id: 2, name: "长期" },
];
const categories = [
  { id: 101, name: "收入", kind: "INCOME" },
  { id: 102, parent_id: 101, name: "子收入", kind: "INCOME" },
];
const incomeGraph = new IncomeDistribution(
  {
    group_categories: [
      { group_id: 2, category_id: 101, name: "收入", amount: 500 },
      { group_id: null, category_id: 102, name: "子收入", amount: 600 },
    ],
  },
  groups,
);
for (const edge of incomeGraph.links)
  assert.deepEqual(
    incomeGraph.selection({ dataType: "edge", data: edge }),
    incomeGraph.selectionFor(edge.target),
  );
assert.equal(incomeGraph.selectionFor("income:group:ungrouped").group_id, 0);
assert.ok(
  !(
    "account_id" in
    incomeGraph.selectionFor(
      incomeGraph.nodes.find((node) => node.depth === 2).name,
    )
  ),
  "Category flows must never submit synthetic account IDs",
);

const transactions = [
  {
    id: 1,
    kind: "INCOME",
    amount: 100,
    account_change: 100,
    counterparty: " Straße ",
    occurred_at: "2026-10-07 12:00:00",
  },
  {
    id: 2,
    kind: "INCOME",
    amount: 200,
    account_change: 200,
    counterparty: "STRASSE",
    occurred_at: "2026-10-17 12:00:00",
  },
  {
    id: 3,
    kind: "INCOME",
    amount: 300,
    account_change: 300,
    counterparty: "其他",
    occurred_at: "2026-10-17 12:00:00",
  },
];
const income = instance(
  IncomeWorkspace,
  { groups, accounts: [], categories, refreshKey: "test", onDetail() {} },
  {
    loading: false,
    grain: "month",
    level: 2,
    filters: { start: "2026-10-06", end: "2026-10-18", account_id: 5 },
    report: { transactions },
  },
);
let incomeRequests = 0;
income.load = async () => {
  incomeRequests++;
};
income.selectCategory(101);
assert.equal(income.state.filters.exact_category, true);
assert.equal(income.state.filters.account_id, 5);
income.selectPeriod("2026-10");
income.selectSource(" STRASSE ");
assert.deepEqual(
  income.transactionTable(transactions).props.dataSource.map((row) => row.id),
  [1, 2],
);
assert.equal(income.state.activeTab, "details");
assert.equal(
  incomeRequests,
  1,
  "Date/source drilldown must not re-query or change report totals",
);
assert.notEqual(income.sourceKey("ı"), income.sourceKey("I"));
income.state.level = 1;
income.selectCategory(101);
assert.equal(income.state.filters.exact_category, undefined);
assert.equal(income.state.detailPeriod, undefined);
assert.equal(income.state.detailSource, undefined);
income.resetFlow();
assert.equal(income.state.filters.category_id, undefined);
assert.equal(income.state.filters.account_id, 5);
assert.equal(income.state.filters.start, "2026-10-06");

const financial = instance(
  FinancialAnalysisWorkspace,
  {
    groups,
    accounts: [],
    categories,
    tags: [],
    refreshKey: "test",
    onDetail() {},
  },
  {
    loading: false,
    level: 2,
    grain: "month",
    filters: { start: "2026-10-06", end: "2026-10-18" },
    report: { transactions },
  },
);
financial.load = async () => {};
financial.selectCategory(101);
assert.equal(financial.state.filters.exact_category, true);
assert.equal(financial.state.activeTab, "categories");
financial.selectPeriod("2026-10");
assert.equal(financial.state.activeTab, "overview");
assert.equal(financial.state.detailPeriod.start, "2026-10-06");
financial.resetCategory();
assert.equal(financial.state.filters.category_id, undefined);
assert.equal(financial.state.detailPeriod, undefined);
console.log(
  "Income flow, exact category, source/date combinations and return scope passed.",
);

const split = {
  id: 4,
  kind: "EXPENSE",
  amount: 1000,
  account_change: -1000,
  counterparty: "商店",
  occurred_at: "2026-10-07 12:00:00",
};
const refund = {
  id: 5,
  kind: "REFUND",
  amount: 200,
  account_change: 200,
  counterparty: "商店",
  occurred_at: "2026-10-08 12:00:00",
};
const valuation = {
  id: 6,
  kind: "INCOME",
  source: "证券余额更新",
  account_change: 100,
  occurred_at: "2026-10-07 12:00:00",
};
const party = {
  key: "shop",
  counterparty: "商店",
  transactions: [split, refund],
};
const account = {
  id: 5,
  analysis_mode: "both",
  ending_balance: 9000,
  categories: [
    {
      id: 201,
      kind: "EXPENSE",
      name: "餐饮",
      amount: 600,
      transaction_ids: [4],
    },
  ],
  counterparties: { parties: [party] },
  transactions: [...transactions, split, refund, valuation],
};
const accountBefore = JSON.stringify(account);
assert.deepEqual(
  SingleAccountDrilldown.rows(account, {
    category: { id: 201, kind: "EXPENSE", name: "餐饮" },
  }).map((row) => row.id),
  [4],
);
assert.equal(
  SingleAccountDrilldown.rows(account, {
    category: { id: 201, kind: "EXPENSE" },
  })[0].account_change,
  -1000,
  "Detail amounts remain whole-account movements, not category shares",
);
assert.deepEqual(
  SingleAccountDrilldown.rows(account, { flow: "expense" }).map(
    (row) => row.id,
  ),
  [4, 5],
);
assert.deepEqual(
  SingleAccountDrilldown.rows(account, {
    party: { key: "shop" },
    day: "2026-10-08",
  }).map((row) => row.id),
  [5],
);
assert.deepEqual(PartyMovement.summary([split, refund]), {
  incoming: 200,
  outgoing: 1000,
  net: -800,
  count: 2,
});
assert.equal(PartyMovement.daily([split, refund]).length, 2);
assert.equal(JSON.stringify(account), accountBefore);
assert.deepEqual(
  SingleAccountDrilldown.sanitize(
    { ...account, analysis_mode: "counterparties" },
    { flow: "payments", category: { id: 201 }, party: { key: "shop" } },
  ),
  { party: { key: "shop" } },
);
const single = instance(
  SingleAccountWorkspace,
  { refreshKey: "test", onConfigure() {}, onDetail() {} },
  { loading: false, selected: "5" },
);
single.load = async () => {};
single.selectDetails({ flow: "expense" });
assert.equal(single.state.analysisTab, "cashflow");
single.selectDetails({ party: { key: "shop", name: "商店" } });
single.selectDetails({ day: "2026-10-07" });
assert.deepEqual(Object.keys(single.state.drilldowns).sort(), ["balance", "cashflow", "parties"]);
single.selectAccount(6);
assert.deepEqual(single.state.drilldowns, {});
single.selectDetails({ flow: "expense" });
single.selectDetails({ party: { key: "shop", name: "商店" } });
single.selectDetails({ day: "2026-10-07" });
single.filter({ start: "2026-10-08" });
assert.deepEqual(single.state.drilldowns, {}, "Changing the report date clears every tab's local selection");
const counterparty = instance(
  CounterpartyWorkspace,
  { accounts: [], refreshKey: "test", onDetail() {}, onValuation() {} },
  { loading: false },
);
counterparty.openParty(party, "2026-10-08");
assert.equal(counterparty.state.selected.key, "shop");
assert.equal(counterparty.state.selectedDay, "2026-10-08");
counterparty.load = async () => {};
counterparty.filter({ end: "2026-10-18" });
assert.equal(counterparty.state.selected, undefined);
console.log(
  "Account categories, refunds, mode constraints and party-day movement scopes passed.",
);

const owned = [
  { id: 10, name: "直管", group_id: 1 },
  { id: 11, name: "甲证券", group_id: 2 },
  { id: 12, name: "乙证券", group_id: 3 },
  { id: 13, name: "长期证券", group_id: 4 },
];
const investmentRows = owned.map((row, index) => ({
  ...row,
  ending: [0, 1000, 2000, 3000][index],
  profit: [0, 200, -100, 50][index],
  capital_net: 0,
}));
const investmentReport = {
  start: "2026-10-06",
  end: "2026-10-18",
  account_id: null,
  accounts: investmentRows,
};
const investment = instance(
  InvestmentWorkspace,
  {
    accounts: owned,
    groups,
    refreshKey: "test",
    onDetail() {},
    onUpdate() {},
    onAccounts() {},
  },
  {
    loading: false,
    report: investmentReport,
    filters: { start: "2026-10-06", end: "2026-10-18" },
  },
);
assert.deepEqual(
  investment
    .drilldownAccounts({ namespace: "investment:gain", level: "root" })
    .map((row) => row.id),
  [11, 13],
);
assert.deepEqual(
  investment
    .drilldownAccounts({ namespace: "investment:loss", level: "root" })
    .map((row) => row.id),
  [12],
);
assert.deepEqual(
  investment
    .drilldownAccounts({ namespace: "investment:asset", group_id: 2 })
    .map((row) => row.id),
  [11],
);
const investmentGraph = new InvestmentDistribution(
  investmentReport,
  owned,
  groups,
).returns;
for (const link of investmentGraph.links)
  assert.deepEqual(
    investmentGraph.selection({ dataType: "edge", data: link }),
    investmentGraph.selectionFor(link.target),
  );
investment.openPeriod("2026-10", "capital");
assert.equal(investment.state.drillPeriod.end, "2026-10-18");
assert.equal(investment.state.filters.start, "2026-10-06");
investment.closeDrilldown();
const snapshot = {
  as_of: "2026-10-18",
  groups,
  accounts: [
    {
      id: 11,
      role: "ASSET",
      kind: "证券",
      group_id: 2,
      amount: 300,
      composite: true,
      asset_amount: 300,
      liability_amount: 50,
    },
    { id: 13, role: "ASSET", kind: "证券", group_id: 4, amount: 500 },
    { id: 14, role: "ASSET", kind: "银行", group_id: 2, amount: -100 },
  ],
};
const snapshotBefore = JSON.stringify(snapshot);
const balance = instance(
  BalanceSheetWorkspace,
  { groups, refreshKey: "test", onAccounts() {} },
  { snapshot, loading: false },
);
assert.deepEqual(
  balance
    .drilldownRows({ namespace: "ASSET", group_id: 2, direct_group: true })
    .map((row) => row.amount),
  [300, -100],
);
assert.deepEqual(
  balance
    .drilldownRows({ namespace: "ASSET", group_id: 2 })
    .map((row) => row.amount),
  [300, 500, -100],
);
assert.deepEqual(
  balance
    .drilldownRows({ namespace: "LIABILITY", account_id: 11 })
    .map((row) => row.amount),
  [50],
);
assert.equal(JSON.stringify(snapshot), snapshotBefore);

const tagSnapshot = {
  ...snapshot,
  accounts: snapshot.accounts.map((row) =>
    row.id === 11 ? { ...row, kind: "银行" } : row,
  ),
};
balance.state.snapshot = tagSnapshot;
const tagGraph = new BalanceSheetDistribution(
  new BalanceSheetStructure(tagSnapshot),
  "ASSET",
);
const bankTag = tagGraph.selectionFor("ASSET:group:2:tag:bank");
assert.deepEqual(
  balance.drilldownRows(bankTag).map((row) => row.amount),
  [300, -100],
);
assert.deepEqual(
  balance.drilldownRows({
    namespace: "ASSET",
    group_id: 2,
    direct_group: true,
    account_tag: "investment",
  }),
  [],
  "Tag details stay inside the direct group, excluding descendants and other tags",
);
balance.select(tagGraph.selectionFor("ASSET:account:11"));
assert.deepEqual(
  balance.drilldownRows().map((row) => row.id),
  [11],
);
balance.back();
assert.equal(balance.state.drilldown.level, "tag");
assert.equal(balance.state.drilldown.account_tag, "bank");
assert.deepEqual(
  balance.drilldownRows().map((row) => row.amount),
  [300, -100],
);
balance.back();
assert.equal(balance.state.drilldown.level, "group");
assert.equal(balance.state.drilldown.account_tag, undefined);
balance.back();
assert.equal(balance.state.drilldown.level, "root");
balance.back();
assert.equal(balance.state.drilldown, undefined);
balance.select(bankTag);
balance.state.snapshot = {
  ...tagSnapshot,
  accounts: tagSnapshot.accounts.map((row) =>
    row.id === 11 ? { ...row, asset_amount: 600 } : row,
  ),
};
assert.deepEqual(
  balance.drilldownRows().map((row) => row.amount),
  [600, -100],
  "Tag selection is recalculated from the latest dated snapshot",
);
balance.state.snapshot = {
  ...tagSnapshot,
  accounts: tagSnapshot.accounts.map((row) =>
    row.id === 13 ? { ...row, kind: "银行" } : row,
  ),
};
balance.select({
  ...tagGraph.selectionFor("ASSET:account:11"),
  direct_group: undefined,
});
balance.back();
assert.equal(balance.state.drilldown.direct_group, true);
assert.deepEqual(
  balance.drilldownRows().map((row) => row.id),
  [11, 14],
  "Returning from an account must not include a child group's same-tag accounts",
);
balance.select(tagGraph.selectionFor("ASSET:account:11"));
balance.state.snapshot = snapshot;
assert.deepEqual(
  balance.drilldownRows().map((row) => row.id),
  [11],
  "Editing a selected account's type must not hide that exact account",
);
balance.back();
assert.equal(balance.state.drilldown.account_tag, "investment");
assert.deepEqual(
  balance.drilldownRows().map((row) => row.id),
  [11],
);
balance.state.snapshot = snapshot;
balance.select({ namespace: "LIABILITY", account_id: 11, group_id: 2 });
balance.back();
assert.equal(balance.state.drilldown.level, "group");
assert.equal(balance.state.drilldown.account_tag, undefined);
assert.equal(JSON.stringify(snapshot), snapshotBefore);

async function verifyLatestInvestmentDetail() {
  const pending = [];
  investment.api.request = () =>
    new Promise((resolve) => pending.push(resolve));
  investment.openDrilldown({
    namespace: "investment:asset",
    level: "account",
    account_id: 11,
  });
  investment.openDrilldown({
    namespace: "investment:asset",
    level: "account",
    account_id: 12,
  });
  pending[0]({ account_id: 11 });
  await Promise.resolve();
  assert.equal(
    investment.state.drillReport,
    undefined,
    "A late old account must not replace the latest selection",
  );
  pending[1]({ account_id: 12 });
  await Promise.resolve();
  assert.equal(investment.state.drillReport.account_id, 12);
  investment.openDrilldown({
    namespace: "investment:asset",
    level: "account",
    account_id: 11,
  });
  investment.closeDrilldown();
  pending[2]({ account_id: 11 });
  await Promise.resolve();
  assert.equal(
    investment.state.drillReport,
    undefined,
    "Closing details invalidates pending responses",
  );
}
verifyLatestInvestmentDetail()
  .then(() => {
    console.log(
      "Investment signed scopes, balance projections and detail request races passed.",
    );
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });

if (process.argv[2]) {
  const bundle = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  const out = path.dirname(process.argv[2]);
  const props = {
    accounts: bundle.accounts,
    groups: bundle.groups,
    categories: bundle.categories,
    tags: [],
    refreshKey: "ssr",
    onDetail() {},
    onConfigure() {},
    onUpdate() {},
    onAccounts() {},
    onValuation() {},
  };
  const pages = [
    [
      "income",
      instance(IncomeWorkspace, props, {
        report: bundle.income,
        loading: false,
      }),
    ],
    [
      "financial",
      instance(FinancialAnalysisWorkspace, props, {
        report: bundle.financial,
        loading: false,
      }),
    ],
    [
      "investment",
      instance(InvestmentWorkspace, props, {
        report: bundle.investments,
        loading: false,
      }),
    ],
    [
      "balance",
      instance(BalanceSheetWorkspace, props, {
        snapshot: bundle.balanceSheet,
        loading: false,
      }),
    ],
    [
      "single",
      instance(SingleAccountWorkspace, props, {
        report: bundle.singleAccounts,
        selected: String(bundle.singleAccounts.accounts[0]?.id),
        loading: false,
      }),
    ],
  ];
  const partyAccount = bundle.singleAccounts.accounts.find(
    (row) => row.counterparties,
  );
  if (partyAccount)
    pages.push([
      "counterparty",
      instance(CounterpartyWorkspace, props, {
        report: partyAccount.counterparties,
        accountId: partyAccount.id,
        filters: {
          start: bundle.singleAccounts.start,
          end: bundle.singleAccounts.end,
        },
        reportScope: {
          accountId: partyAccount.id,
          filters: {
            start: bundle.singleAccounts.start,
            end: bundle.singleAccounts.end,
          },
        },
        loading: false,
      }),
    ]);
  for (const [name, page] of pages) {
    const html = renderToStaticMarkup(page.render());
    assert.ok(html.length > 300);
    assert.ok(!html.includes("NaN"), name + " must render finite money");
    fs.writeFileSync(path.join(out, name + "-linked.html"), html);
  }
  const wealthPage = pages[2][1];
  wealthPage.state.drilldown = {
    namespace: "investment:gain",
    level: "root",
    label: "盈利账户",
  };
  const wealthHtml = renderToStaticMarkup(wealthPage.renderDrilldown());
  assert.ok(wealthHtml.includes("局部明细") && wealthHtml.includes("盈利"));
  fs.writeFileSync(path.join(out, "investment-drawer.html"), wealthHtml);
  const sheetPage = pages[3][1];
  sheetPage.state.drilldown = {
    namespace: "ASSET",
    level: "root",
    label: "全部资产",
  };
  const sheetHtml = renderToStaticMarkup(sheetPage.renderDrilldown());
  assert.ok(sheetHtml.includes("资产局部明细"));
  fs.writeFileSync(path.join(out, "balance-drawer.html"), sheetHtml);
  console.log(
    "All report workspaces and local detail bodies rendered with private fixtures.",
  );
}
