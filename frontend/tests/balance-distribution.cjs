const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const echarts = require("echarts");
const { loadTs } = require("./source-loader.cjs");
const src = path.resolve(__dirname, "../src");
const {
  BalanceSheetStructure,
  BalanceSheetDistribution,
  BalanceSheetAccountTag,
} = loadTs(path.join(src, "BalanceSheetStructure.ts"));
const { distributionOption } = loadTs(path.join(src, "BalanceSheetFlow.tsx"));
const { InvestmentDistribution } = loadTs(
  path.join(src, "InvestmentDistribution.ts"),
);
const { ExpenseDistribution, SpendingScenario } = loadTs(
  path.join(src, "ExpenseDistribution.ts"),
);
const groups = [
  { id: 1, name: "家庭", parent_id: null },
  { id: 2, name: "成员甲", parent_id: 1 },
  { id: 3, name: "成员乙", parent_id: 1 },
  { id: 4, name: "长期账户", parent_id: 2 },
];
const account = (id, name, group_id, amount, extra = {}) => ({
  id,
  name,
  group_id,
  amount,
  role: "ASSET",
  ...extra,
});
const snapshot = {
  groups,
  accounts: [
    account(11, "重名账户", 2, 70000),
    account(12, "重名账户", 3, 30000),
    account(13, "公共资产", 1, 10000),
    account(14, "长期资产", 4, 20000),
    account(15, "未分组资产", null, 5000),
    account(16, "零余额", 2, 0),
    account(17, "透支", 3, -2000),
    account(18, "综合银行", 3, 8000, {
      composite: true,
      asset_amount: 10000,
      liability_amount: 2000,
    }),
    account(19, "贷款", 1, 40000, { role: "LIABILITY" }),
    account(20, "信用卡预付款", 3, -500, { role: "LIABILITY" }),
  ],
};
function checkConservation(data) {
  const lastDepth = Math.max(...data.nodes.map((n) => n.depth));
  const names = data.nodes.map((n) => n.name);
  assert.equal(new Set(names).size, names.length);
  for (const link of data.links) {
    assert.ok(link.value > 0);
    const source = data.nodes.find((n) => n.name === link.source);
    const target = data.nodes.find((n) => n.name === link.target);
    assert.ok(source && target);
    assert.equal(target.depth - source.depth, 1);
  }
  for (const node of data.nodes) {
    const incoming = data.links
      .filter((l) => l.target === node.name)
      .reduce((s, l) => s + l.value, 0);
    const outgoing = data.links
      .filter((l) => l.source === node.name)
      .reduce((s, l) => s + l.value, 0);
    if (node.depth > 0) assert.equal(incoming, node.value);
    if (node.depth < lastDepth) assert.equal(outgoing, node.value);
  }
  assert.equal(
    data.links
      .filter((l) => l.source.endsWith(":total"))
      .reduce((s, l) => s + l.value, 0),
    data.positiveTotal,
  );
}
const structure = new BalanceSheetStructure(snapshot);
const assets = new BalanceSheetDistribution(structure, "ASSET");
checkConservation(assets);
assert.equal(assets.positiveTotal, 145000);
assert.equal(assets.total, 143000);
assert.equal(assets.zeroCount, 1);
assert.equal(assets.adjustments[0].amount, -2000);
assert.equal(
  assets.nodes.filter((n) => n.depth === 3 && n.displayName === "重名账户")
    .length,
  2,
);
assert.equal(assets.nodes.find((n) => n.name === "ASSET:group:1").value, 10000);
assert.equal(assets.nodes.find((n) => n.name === "ASSET:group:2").value, 70000);
assert.equal(
  assets.nodes.find((n) => n.name === "ASSET:group:4").path,
  "家庭 / 成员甲 / 长期账户",
);
assert.equal(
  structure.tree("ASSET").reduce((s, r) => s + r.amount, 0),
  assets.total,
);
const liabilities = new BalanceSheetDistribution(structure, "LIABILITY");
checkConservation(liabilities);
assert.equal(liabilities.total, 41500);
assert.equal(liabilities.positiveTotal, 42000);
assert.equal(
  liabilities.nodes.find((n) => n.name === "LIABILITY:account:18").value,
  2000,
);
assert.equal(
  structure.tree("LIABILITY").reduce((s, r) => s + r.amount, 0),
  liabilities.total,
);
const empty = new BalanceSheetDistribution(
  new BalanceSheetStructure({ groups: [], accounts: [] }),
  "ASSET",
);
assert.equal(empty.nodes.length, 0);
assert.equal(empty.links.length, 0);
const negative = new BalanceSheetDistribution(
  new BalanceSheetStructure({
    groups: [],
    accounts: [account(1, "负数", null, -100)],
  }),
  "ASSET",
);
assert.equal(negative.total, -100);
assert.equal(negative.nodes.length, 0);
// A filtered response keeps direct children even when its parent is absent.
const filtered = new BalanceSheetStructure({
  groups: groups.filter((g) => [2, 4].includes(g.id)),
  accounts: snapshot.accounts.filter((a) => [2, 4].includes(a.group_id)),
});
const scoped = new BalanceSheetDistribution(filtered, "ASSET");
checkConservation(scoped);
assert.equal(scoped.total, 90000);
assert.equal(filtered.tree("ASSET")[0].amount, scoped.total);
// Display tags are exclusive classifications of canonical account types. Owner
// tags and the kinds of already-merged sources must not duplicate any balance.
const tagSnapshot = {
  groups,
  accounts: [
    account(31, "证券甲", 2, 80000, { kind: "证券", tags: [] }),
    account(32, "基金甲", 2, 20000, { kind: "理财", tags: ["成员甲", "备用"] }),
    account(33, "证券乙", 3, 10000, { kind: "证券" }),
    account(34, "综合银行", 2, 45000, {
      kind: "招商银行",
      tags: ["成员甲"],
      composite: true,
      asset_amount: 50000,
      liability_amount: 5000,
      merged_source_count: 2,
    }),
    account(35, "汇丰", 3, 7000, { kind: "银行卡" }),
    account(36, "支付宝含余额宝", 2, 6000, {
      kind: "支付宝",
      merged_source_count: 1,
    }),
    account(37, "微信含零钱通", 2, 5000, {
      kind: "微信",
      merged_source_count: 1,
    }),
    account(38, "应收款", null, 4000, { kind: "债权" }),
    account(39, "现金", null, 3000, { kind: "现金" }),
    account(40, "新类型", null, 2000, { kind: "自定义类型" }),
    account(41, "未指定类型", 99, 1000),
    account(42, "负余额", 2, -1000, { kind: "理财" }),
    account(43, "零余额", 2, 0, { kind: "理财" }),
  ],
};
const tagBefore = JSON.stringify(tagSnapshot);
const taggedAssets = new BalanceSheetDistribution(
  new BalanceSheetStructure(tagSnapshot),
  "ASSET",
);
checkConservation(taggedAssets);
assert.deepEqual(
  [...new Set(taggedAssets.nodes.map((n) => n.depth))].sort(),
  [0, 1, 2, 3],
);
assert.equal(
  taggedAssets.nodes.find((n) => n.name === "ASSET:group:2:tag:investment")
    .value,
  100000,
);
assert.equal(
  taggedAssets.nodes.find((n) => n.name === "ASSET:group:3:tag:investment")
    .value,
  10000,
);
assert.equal(
  taggedAssets.nodes.find((n) => n.name === "ASSET:group:2:tag:bank").value,
  50000,
);
assert.equal(
  taggedAssets.nodes.find((n) => n.name === "ASSET:group:2:tag:payment").value,
  11000,
);
const leaves = taggedAssets.nodes.filter((n) => n.depth === 3);
assert.equal(new Set(leaves.map((n) => n.accountId)).size, 11);
assert.equal(
  leaves.reduce((sum, n) => sum + n.value, 0),
  taggedAssets.positiveTotal,
);
assert.equal(taggedAssets.total, taggedAssets.positiveTotal - 1000);
assert.equal(taggedAssets.zeroCount, 1);
assert.deepEqual(
  [
    "证券",
    "理财",
    "建设银行",
    "银行",
    "银行卡",
    "信用卡",
    "支付宝",
    "微信",
    "零钱通",
    "小荷包",
    "支付宝小荷包",
    "债权",
    "应收款",
    "现金",
    "",
    "新类型",
  ].map((kind) => BalanceSheetAccountTag.forAccount({ kind }).key),
  [
    "investment",
    "investment",
    "bank",
    "bank",
    "bank",
    "bank",
    "payment",
    "payment",
    "payment",
    "payment",
    "payment",
    "receivable",
    "receivable",
    "cash",
    "other",
    "other",
  ],
);
const tagNode = taggedAssets.nodes.find(
  (n) => n.name === "ASSET:group:2:tag:investment",
);
const tagSelection = taggedAssets.selection({
  dataType: "node",
  data: tagNode,
});
assert.equal(tagSelection.account_tag, "investment");
assert.equal(tagSelection.group_id, 2);
assert.equal(tagSelection.direct_group, true);
assert.equal(tagSelection.account_id, undefined);
assert.deepEqual(
  taggedAssets.selection({ dataType: "edge", data: { target: tagNode.name } }),
  tagSelection,
);
const leafSelection = taggedAssets.selectionFor("ASSET:account:31");
assert.equal(leafSelection.account_id, 31);
assert.equal(leafSelection.account_tag, "investment");
tagSelection.account_tag = "mutated";
assert.equal(taggedAssets.selectionFor(tagNode.name).account_tag, "investment");
assert.equal(JSON.stringify(tagSnapshot), tagBefore);
assert.equal(Math.max(...liabilities.nodes.map((n) => n.depth)), 2);
// Exercise the real ECharts renderer, not just matching data structures.
function render(data, width, height) {
  const chart = echarts.init(null, null, {
    renderer: "svg",
    ssr: true,
    width,
    height,
  });
  chart.setOption(distributionOption(data));
  const graph = chart.getModel().getSeriesByIndex(0).getGraph();
  for (const depth of new Set(data.nodes.map((node) => node.depth))) {
    const centers = graph.nodes
      .filter((node) => data.nodes[node.dataIndex].depth === depth)
      .map((node) => node.getLayout().y + node.getLayout().dy / 2)
      .sort((a, b) => a - b);
    for (let i = 1; i < centers.length; i++) {
      assert.ok(centers[i] - centers[i - 1] >= 36, "Two-line labels overlap");
    }
  }
  const svg = chart.renderToSVGString();
  assert.ok(svg.includes("<svg") && svg.includes("<path"));
  assert.ok(!svg.includes("NaN") && !svg.includes("Infinity"));
  chart.dispose();
  return svg;
}
render(assets, 1000, assets.height);
render(taggedAssets, 1180, taggedAssets.height);
render(liabilities, 1000, liabilities.height);
const many = new BalanceSheetDistribution(
  new BalanceSheetStructure({
    groups,
    accounts: Array.from({ length: 40 }, (_, i) =>
      account(i + 100, "测试账户" + i, 2, i ? 1 : 1000000),
    ),
  }),
  "ASSET",
);
render(many, 880, many.height);
const portfolioRows = [
  { id: 41, name: "成员甲 · 证券", group_id: 2, ending: 100000, profit: 12500 },
  { id: 42, name: "成员乙 · 证券", group_id: 3, ending: 200000, profit: -4500 },
  { id: 43, name: "成员乙 · 其他证券", group_id: 3, ending: 0, profit: 0 },
];
const portfolio = new InvestmentDistribution(
  { accounts: portfolioRows },
  portfolioRows,
  groups,
);
checkConservation(portfolio.assets);
checkConservation(portfolio.returns);
assert.equal(portfolio.assets.total, 300000);
assert.equal(portfolio.returns.total, 8000);
assert.equal(portfolio.returns.positiveTotal, 17000);
assert.equal(portfolio.returns.nodes.filter((n) => n.depth === 0).length, 2);
assert.equal(
  portfolio.returns.nodes
    .filter((n) => n.depth === 2)
    .reduce((s, n) => s + n.signedValue, 0),
  8000,
);
const lossNode = portfolio.returns.nodes.find(
  (n) => n.depth === 2 && n.signedValue < 0,
);
assert.equal(lossNode.value, 4500);
assert.equal(lossNode.shareLabel, "亏损");
assert.ok(
  distributionOption(portfolio.returns)
    .tooltip.formatter({ dataType: "node", data: lossNode })
    .includes("-45.00"),
);
render(portfolio.assets, 1000, portfolio.assets.height);
render(portfolio.returns, 1000, portfolio.returns.height);
for (const profits of [
  [0, -53600],
  [100, -100],
  [0, 0],
]) {
  const rows = portfolioRows
    .slice(0, 2)
    .map((r, i) => ({ ...r, profit: profits[i] }));
  const graph = new InvestmentDistribution({ accounts: rows }, rows, groups)
    .returns;
  checkConservation(graph);
  assert.equal(
    graph.total,
    profits.reduce((s, v) => s + v, 0),
  );
  if (graph.nodes.length) render(graph, 1000, graph.height);
}
const expenseFixture = {
  group_categories: [
    { group_id: 2, category_id: 1, name: "餐饮", amount: 7500 },
    { group_id: 3, category_id: 1, name: "餐饮", amount: 5000 },
    { group_id: 1, category_id: 2, name: "购物", amount: 6000 },
    { group_id: 2, category_id: -1, name: "退款抵减", amount: -2000 },
    { group_id: null, category_id: 2, name: "购物", amount: 300 },
  ],
  group_category_details: [
    {
      group_id: 2,
      category_id: 11,
      name: "买菜",
      parent_id: 1,
      parent_name: "餐饮",
      amount: 5000,
    },
    {
      group_id: 2,
      category_id: 12,
      name: "日常用餐",
      parent_id: 1,
      parent_name: "餐饮",
      amount: 2000,
    },
    {
      group_id: 2,
      category_id: 1,
      name: "餐饮",
      parent_id: 1,
      parent_name: "餐饮",
      amount: 1000,
    },
    {
      group_id: 2,
      category_id: 13,
      name: "饮品",
      parent_id: 1,
      parent_name: "餐饮",
      amount: -500,
    },
    {
      group_id: 3,
      category_id: 11,
      name: "买菜",
      parent_id: 1,
      parent_name: "餐饮",
      amount: 3000,
    },
    {
      group_id: 3,
      category_id: 12,
      name: "日常用餐",
      parent_id: 1,
      parent_name: "餐饮",
      amount: 2000,
    },
    {
      group_id: 1,
      category_id: 21,
      name: "日用品",
      parent_id: 2,
      parent_name: "购物",
      amount: 6000,
    },
    {
      group_id: 2,
      category_id: -1,
      name: "未分配退款",
      parent_id: -1,
      parent_name: "退款抵减",
      amount: -2000,
    },
    {
      group_id: null,
      category_id: 22,
      name: "衣物",
      parent_id: 2,
      parent_name: "购物",
      amount: 300,
    },
  ],
};
const expenseGraph = new ExpenseDistribution(expenseFixture, groups);
assert.equal(expenseGraph.nodes.filter((n) => n.depth === 1).length, 4);
const foodLeaves = expenseGraph.nodes.filter(
  (n) => n.depth === 2 && n.displayName === "餐饮",
);
assert.equal(foodLeaves.length, 2);
assert.notEqual(foodLeaves[0].name, foodLeaves[1].name);
assert.deepEqual(
  new Set(foodLeaves.map((n) => expenseGraph.selectionFor(n.name).group_id)),
  new Set([2, 3]),
);
const ungroupedExpense = expenseGraph.nodes.find(
  (n) => n.depth === 1 && n.displayName === "未分组",
);
assert.equal(expenseGraph.selectionFor(ungroupedExpense.name).group_id, 0);
checkConservation(expenseGraph);
assert.equal(expenseGraph.total, 16800);
assert.equal(expenseGraph.positiveTotal, 19300);
assert.equal(
  expenseGraph.adjustments.reduce((sum, row) => sum + row.amount, 0),
  -2500,
);
assert.equal(expenseGraph.nodes.filter((n) => n.depth === 3).length, 7);
const rootPatch = {
  group_id: undefined,
  direct_group: undefined,
  category_id: undefined,
  exact_category: undefined,
};
const rootExpense = expenseGraph.nodes.find((n) => n.depth === 0);
assert.deepEqual(expenseGraph.selectionFor(rootExpense.name), rootPatch);
assert.deepEqual(expenseGraph.selectionFor(ungroupedExpense.name), {
  ...rootPatch,
  group_id: 0,
  direct_group: true,
});
const parentExpense = foodLeaves.find(
  (node) => expenseGraph.selectionFor(node.name).group_id === 2,
);
assert.deepEqual(expenseGraph.selectionFor(parentExpense.name), {
  group_id: 2,
  direct_group: true,
  category_id: 1,
  exact_category: undefined,
});
const detailExpense = expenseGraph.nodes.find(
  (node) =>
    node.depth === 3 &&
    node.displayName === "买菜" &&
    expenseGraph.selectionFor(node.name).group_id === 2,
);
assert.deepEqual(
  expenseGraph.selection({ dataType: "node", data: detailExpense }),
  { group_id: 2, direct_group: true, category_id: 11, exact_category: true },
);
const expenseEdge = expenseGraph.links.find(
  (link) => link.target === detailExpense.name,
);
assert.deepEqual(
  expenseGraph.selection({ dataType: "edge", data: expenseEdge }),
  expenseGraph.selectionFor(detailExpense.name),
);
const parentDirect = expenseGraph.nodes.find(
  (node) => node.depth === 3 && node.displayName === "未细分",
);
assert.deepEqual(expenseGraph.selectionFor(parentDirect.name), {
  group_id: 2,
  direct_group: true,
  category_id: 1,
  exact_category: true,
});
assert.equal(
  expenseGraph.selection({ dataType: "node", data: { name: "invalid" } }),
  undefined,
);
render(expenseGraph, 1180, expenseGraph.height);
const { ExpenseWorkspace: ExpenseFlowWorkspace } = loadTs(
  path.join(src, "ExpenseWorkspace.tsx"),
);
const { DistributionDiagram: FlowDiagram } = loadTs(
  path.join(src, "DistributionDiagram.tsx"),
);
const flowWorkspace = new ExpenseFlowWorkspace({
  groups,
  accounts: [],
  categories: [],
  refreshKey: "flow",
  onDetail() {},
});
const flowQueries = [];
flowWorkspace.state = {
  ...flowWorkspace.state,
  filters: { start: "2026-10-01", end: "2026-10-18", account_id: 5 },
};
flowWorkspace.setState = (patch, done) => {
  flowWorkspace.state = { ...flowWorkspace.state, ...patch };
  done?.();
};
flowWorkspace.load = async () => {
  flowQueries.push({ ...flowWorkspace.state.filters });
};
const flowDiagram = new FlowDiagram({
  data: expenseGraph,
  label: "四层开支",
  columns: ["总额", "组", "一级", "二级"],
  onSelect: (patch) => flowWorkspace.filter(patch, "details"),
});
const flowCanvas = flowDiagram.render().props.children;
assert.ok(flowCanvas.props.className.includes("balance-flow-canvas-four"));
assert.equal(flowCanvas.props.children[0].props.children.length, 4);
const clickFlow = flowCanvas.props.children[1].props.onClick;
clickFlow({ dataType: "node", data: detailExpense });
assert.equal(flowWorkspace.state.filters.category_id, 11);
assert.equal(flowWorkspace.state.filters.exact_category, true);
assert.equal(
  flowWorkspace.state.activeTab,
  "details",
  "Flow clicks activate linked transaction details",
);
clickFlow({
  dataType: "edge",
  data: expenseGraph.links.find(
    (link) => link.target === ungroupedExpense.name,
  ),
});
assert.equal(flowWorkspace.state.filters.group_id, 0);
assert.equal(flowWorkspace.state.filters.direct_group, true);
assert.equal(flowWorkspace.state.filters.category_id, undefined);
assert.equal(
  flowWorkspace.state.filters.exact_category,
  undefined,
  "Group clicks clear old leaf restrictions",
);
clickFlow({ dataType: "node", data: parentExpense });
assert.equal(flowWorkspace.state.filters.category_id, 1);
assert.equal(flowWorkspace.state.filters.exact_category, undefined);
flowWorkspace.clearFlow();
assert.equal(flowWorkspace.state.filters.group_id, undefined);
assert.equal(flowWorkspace.state.filters.category_id, undefined);
clickFlow({ dataType: "node", data: detailExpense });
clickFlow({ dataType: "node", data: rootExpense });
assert.deepEqual(flowWorkspace.state.filters, {
  ...rootPatch,
  start: "2026-10-01",
  end: "2026-10-18",
  account_id: 5,
});
assert.equal(flowQueries.length, 6);
let accountClick;
const oldDiagram = new FlowDiagram({
  data: assets,
  label: "旧账户流向",
  onAccount: (id) => {
    accountClick = id;
  },
});
oldDiagram.render().props.children.props.children[1].props.onClick({
  dataType: "node",
  data: assets.nodes.find((node) => node.accountId),
});
assert.equal(
  accountClick,
  assets.nodes.find((node) => node.accountId).accountId,
);
console.log(
  "Four-level expense conservation, node/edge-linked filters and details, reset and legacy chart clicks passed.",
);
assert.deepEqual(
  SpendingScenario.estimate(
    [
      { id: 1, amount: 12500 },
      { id: 2, amount: -2000 },
    ],
    [],
    10,
  ),
  { base: 0, reduction: 0, percent: 10 },
);
assert.deepEqual(
  SpendingScenario.estimate(
    [
      { id: 1, amount: 12500 },
      { id: 2, amount: -2000 },
    ],
    [1, 2],
    10,
  ),
  { base: 12500, reduction: 1250, percent: 10 },
);
if (process.argv[2]) {
  const actual = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  const out = path.dirname(process.argv[2]);
  for (const role of ["ASSET", "LIABILITY"]) {
    const data = new BalanceSheetDistribution(
      new BalanceSheetStructure(actual),
      role,
    );
    checkConservation(data);
    assert.equal(
      data.total,
      role === "ASSET" ? actual.assets : actual.liabilities,
    );
    fs.writeFileSync(
      path.join(out, role.toLowerCase() + ".svg"),
      render(data, 1200, data.height),
    );
    console.log(
      role,
      data.nodes.filter((n) => n.depth === 2).length,
      data.total,
    );
  }
}
if (process.argv[3]) {
  const bundle = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
  const data = new InvestmentDistribution(
    bundle.report,
    bundle.accounts,
    bundle.groups,
  );
  assert.equal(data.assets.total, bundle.report.ending);
  assert.equal(data.returns.total, bundle.report.profit);
  for (const [name, graph] of [
    ["investment-assets", data.assets],
    ["investment-returns", data.returns],
  ]) {
    checkConservation(graph);
    if (graph.nodes.length)
      fs.writeFileSync(
        path.join(path.dirname(process.argv[3]), name + ".svg"),
        render(graph, 1200, graph.height),
      );
  }
}
if (process.argv[4]) {
  const bundle = JSON.parse(fs.readFileSync(process.argv[4], "utf8"));
  const graph = new ExpenseDistribution(bundle.expenses, bundle.groups);
  checkConservation(graph);
  assert.equal(graph.total, bundle.expenses.expense);
  const out = path.dirname(process.argv[4]);
  if (graph.nodes.length)
    fs.writeFileSync(
      path.join(out, "household-expenses.svg"),
      render(graph, 1200, graph.height),
    );
  const React = require("react"),
    server = require("react-dom/server");
  const { OverviewWorkspace } = loadTs(path.join(src, "OverviewWorkspace.tsx"));
  const { ExpenseWorkspace } = loadTs(path.join(src, "ExpenseWorkspace.tsx"));
  const overview = new OverviewWorkspace({
    refreshKey: "test",
    onReport: () => {},
    onAccounts: () => {},
    onPending: () => {},
    onImport: () => {},
    onDetail: () => {},
  });
  overview.state = { data: bundle.overview, loading: false };
  const overviewHtml = server.renderToStaticMarkup(overview.render());
  assert.ok(
    overviewHtml.includes("家庭财务快照") &&
      overviewHtml.includes("本月家庭开支") &&
      overviewHtml.includes("最近账务动态"),
  );
  fs.writeFileSync(path.join(out, "overview-markup.html"), overviewHtml);
  const expense = new ExpenseWorkspace({
    groups: bundle.groups,
    accounts: bundle.accounts,
    categories: bundle.categories,
    refreshKey: "test",
    onDetail: () => {},
  });
  expense.state = {
    ...expense.state,
    report: bundle.expenses,
    filters: { start: bundle.expenses.start, end: bundle.expenses.end },
    loading: false,
  };
  const expenseHtml = server.renderToStaticMarkup(expense.render());
  assert.ok(
    expenseHtml.includes("家庭支出桑基图") &&
      expenseHtml.includes("调整幅度试算"),
  );
  fs.writeFileSync(path.join(out, "expenses-markup.html"), expenseHtml);
  if (bundle.income) {
    const { IncomeDistribution } = loadTs(
      path.join(src, "GroupedCategoryDistribution.ts"),
    );
    const incomeGraph = new IncomeDistribution(bundle.income, bundle.groups);
    checkConservation(incomeGraph);
    assert.equal(incomeGraph.total, bundle.income.income);
    if (incomeGraph.nodes.length)
      fs.writeFileSync(
        path.join(out, "income-flow.svg"),
        render(incomeGraph, 1200, incomeGraph.height),
      );
    const { IncomeWorkspace } = loadTs(path.join(src, "IncomeWorkspace.tsx"));
    const income = new IncomeWorkspace({
      accounts: bundle.accounts,
      groups: bundle.groups,
      categories: bundle.categories,
      refreshKey: "test",
      onDetail: () => {},
    });
    income.state = {
      ...income.state,
      report: bundle.income,
      loading: false,
      filters: { start: bundle.income.start, end: bundle.income.end },
    };
    const incomeHtml = server.renderToStaticMarkup(income.render());
    assert.ok(
      incomeHtml.includes("收入分析") &&
        incomeHtml.includes("家庭收入桑基图") &&
        incomeHtml.includes("分析配置") &&
        incomeHtml.includes("统一在"),
    );
    fs.writeFileSync(path.join(out, "income-markup.html"), incomeHtml);
    if (bundle.singleAccounts) {
      const { SingleAccountWorkspace } = loadTs(
        path.join(src, "SingleAccountWorkspace.tsx"),
      );
      const workspace = new SingleAccountWorkspace({
        refreshKey: "test",
        onConfigure: () => {},
        onDetail: () => {},
      });
      workspace.state = {
        ...workspace.state,
        report: bundle.singleAccounts,
        loading: false,
        selected: String(bundle.singleAccounts.accounts[0]?.id),
      };
      const html = server.renderToStaticMarkup(workspace.render());
      assert.ok(html.includes("单账户分析") && html.includes("配置分析账户"));
      if (bundle.singleAccounts.accounts.length)
        assert.ok(
          html.includes("证券估值盈亏") && html.includes("期间资金构成"),
        );
      fs.writeFileSync(path.join(out, "single-account-markup.html"), html);
      assert.ok(
        html.includes("single-account-layout") &&
          html.includes("搜索全部分析账户"),
      );
      workspace.state.search = "没有匹配的检索词";
      const searchHtml = server.renderToStaticMarkup(workspace.render());
      assert.ok(
        searchHtml.includes("没有匹配的账户") &&
          searchHtml.includes(bundle.singleAccounts.accounts[0].name),
      );
      workspace.state.search = "";

      const original = bundle.singleAccounts.accounts[0];
      for (const mode of ["cashflow", "counterparties", "both"]) {
        const account = {
          ...original,
          analysis_mode: mode,
          counterparties: mode === "cashflow" ? null : original.counterparties,
        };
        workspace.state.analysisTab =
          mode === "counterparties" ? "parties" : "cashflow";
        const modeHtml = server.renderToStaticMarkup(
          workspace.renderAccount(account),
        );
        assert.equal(
          modeHtml.includes("期间资金构成"),
          mode !== "counterparties",
        );
        assert.equal(
          modeHtml.includes("交易方往来"),
          mode === "counterparties",
        );
        if (mode === "both") {
          workspace.state.analysisTab = "parties";
          assert.ok(
            server
              .renderToStaticMarkup(workspace.renderAccount(account))
              .includes("交易方往来"),
          );
        }
        workspace.state.analysisTab = "balance";
        assert.ok(
          server
            .renderToStaticMarkup(workspace.renderAccount(account))
            .includes("账户余额趋势"),
        );
        workspace.state.analysisTab = "transactions";
        assert.ok(
          server
            .renderToStaticMarkup(workspace.renderAccount(account))
            .includes("账户流水与交易"),
        );
      }
    }
  }
}
console.log(
  "Balance distribution conservation, grouping, signed balances, filters and SVG rendering passed.",
);

const { Navigation } = loadTs(path.join(src, "Navigation.ts"));
assert.equal(Navigation.sections.length, 5);
assert.equal(
  Navigation.sections.find((s) => s.key === "accounts").page,
  "accounts",
);
assert.equal(
  Navigation.sections.find((s) => s.key === "management").label,
  "设置",
);
assert.equal(Navigation.parent("accounts"), undefined);
assert.equal(Navigation.sections[1].key, "reports");
assert.equal(new Set(Navigation.targets().map((t) => t.key)).size, 18);
assert.deepEqual(
  Navigation.sections
    .find((section) => section.key === "reports")
    .children.map((target) => [target.reportTab, target.label]),
  [
    ["balance-sheet", "资产负债表"],
    ["analysis", "收支分析"],
    ["income", "收入分析"],
    ["expenses", "支出分析"],
    ["single-accounts", "单账户分析"],
    ["investments", "理财分析"],
    ["counterparties", "交易方分析"],
    ["fund-flow", "资金流转"],
    ["details", "统计明细"],
  ],
);
for (const target of Navigation.targets()) {
  assert.equal(
    Navigation.target(target.page, target.reportTab || "expenses").key,
    target.key,
  );
  if (!["overview", "accounts"].includes(target.page))
    assert.ok(Navigation.parent(target.key));
}
assert.deepEqual(Navigation.openKeys(["reports", "ledger"]), ["reports", "ledger"]);
assert.deepEqual(Navigation.openKeys([]), []);
const { SidebarNavigation } = loadTs(path.join(src, "SidebarNavigation.tsx"));
const onNavigate = () => {};
const sidebar = new SidebarNavigation({
  page: "reports",
  reportTab: "expenses",
  onNavigate,
});
assert.deepEqual(sidebar.state.openKeys, ["reports"]);
sidebar.setState = (patch) => {
  sidebar.state = { ...sidebar.state, ...patch };
};
const previous = sidebar.props;
sidebar.props = { page: "accounts", reportTab: "expenses", onNavigate };
sidebar.componentDidUpdate(previous);
assert.deepEqual(sidebar.state.openKeys, ["reports"]);
sidebar.setState({ openKeys: [] });
sidebar.componentDidUpdate(sidebar.props);
assert.deepEqual(sidebar.state.openKeys, []); // User collapse survives unrelated refresh.
const menu = sidebar.render().props.children;
menu.props.onOpenChange(["management", "reports"]);
assert.deepEqual(sidebar.state.openKeys, ["management", "reports"]);
let navigated;
sidebar.props = {
  ...sidebar.props,
  onNavigate: (...args) => {
    navigated = args;
  },
};
sidebar.render().props.children.props.onClick({ key: "report:investments" });
assert.deepEqual(navigated, ["reports", "investments"]);
sidebar.render().props.children.props.onClick({ key: "report:fund-flow" });
assert.deepEqual(navigated, ["reports", "fund-flow"]);
console.log(
  "Two-level navigation routes, expanded reports and programmatic selection passed.",
);

const { AnalysisAccountSelection } = loadTs(
  path.join(src, "AnalysisAccountScope.tsx"),
);
const scopeAccounts = [
  { id: 1, name: "银行", role: "ASSET", kind: "银行卡" },
  { id: 2, name: "已合并基金", role: "ASSET", kind: "理财", merged_into_id: 1 },
  { id: 3, name: "证券", role: "ASSET", kind: "证券" },
  { id: 4, name: "历史理财", role: "ASSET", kind: "理财", active: false },
  { id: 5, name: "信用卡", role: "LIABILITY", kind: "信用卡" },
  { id: 6, name: "消费", role: "SYSTEM", kind: "系统" },
];
const selectionPolicy = new AnalysisAccountSelection(scopeAccounts);
assert.deepEqual(selectionPolicy.defaults(), [3, 4]);
assert.deepEqual(selectionPolicy.resolve([2, 1, 3]), [1, 3]);
assert.equal(selectionPolicy.query([]), "[]");
assert.equal(selectionPolicy.query(), "[3,4]");
assert.equal(selectionPolicy.choices().length, 4);
async function verifyAccountExclusionRequests() {
  const { IncomeWorkspace } = loadTs(path.join(src, "IncomeWorkspace.tsx"));
  const { ExpenseWorkspace } = loadTs(path.join(src, "ExpenseWorkspace.tsx"));
  for (const Workspace of [IncomeWorkspace, ExpenseWorkspace]) {
    const workspace = new Workspace({
      accounts: scopeAccounts,
      groups: [],
      categories: [],
      refreshKey: "test",
      onDetail: () => {},
    });
    workspace.setState = (patch, done) => {
      workspace.state = { ...workspace.state, ...patch };
      done?.();
    };
    let requested;
    workspace.api.request = async (path) => {
      requested = new URL(path, "http://ledger.invalid");
      return {};
    };
    await workspace.load();
    assert.equal(requested.searchParams.get("excluded_account_ids"), null);
    await workspace.load();
    assert.equal(requested.searchParams.get("excluded_account_ids"), null);
    workspace.state.filters.category_id = 99;
    await workspace.load();
    assert.equal(requested.searchParams.get("excluded_account_ids"), null);
    assert.equal(requested.searchParams.get("category_id"), "99");
    await workspace.load();
    assert.equal(requested.searchParams.get("excluded_account_ids"), null);
  }
  console.log(
    "Income/expense requests defer exclusions to saved settings and preserve report filters.",
  );
}
verifyAccountExclusionRequests().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

async function verifyPersistentAnalysisSettingsUi() {
  const feedback = require("antd").message;
  const originalSuccess = feedback.success;
  feedback.success = () => {};
  const { AnalysisSettings } = loadTs(path.join(src, "AnalysisSettings.tsx"));
  const server = require("react-dom/server");
  let changed = 0;
  const instance = new AnalysisSettings({
    accounts: scopeAccounts,
    onChanged: () => {
      changed++;
    },
    onSingleAccounts: () => {},
  });
  instance.setState = (patch, done) => {
    instance.state = { ...instance.state, ...patch };
    done?.();
  };
  instance.state = {
    busy: false,
    loading: false,
    config: {
      revision: 2,
      exclude_investment_accounts: true,
      income_excluded_account_ids: [1],
      expense_excluded_account_ids: [],
      single_account_ids: [3],
      single_account_modes: { 3: "counterparties" },
      effective_income_excluded_account_ids: [1, 3, 4],
      updated_at: null,
    },
  };
  let saved;
  instance.api.request = async (path, method, payload) => {
    assert.equal(path, "/analysis-settings");
    assert.equal(method, "PUT");
    saved = payload;
    return { ...payload, revision: 3 };
  };
  await instance.save();
  assert.deepEqual(
    Object.keys(saved).sort(),
    [
      "revision",
      "exclude_investment_accounts",
      "exclude_single_accounts",
      "large_income_threshold_minor",
      "large_expense_threshold_minor",
      "income_excluded_account_ids",
      "expense_excluded_account_ids",
      "single_account_ids",
      "single_excluded_account_ids",
      "single_account_modes",
    ].sort(),
  );
  assert.deepEqual(saved.single_account_ids, [3]);
  assert.ok(!Object.hasOwn(saved, "overview_account_ids"));
  assert.deepEqual(saved.single_account_modes, { 3: "counterparties" });
  assert.equal(changed, 1);
  assert.equal(instance.state.config.revision, 3);
  const html = server.renderToStaticMarkup(instance.render());
  assert.ok(
    html.includes("关注账户") &&
      html.includes("收入分析额外屏蔽账户") &&
      html.includes("支出分析额外屏蔽账户"),
  );
  const { SingleAccountWorkspace } = loadTs(
    path.join(src, "SingleAccountWorkspace.tsx"),
  );
  const single = new SingleAccountWorkspace({
    refreshKey: "test",
    onConfigure: () => {},
    onDetail: () => {},
  });
  single.state = { ...single.state, loading: false, report: { accounts: [] } };
  assert.ok(
    server
      .renderToStaticMarkup(single.render())
      .includes("尚未配置关注或屏蔽账户"),
  );
  feedback.success = originalSuccess;
  console.log(
    "Persistent analysis settings payload and configured-account empty state passed.",
  );
}
verifyPersistentAnalysisSettingsUi().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

const {
  Appearance,
  AppearanceProvider,
  AppearanceSettings,
  AppearanceContext,
} = loadTs(path.join(src, "Appearance.tsx"));
const { ChartAppearance } = loadTs(path.join(src, "ChartAppearance.ts"));
const { SingleAccountPresentation } = loadTs(
  path.join(src, "SingleAccountPresentation.ts"),
);
assert.equal(
  SingleAccountPresentation.cashflow({ analysis_mode: "cashflow" }),
  true,
);
assert.equal(
  SingleAccountPresentation.counterparties({ analysis_mode: "cashflow" }),
  false,
);
assert.equal(
  SingleAccountPresentation.cashflow({ analysis_mode: "counterparties" }),
  false,
);
assert.equal(
  SingleAccountPresentation.counterparties({ analysis_mode: "counterparties" }),
  true,
);
assert.equal(SingleAccountPresentation.mode({}), "both");
assert.equal(Appearance.resolve("system", true), "dark");
assert.equal(Appearance.resolve("system", false), "forest");
assert.equal(Appearance.valid("invalid"), false);
const originalStorage = global.localStorage;
const savedAppearance = new Map();
global.localStorage = {
  getItem: (key) => savedAppearance.get(key) || null,
  setItem: (key, value) => savedAppearance.set(key, value),
};
assert.equal(Appearance.read(), "forest");
const provider = new AppearanceProvider({ children: null });
provider.setState = (patch) => {
  provider.state = { ...provider.state, ...patch };
};
provider.setMode("blue");
assert.equal(Appearance.read(), "blue");
provider.setMode("system");
provider.state.systemDark = true;
assert.equal(provider.render().props.value.resolved, "dark");
provider.onMotion({ matches: true });
assert.equal(provider.render().props.value.reducedMotion, true);
assert.equal(provider.render().props.children.props.theme.token.motion, false);
provider.onMotion({ matches: false });
assert.equal(provider.render().props.children.props.theme.token.motion, true);
for (const { value } of Appearance.options) {
  provider.setMode(value);
  assert.equal(Appearance.read(), value);
}
global.localStorage = originalStorage;

function luminance(hex) {
  const rgb = hex
    .slice(1)
    .match(/../g)
    .map((v) => parseInt(v, 16) / 255);
  const [r, g, b] = rgb.map((v) =>
    v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4,
  );
  return r * 0.2126 + g * 0.7152 + b * 0.0722;
}
function contrast(a, b) {
  const [light, dark] = [luminance(a), luminance(b)].sort((a, b) => b - a);
  return (light + 0.05) / (dark + 0.05);
}
const originalDocument = global.document;
const styleVariables = new Map();
global.document = {
  documentElement: {
    dataset: {},
    style: { setProperty: (name, value) => styleVariables.set(name, value) },
  },
};
for (const { value: mode } of Appearance.resolvedOptions()) {
  Appearance.apply(mode);
  assert.equal(global.document.documentElement.dataset.appearance, mode);
  assert.equal(
    global.document.documentElement.style.colorScheme,
    Appearance.isDark(mode) ? "dark" : "light",
  );
  assert.deepEqual(
    Object.fromEntries(styleVariables),
    Appearance.variables(mode),
  );
  const colors = Appearance.colors(mode);
  for (const foreground of [
    "text",
    "muted",
    "positive",
    "negative",
    "warning",
    "expense",
  ])
    assert.ok(
      contrast(colors[foreground], colors.surface) >= 4.5,
      mode + ": " + foreground,
    );
  assert.ok(
    contrast(colors.onPrimary, colors.primary) >= 4.5,
    mode + ": primary button",
  );
  for (const background of [colors.hero, colors.heroEnd])
    assert.ok(
      contrast(colors.heroMuted, background) >= 4.5,
      mode + ": hero caption",
    );
}
global.document = originalDocument;
const sourceOption = distributionOption(expenseGraph);
const originalLabel = sourceOption.series[0].label.color;
for (const { value: mode } of Appearance.resolvedOptions()) {
  const option = ChartAppearance.option(sourceOption, mode);
  assert.equal(option.series[0].label.color, Appearance.colors(mode).text);
  assert.equal(option.tooltip.formatter, sourceOption.tooltip.formatter);
  assert.equal(option.series[0].data[0].value, expenseGraph.nodes[0].value);
  assert.equal(sourceOption.series[0].label.color, originalLabel);
  const reduced = ChartAppearance.option(sourceOption, mode, true);
  assert.equal(reduced.animation, false);
  assert.equal(reduced.animationDuration, 0);
  assert.equal(reduced.tooltip.transitionDuration, 0);
  for (const series of reduced.series) {
    assert.equal(series.animation, false);
    assert.equal(series.animationDurationUpdate, 0);
    assert.equal(series.stateAnimation.duration, 0);
  }
  const chart = echarts.init(
    null,
    Appearance.isDark(mode) ? "dark" : undefined,
    {
      renderer: "svg",
      ssr: true,
      width: 1200,
      height: expenseGraph.height,
    },
  );
  chart.setOption({
    ...option,
    backgroundColor: Appearance.colors(mode).surface,
  });
  const svg = chart.renderToSVGString();
  assert.ok(!svg.includes("NaN") && !svg.includes("Infinity"));
  if (process.argv[4])
    fs.writeFileSync(
      path.join(path.dirname(process.argv[4]), "theme-" + mode + ".svg"),
      svg,
    );
  chart.dispose();
}
const formatValue = ({ value }) => "¥ " + value;
const incomeLine = {
  tooltip: { formatter: formatValue },
  xAxis: { type: "category", data: ["10-01", "10-02"] },
  yAxis: { type: "value" },
  series: [
    {
      type: "line",
      name: "收入",
      itemStyle: { color: "#326b53" },
      data: [1200, 800],
    },
  ],
};
const coordinatedLine = ChartAppearance.option(incomeLine, "violet");
assert.equal(
  coordinatedLine.series[0].itemStyle.color,
  Appearance.colors("violet").positive,
);
assert.equal(coordinatedLine.tooltip.formatter, formatValue);
assert.deepEqual(coordinatedLine.series[0].data, incomeLine.series[0].data);
assert.equal(incomeLine.series[0].itemStyle.color, "#326b53");
const { Chart: ThemedChart } = loadTs(path.join(src, "Chart.tsx"));
const liveChart = new ThemedChart({ option: incomeLine });
liveChart.chart = echarts.init(null, undefined, {
  renderer: "svg",
  ssr: true,
  width: 600,
  height: 260,
});
const sameCanvas = liveChart.chart;
for (const resolved of ["forest", "violet", "dark", "ocean"]) {
  liveChart.context = { resolved, reducedMotion: false };
  liveChart.draw();
  assert.equal(
    liveChart.chart,
    sameCanvas,
    "Changing themes must preserve the chart instance",
  );
  assert.ok(!sameCanvas.isDisposed());
}
liveChart.context = { resolved: "ocean", reducedMotion: true };
liveChart.draw();
assert.equal(sameCanvas.getOption().animation, false);
assert.equal(sameCanvas.getOption().series[0].animation, false);
liveChart.componentWillUnmount();
assert.equal(sameCanvas.isDisposed(), true);
console.log(
  "Per-account analysis modes, theme persistence/system appearance, and themed chart SVG passed.",
);

const { WorkspaceHeader } = loadTs(path.join(src, "WorkspaceHeader.tsx"));
const { AnalysisFilterPanel, AnalysisFilterSelection } = loadTs(
  path.join(src, "AnalysisFilterPanel.tsx"),
);
const ReactLayout = require("react"),
  serverLayout = require("react-dom/server");
for (const { value: mode } of Appearance.options) {
  const html = serverLayout.renderToStaticMarkup(
    ReactLayout.createElement(
      AppearanceContext.Provider,
      {
        value: {
          mode,
          resolved: Appearance.resolve(mode),
          reducedMotion: false,
          setMode() {},
        },
      },
      ReactLayout.createElement(AppearanceSettings),
    ),
  );
  assert.equal((html.match(/aria-pressed="true"/g) || []).length, 1);
  assert.equal(
    (
      html.match(
        /class="appearance-preview(?: appearance-preview-system)?"/g,
      ) || []
    ).length,
    7,
  );
  for (const { label } of Appearance.options) assert.ok(html.includes(label));
}
const { WorkspaceContent } = loadTs(path.join(src, "WorkspaceContent.tsx"));
function verifyWorkspaceEntrance() {
  const originals = Object.fromEntries(
    ["requestAnimationFrame", "cancelAnimationFrame", "MutationObserver"].map(
      (key) => [key, global[key]],
    ),
  );
  const frames = new Map(),
    observers = [],
    played = [];
  let frameId = 0,
    cancellations = 0;
  global.requestAnimationFrame = (callback) => {
    frames.set(++frameId, callback);
    return frameId;
  };
  global.cancelAnimationFrame = (id) => frames.delete(id);
  global.MutationObserver = class {
    constructor(callback) {
      this.callback = callback;
      observers.push(this);
    }
    observe() {
      this.connected = true;
    }
    disconnect() {
      this.connected = false;
    }
    notify() {
      if (this.connected) this.callback();
    }
  };
  const flush = () => {
    const callbacks = [...frames.values()];
    frames.clear();
    callbacks.forEach((callback) => callback());
  };
  const region = (id, top = 30) => ({
    id,
    closest: () => null,
    contains: () => false,
    getBoundingClientRect: () => ({
      top,
      bottom: top + 100,
      left: 0,
      right: 600,
    }),
    animate(keyframes, options) {
      const animation = { cancel: () => cancellations++, onfinish: null };
      played.push({ id, keyframes, options, animation });
      return animation;
    },
  });
  const regions = [
    region("offscreen", -300),
    ...Array.from({ length: 7 }, (_, i) => region("card-" + i)),
  ];
  const nested = region("nested");
  regions[1].contains = (node) => node === nested;
  regions.splice(2, 0, nested);
  let pending = true;
  const root = {
    ownerDocument: { defaultView: { innerWidth: 1280, innerHeight: 800 } },
    querySelector: () => (pending ? null : regions[1]),
    querySelectorAll: (selector) =>
      selector.startsWith(".ant-card-loading")
        ? pending
          ? [region("loading")]
          : []
        : regions,
  };
  const child = ReactLayout.createElement("input", {
    defaultValue: "保留筛选",
  });
  const surface = new WorkspaceContent({ route: "overview", children: child });
  surface.context = { reducedMotion: false };
  surface.element.current = root;
  try {
    surface.componentDidMount();
    flush();
    assert.equal(
      played.length,
      0,
      "Initial loading placeholders must not consume the entrance",
    );
    assert.equal(observers.at(-1).connected, true);
    pending = false;
    observers.at(-1).notify();
    flush();
    assert.equal(
      played.length,
      6,
      "Real content reveals at most six independent regions",
    );
    assert.equal(
      played[0].id,
      "card-0",
      "Visible cards get priority without scrolling",
    );
    assert.ok(!played.some((entry) => entry.id === "nested"));
    assert.deepEqual(
      played.map((entry) => entry.options.delay),
      [0, 50, 100, 150, 200, 200],
    );
    assert.equal(played[0].options.duration, 380);
    assert.equal(played[0].options.fill, "backwards");
    assert.equal(played[0].keyframes[0].transform, "translateY(12px)");
    assert.equal(played[0].keyframes[1].opacity, 1);
    assert.equal(observers.at(-1).connected, false);
    played.forEach((entry) => entry.animation.onfinish());
    assert.equal(surface.transitions.length, 0);
    surface.componentDidUpdate({ route: "overview", children: child });
    observers.at(-1).notify();
    flush();
    assert.equal(
      played.length,
      6,
      "Same-page filters, paging and data refreshes must not replay motion",
    );
    assert.equal(surface.render().props.children, child);
    assert.equal(
      surface.render().key,
      null,
      "Motion must preserve child component identity",
    );
    surface.props = { route: "report:income", children: child };
    pending = true;
    surface.componentDidUpdate({ route: "overview", children: child });
    const stale = observers.at(-1);
    surface.props = { route: "accounts", children: child };
    surface.componentDidUpdate({ route: "report:income", children: child });
    assert.equal(
      stale.connected,
      false,
      "A quick route change disconnects the previous observer",
    );
    pending = false;
    stale.callback();
    flush();
    assert.equal(played.length, 12, "Only the latest route enters");
    surface.context = { reducedMotion: true };
    surface.componentDidUpdate({ route: "accounts", children: child });
    assert.equal(
      cancellations,
      6,
      "Reduced motion cancels all active region animations",
    );
    surface.context = { reducedMotion: false };
    surface.componentDidUpdate({ route: "accounts", children: child });
    flush();
    assert.equal(
      played.length,
      12,
      "Turning motion back on must not replay the skipped route",
    );
    surface.props = { route: "settings", children: child };
    surface.componentDidUpdate({ route: "accounts", children: child });
    flush();
    surface.componentWillUnmount();
    assert.equal(cancellations, 12);
    assert.equal(frames.size, 0);
    assert.ok(observers.every((observer) => !observer.connected));
    assert.equal(surface.timeout, undefined);
  } finally {
    surface.componentWillUnmount();
    for (const [key, value] of Object.entries(originals)) {
      if (value === undefined) delete global[key];
      else global[key] = value;
    }
  }
}
verifyWorkspaceEntrance();
console.log(
  "Six coordinated palettes, theme previews, caption contrast and state-preserving reduced motion passed.",
);
const heading = new WorkspaceHeader({
  title: "收入分析",
  section: "统计报表",
  actions: ReactLayout.createElement("button", null, "记一笔"),
});
const headingHtml = serverLayout.renderToStaticMarkup(heading.render());
assert.equal((headingHtml.match(/<h1/g) || []).length, 1);
assert.ok(
  headingHtml.includes("当前位置") &&
    headingHtml.includes("统计报表") &&
    headingHtml.includes("记一笔"),
);
const queryFilters = Object.freeze({
  group_id: 0,
  direct_group: true,
  category_id: 11,
  exact_category: true,
});
const summaries = new AnalysisFilterSelection(queryFilters, {
  accounts: [],
  groups: [],
  categories: [
    { id: 1, name: "餐饮", parent_id: null },
    { id: 11, name: "用餐", parent_id: 1 },
  ],
}).items();
assert.ok(summaries.some((s) => s.label === "账户组：未分组"));
assert.ok(summaries.some((s) => s.label === "分类：餐饮 / 用餐"));
let clearPatch;
const filterPanel = new AnalysisFilterPanel({
  id: "test-layout",
  label: "收入分析",
  primary: ReactLayout.createElement("span", null, "日期"),
  advanced: ReactLayout.createElement("span", null, "账户"),
  reset: ReactLayout.createElement("button", null, "重置"),
  summary: summaries,
  onClear: (patch) => {
    clearPatch = patch;
  },
});
filterPanel.setState = (patch) => {
  filterPanel.state = { ...filterPanel.state, ...patch };
};
let filterHtml = serverLayout.renderToStaticMarkup(filterPanel.render());
assert.ok(
  filterHtml.includes('aria-expanded="false"') &&
    filterHtml.includes('hidden=""') &&
    filterHtml.includes("筛选仍生效"),
);
filterPanel.setState({ expanded: true });
filterHtml = serverLayout.renderToStaticMarkup(filterPanel.render());
assert.ok(
  filterHtml.includes('aria-expanded="true"') &&
    !filterHtml.includes('hidden=""'),
);
filterPanel.setState({ expanded: false });
const findElements = (node, predicate) => {
  if (Array.isArray(node))
    return node.flatMap((item) => findElements(item, predicate));
  if (!node || typeof node !== "object") return [];
  return [
    ...(predicate(node) ? [node] : []),
    ...findElements(node.props?.children, predicate),
  ];
};
const closable = findElements(
  filterPanel.render(),
  (node) => node.props?.closable,
);
let prevented = false;
closable[0].props.onClose({
  preventDefault: () => {
    prevented = true;
  },
});
assert.ok(prevented);
assert.deepEqual(clearPatch, { group_id: undefined, direct_group: undefined });
filterPanel.props = { ...filterPanel.props, summary: [] };
assert.equal(filterPanel.state.expanded, false);
assert.equal(queryFilters.category_id, 11);
console.log(
  "Workspace title hierarchy, collapsed filter summaries and selective clearing passed.",
);
