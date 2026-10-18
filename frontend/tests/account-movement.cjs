const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const echarts = require("echarts");
const { loadTs } = require("./source-loader.cjs");
const source = (file) => loadTs(path.resolve(__dirname, "../src", file));
const { AccountMovementDistribution } = source(
  "AccountMovementDistribution.ts",
);
const { distributionOption } = source("DistributionDiagram.tsx");
const { ChartAppearance } = source("ChartAppearance.ts");
const { Appearance } = source("Appearance.tsx");
const groups = [
  { id: 1, name: "家庭", parent_id: null },
  { id: 2, name: "成员", parent_id: 1 },
  { id: 3, name: "成员", parent_id: 1 },
  { id: 4, name: "下级组", parent_id: 2 },
];
const account = (id, group_id, opening_balance, net_change, extra = {}) => ({
  id,
  name: "测试账户 " + id,
  group_id,
  opening_balance,
  net_change,
  ending_balance: opening_balance + net_change,
  inflow: Math.max(0, net_change),
  outflow: Math.max(0, -net_change),
  role: "ASSET",
  kind: "银行卡",
  active: true,
  breakdown: [],
  reconciled: true,
  ...extra,
});
const report = {
  start: "2026-10-01",
  end: "2026-10-18",
  ignored_filters: [],
  accounts: [
    account(1, 2, 1000000, 50000),
    account(2, 3, 500000, -50000),
    account(3, 2, -10000, -20000, { role: "LIABILITY", kind: "信用卡" }),
    account(4, 3, -80000, 20000, { role: "LIABILITY", kind: "房贷" }),
    account(5, 2, 8000, 1000, {
      composite: true,
      kind: "招商银行",
      opening_assets: 10000,
      opening_liabilities: 2000,
      ending_assets: 12000,
      ending_liabilities: 3000,
    }),
    account(6, 2, 10000, 0, { kind: "证券", inflow: 1000, outflow: 1000 }),
    account(7, 4, -100, 200, { kind: "现金" }),
    account(8, null, 0, 100, { kind: "未配置类型" }),
    account(9, 2, 1000, -1000, { kind: "证券" }),
    account(10, 4, 5000, 500, { kind: "银行卡" }),
  ],
};
report.totals = Object.fromEntries(
  ["opening_balance", "ending_balance", "net_change", "inflow", "outflow"].map(
    (key) => [key, report.accounts.reduce((sum, row) => sum + row[key], 0)],
  ),
);
report.totals.account_count = report.accounts.length;
report.totals.reconciled = true;
const unchanged = JSON.stringify(report);
function conservation(graph) {
  assert.equal(
    new Set(graph.nodes.map((row) => row.name)).size,
    graph.nodes.length,
  );
  const finalDepth = Math.max(...graph.nodes.map((row) => row.depth));
  for (const row of graph.nodes) {
    const incoming = graph.links
      .filter((link) => link.target === row.name)
      .reduce((sum, link) => sum + link.value, 0);
    const outgoing = graph.links
      .filter((link) => link.source === row.name)
      .reduce((sum, link) => sum + link.value, 0);
    if (row.depth) assert.equal(incoming, row.value);
    if (row.depth < finalDepth) assert.equal(outgoing, row.value);
    assert.equal(row.shareTotal, graph.positiveTotal);
  }
  for (const row of graph.links) {
    assert.ok(row.value > 0);
    assert.deepEqual(
      graph.selection({ dataType: "edge", data: row }),
      graph.selectionFor(row.target),
    );
    assert.equal(
      graph.nodes.find((node) => node.name === row.target).depth -
        graph.nodes.find((node) => node.name === row.source).depth,
      1,
    );
  }
  assert.equal(
    graph.nodes
      .filter((row) => row.depth === 3)
      .reduce((sum, row) => sum + row.signedValue, 0),
    graph.total,
  );
}
const graph = new AccountMovementDistribution(report, groups);
conservation(graph);
assert.equal(
  graph.total,
  report.totals.ending_balance - report.totals.opening_balance,
);
assert.equal(graph.increase - graph.decrease, graph.total);
assert.equal(graph.increase + graph.decrease, graph.positiveTotal);
assert.equal(graph.zeroCount, 1);
assert.equal(graph.nodes.filter((row) => row.accountId === 6).length, 0);
assert.equal(graph.nodes.filter((row) => row.accountId === 5).length, 1);
assert.equal(graph.nodes.find((row) => row.accountId === 5).signedValue, 1000);
assert.equal(
  graph.nodes.find((row) => row.accountId === 3).selection.account_tag,
  "liability",
);
assert.equal(
  graph.nodes.find((row) => row.accountId === 4).selection.account_tag,
  "liability",
);
assert.equal(graph.rows().length, report.accounts.length);
const bankTag = graph.selectionFor("movement:increase:group:2:tag:bank");
assert.deepEqual(
  graph.rows(bankTag).map((row) => row.id),
  [1, 5],
);
assert.deepEqual(
  graph
    .rows({ namespace: "movement:increase", group_id: 2 })
    .map((row) => row.id),
  [1, 5, 7, 10],
);
assert.deepEqual(
  graph
    .rows(graph.selectionFor("movement:increase:group:ungrouped"))
    .map((row) => row.id),
  [8],
);
assert.deepEqual(
  graph
    .rows(graph.selectionFor("movement:decrease:total"))
    .map((row) => row.id),
  [2, 3, 9],
);
const accountSelection = graph.selectionFor("movement:increase:account:1");
assert.deepEqual(
  graph.rows(accountSelection).map((row) => row.id),
  [1],
);
const changed = new AccountMovementDistribution(
  {
    ...report,
    accounts: report.accounts.map((row) =>
      row.id === 1
        ? { ...row, net_change: -100, kind: "证券", group_id: 3 }
        : row,
    ),
  },
  groups,
);
assert.deepEqual(
  changed.rows(accountSelection).map((row) => row.id),
  [1],
  "Precise account selection survives a same-scope type, direction or group edit",
);
bankTag.account_tag = "changed";
assert.equal(
  graph.selectionFor("movement:increase:group:2:tag:bank").account_tag,
  "bank",
);
assert.equal(JSON.stringify(report), unchanged);
const negativeNode = graph.nodes.find((row) => row.accountId === 3);
assert.ok(
  distributionOption(graph)
    .tooltip.formatter({ dataType: "node", data: negativeNode })
    .includes("-200.00"),
);
assert.ok(
  distributionOption(graph)
    .tooltip.formatter({ dataType: "node", data: negativeNode })
    .includes("增减幅度"),
);
for (const values of [
  [0, 0],
  [-100, -200],
  [100, 200],
  [100, -100],
]) {
  const projected = new AccountMovementDistribution(
    {
      accounts: values.map((delta, index) => account(index + 1, 2, 500, delta)),
    },
    groups,
  );
  if (projected.nodes.length) conservation(projected);
  else assert.equal(projected.positiveTotal, 0);
  assert.equal(
    projected.total,
    values.reduce((sum, value) => sum + value, 0),
  );
}
function render(graph, mode) {
  const chart = echarts.init(null, null, {
    renderer: "svg",
    ssr: true,
    width: 1180,
    height: graph.height,
  });
  chart.setOption(
    ChartAppearance.option(distributionOption(graph, 4), mode, true),
  );
  const svg = chart.renderToSVGString();
  assert.ok(!svg.includes("NaN") && !svg.includes("Infinity"));
  const rendered = chart.getModel().getSeriesByIndex(0).getGraph();
  for (const depth of [0, 1, 2, 3]) {
    const centers = rendered.nodes
      .filter((node) => graph.nodes[node.dataIndex].depth === depth)
      .map((node) => node.getLayout().y + node.getLayout().dy / 2)
      .sort((a, b) => a - b);
    for (let i = 1; i < centers.length; i++)
      assert.ok(centers[i] - centers[i - 1] >= 36);
  }
  chart.dispose();
  return svg;
}
render(graph, "forest");
render(graph, "dark");
for (const { value: mode } of Appearance.resolvedOptions()) {
  const option = ChartAppearance.option(
    distributionOption(graph, 4),
    mode,
    true,
  );
  const nodes = option.series[0].data;
  assert.equal(
    nodes.find((node) => node.name === "movement:increase:total").itemStyle
      .color,
    Appearance.colors(mode).positive,
  );
  assert.equal(
    nodes.find((node) => node.name === "movement:decrease:total").itemStyle
      .color,
    Appearance.colors(mode).expense,
  );
}
const { renderToStaticMarkup } = require("react-dom/server");
const { AccountMovementSection } = source("AccountMovementSection.tsx");
const { DistributionDiagram } = source("DistributionDiagram.tsx");
const { AnalysisDrilldownBar } = source("AnalysisDrilldown.tsx");
const { PagedTable } = source("PagedTable.tsx");
function elements(node, predicate) {
  if (Array.isArray(node))
    return node.flatMap((item) => elements(item, predicate));
  if (!node || typeof node !== "object") return [];
  return [
    ...(predicate(node) ? [node] : []),
    ...elements(node.props?.children, predicate),
    ...elements(node.props?.extra, predicate),
  ];
}
const section = new AccountMovementSection({ report, groups });
section.setState = (patch) => {
  section.state = { ...section.state, ...patch };
};
let tree = section.render();
const diagram = elements(tree, (node) => node.type === DistributionDiagram)[0];
assert.deepEqual(diagram.props.columns, [
  "期间净变动",
  "账户组",
  "账户标签",
  "账户",
]);
diagram.props.onSelect(
  graph.selectionFor("movement:increase:group:2:tag:bank"),
);
assert.deepEqual(
  section.rows().map((row) => row.id),
  [1, 5],
);
let table = elements(section.render(), (node) => node.type === PagedTable)[0];
assert.deepEqual(
  table.props.dataSource.map((row) => row.id),
  [1, 5],
);
assert.equal(
  table.props.columns.filter((column) => typeof column.sorter === "function")
    .length,
  6,
);
const breakdown = renderToStaticMarkup(
  table.props.expandable.expandedRowRender(
    report.accounts.find((row) => row.id === 5),
  ),
);
assert.ok(
  breakdown.includes("资产部分") &&
    breakdown.includes("负债部分") &&
    breakdown.includes("余额核对"),
);
assert.ok(
  breakdown.includes("净值") &&
    breakdown.includes("增加额") &&
    breakdown.includes("减少额"),
);
elements(
  section.render(),
  (node) => node.type === AnalysisDrilldownBar,
)[0].props.onReset();
assert.equal(section.rows().length, 10);
const toggle = elements(
  section.render(),
  (node) => node.props?.["aria-label"] === "账户变动明细显示范围",
)[0];
toggle.props.onChange("changed");
assert.ok(!section.rows().some((row) => row.id === 6));
toggle.props.onChange("all");
assert.equal(section.rows().length, 10);
const filterKeys = report.accounts.map((row) => row.id);
section.select(graph.selectionFor("movement:increase:account:1"));
const originalProps = section.props;
section.props = {
  ...originalProps,
  report: {
    ...report,
    accounts: report.accounts.map((row) =>
      row.id === 1 ? { ...row, net_change: -5 } : row,
    ),
  },
};
section.componentDidUpdate(originalProps);
assert.deepEqual(
  section.rows().map((row) => row.id),
  [1],
);
assert.equal(section.rows()[0].net_change, -5);
const sameScopeProps = section.props;
section.props = {
  ...sameScopeProps,
  report: { ...sameScopeProps.report, start: "2026-10-02" },
};
section.componentDidUpdate(sameScopeProps);
assert.equal(section.state.selection, undefined);
assert.equal(section.state.changedOnly, false);
assert.deepEqual(
  report.accounts.map((row) => row.id),
  filterKeys,
);
section.props = {
  report: {
    ...report,
    ignored_filters: ["category_id", "exact_category", "tag"],
  },
  groups,
};
const html = renderToStaticMarkup(section.render());
assert.ok(
  html.includes("完整期间") &&
    html.includes("冲销") &&
    html.includes("交易分类") &&
    html.includes("交易标签"),
);
assert.equal(JSON.stringify(report), unchanged);

// Real shared pagination operates over all selected accounts, not a truncated preview.
const manyReport = {
  ...report,
  accounts: Array.from({ length: 26 }, (_, index) =>
    account(index + 100, 2, 1000, index + 1, {
      name: `分页账户${String(index).padStart(2, "0")}`,
      transaction_count: 1,
    }),
  ),
};
section.props = { report: manyReport, groups };
table = elements(section.render(), (node) => node.type === PagedTable)[0];
const pager = new PagedTable(table.props);
const firstPage = renderToStaticMarkup(pager.render());
pager.state = { ...pager.state, current: 2 };
const secondPage = renderToStaticMarkup(pager.render());
assert.ok(
  firstPage.includes("分页账户25") && !firstPage.includes("分页账户15"),
);
assert.ok(
  secondPage.includes("分页账户15") && !secondPage.includes("分页账户25"),
);
assert.equal(table.props.dataSource.length, 26);

// Opening entries explain balance changes without becoming period contributions.
const openingReport = {
  start: report.start,
  end: report.end,
  accounts: [
    account(201, 2, 0, 100000, {
      opening_added: 100000,
      operating_change: 0,
      operating_inflow: 0,
      operating_outflow: 0,
      breakdown: [
        {
          kind: "OPENING",
          label: "期初录入",
          inflow: 100000,
          outflow: 0,
          net_change: 100000,
          transaction_count: 1,
        },
      ],
    }),
    account(202, 2, 1000, 4000, {
      inflow: 5000,
      outflow: 1000,
      opening_added: 5000,
      operating_change: -1000,
      operating_inflow: 0,
      operating_outflow: 1000,
      breakdown: [
        {
          kind: "OPENING",
          label: "期初录入",
          inflow: 5000,
          outflow: 0,
          net_change: 5000,
          transaction_count: 1,
        },
        {
          kind: "EXPENSE",
          label: "付款",
          inflow: 0,
          outflow: 1000,
          net_change: -1000,
          transaction_count: 1,
        },
      ],
    }),
    account(203, 3, 0, -99000, {
      role: "LIABILITY",
      kind: "房贷",
      inflow: 1000,
      outflow: 100000,
      opening_added: -100000,
      operating_change: 1000,
      operating_inflow: 1000,
      operating_outflow: 0,
      breakdown: [
        {
          kind: "OPENING",
          label: "期初录入",
          inflow: 0,
          outflow: 100000,
          net_change: -100000,
          transaction_count: 1,
        },
        {
          kind: "TRANSFER",
          label: "还款",
          inflow: 1000,
          outflow: 0,
          net_change: 1000,
          transaction_count: 1,
        },
      ],
    }),
    account(204, 3, 10000, 50, {
      inflow: 175,
      outflow: 125,
      opening_added: 0,
      operating_change: 50,
      operating_inflow: 75,
      operating_outflow: 25,
      breakdown: [
        {
          kind: "OPENING",
          label: "期初录入",
          inflow: 100,
          outflow: 100,
          net_change: 0,
          transaction_count: 2,
        },
        {
          kind: "INCOME",
          label: "收入",
          inflow: 75,
          outflow: 0,
          net_change: 75,
          transaction_count: 1,
        },
        {
          kind: "EXPENSE",
          label: "付款",
          inflow: 0,
          outflow: 25,
          net_change: -25,
          transaction_count: 1,
        },
      ],
    }),
    account(205, 3, 0, 111, {
      opening_added: 111,
      operating_change: 0,
      operating_inflow: 0,
      operating_outflow: 0,
      // Explicit contract fields take precedence over older cached breakdowns.
      breakdown: [],
    }),
  ],
};
openingReport.totals = Object.fromEntries(
  [
    "opening_balance",
    "ending_balance",
    "net_change",
    "inflow",
    "outflow",
    "opening_added",
    "operating_change",
    "operating_inflow",
    "operating_outflow",
  ].map((key) => [
    key,
    openingReport.accounts.reduce((sum, row) => sum + row[key], 0),
  ]),
);
const beforeOpenings = JSON.stringify(openingReport);
function freeze(value) {
  if (value && typeof value === "object") {
    Object.freeze(value);
    Object.values(value).forEach(freeze);
  }
}
freeze(openingReport);
const operatingGraph = new AccountMovementDistribution(openingReport, groups);
conservation(operatingGraph);
assert.equal(operatingGraph.total, 50);
assert.equal(operatingGraph.increase, 1050);
assert.equal(operatingGraph.decrease, 1000);
assert.equal(operatingGraph.zeroCount, 2);
assert.ok(
  !operatingGraph.nodes.some((node) => [201, 205].includes(node.accountId)),
);
assert.equal(
  operatingGraph.nodes.find((node) => node.accountId === 202).signedValue,
  -1000,
);
assert.equal(
  operatingGraph.nodes.find((node) => node.accountId === 203).signedValue,
  1000,
);
assert.deepEqual(
  operatingGraph
    .rows(operatingGraph.selectionFor("movement:decrease:total"))
    .map((row) => row.id),
  [202],
);
for (const row of operatingGraph.accounts)
  assert.equal(
    row.opening_balance +
      row.opening_added +
      row.operating_inflow -
      row.operating_outflow,
    row.ending_balance,
  );
for (const id of [202, 203, 204]) {
  const current = openingReport.accounts.find((row) => row.id === id);
  const {
    opening_added,
    operating_change,
    operating_inflow,
    operating_outflow,
    ...legacy
  } = current;
  assert.deepEqual(
    AccountMovementDistribution.amounts(legacy),
    {
      opening_added,
      operating_change,
      operating_inflow,
      operating_outflow,
    },
    "Legacy OPENING breakdowns preserve signed and gross opening separation",
  );
}
assert.deepEqual(
  AccountMovementDistribution.amounts({
    net_change: 90,
    inflow: 100,
    outflow: 10,
  }),
  {
    opening_added: 0,
    operating_change: 90,
    operating_inflow: 100,
    operating_outflow: 10,
  },
);
assert.deepEqual(
  AccountMovementDistribution.amounts({
    net_change: 90,
    opening_added: 100,
    inflow: 100,
    outflow: 10,
  }),
  {
    opening_added: 100,
    operating_change: -10,
    operating_inflow: 0,
    operating_outflow: 10,
  },
);
const openingOnly = new AccountMovementDistribution(
  { accounts: [openingReport.accounts[0]] },
  groups,
);
assert.equal(openingOnly.nodes.length, 0);
assert.equal(openingOnly.total, 0);
assert.equal(openingOnly.rows().length, 1);
const operatingSection = new AccountMovementSection({
  report: openingReport,
  groups,
});
operatingSection.setState = (patch) => {
  operatingSection.state = { ...operatingSection.state, ...patch };
};
const operatingTree = operatingSection.render();
const operatingTable = elements(
  operatingTree,
  (node) => node.type === PagedTable,
)[0];
assert.deepEqual(
  operatingTable.props.columns
    .filter((column) => column.sorter)
    .map((column) => column.dataIndex),
  [
    "opening_balance",
    "opening_added",
    "operating_inflow",
    "operating_outflow",
    "operating_change",
    "ending_balance",
  ],
);
const operatingHtml = renderToStaticMarkup(operatingTree);
assert.ok(
  operatingHtml.includes("期间净变动（剔除期初）") &&
    operatingHtml.includes("期初录入只补充历史余额"),
);
const openingEquation = renderToStaticMarkup(
  operatingTable.props.expandable.expandedRowRender(openingReport.accounts[1]),
);
assert.ok(
  openingEquation.includes("期初录入") &&
    openingEquation.includes("不计期间变动") &&
    openingEquation.includes("一致"),
);
elements(
  operatingTree,
  (node) => node.props?.["aria-label"] === "账户变动明细显示范围",
)[0].props.onChange("changed");
assert.deepEqual(
  operatingSection.rows().map((row) => row.id),
  [202, 203, 204],
);
render(operatingGraph, "forest");
assert.equal(JSON.stringify(openingReport), beforeOpenings);
if (process.argv[2]) {
  const data = JSON.parse(fs.readFileSync(process.argv[2]));
  const movement = data.account_movements || data.financial?.account_movements;
  assert.ok(movement, "Fixture needs account_movements");
  const actual = new AccountMovementDistribution(
    movement,
    data.groups || data.balanceSheet?.groups || [],
  );
  if (actual.nodes.length) {
    conservation(actual);
    render(actual, "forest");
  }
  assert.equal(
    actual.total,
    actual.accounts.reduce((sum, row) => sum + row.operating_change, 0),
  );
  assert.equal(
    actual.total +
      actual.accounts.reduce((sum, row) => sum + row.opening_added, 0),
    movement.totals.net_change,
  );
  for (const node of actual.nodes.filter((row) => row.depth === 2))
    assert.equal(
      actual
        .rows(actual.selectionFor(node.name))
        .reduce((sum, row) => sum + row.operating_change, 0),
      node.signedValue,
    );
  const { FinancialAnalysisWorkspace } = source(
    "FinancialAnalysisWorkspace.tsx",
  );
  const workspace = new FinancialAnalysisWorkspace({
    accounts: data.accounts || [],
    groups: data.groups || [],
    categories: [],
    tags: [],
    refreshKey: "test",
    onDetail() {},
  });
  workspace.state = {
    ...workspace.state,
    report: data.financial || data,
    loading: false,
    filters: { start: movement.start, end: movement.end },
  };
  const page = renderToStaticMarkup(workspace.render());
  assert.ok(page.includes("收入与支出在何时发生"));
  assert.ok(!page.includes("各账户变动明细"));
  workspace.state.activeTab = "movements";
  const movementPage = renderToStaticMarkup(workspace.render());
  assert.ok(
    movementPage.includes("账户期间变动") &&
      movementPage.includes("各账户变动明细"),
  );
  assert.ok(!movementPage.includes("收入与支出在何时发生"));
}
console.log(
  "Account movement opening separation, signed conservation, canonical attribution, exact local scopes, zero changes and SVG rendering passed.",
);
