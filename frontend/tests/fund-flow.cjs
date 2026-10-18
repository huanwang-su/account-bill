const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const echarts = require("echarts");
const { loadTs } = require("./source-loader.cjs");
const source = (file) => loadTs(path.resolve(__dirname, "../src", file));
const { FundFlowData } = source("FundFlowData.ts");
const { DistributionDiagram, distributionOption } = source(
  "DistributionDiagram.tsx",
);
const { ChartAppearance } = source("ChartAppearance.ts");
const groups = [
  { id: 1, name: "家庭", parent_id: null },
  { id: 2, name: "甲", parent_id: 1 },
  { id: 3, name: "乙", parent_id: 1 },
];
const funding = (id, name, group_id, extra = {}) => ({
  key: `account:${id}`,
  account_id: id,
  name,
  group_id,
  role: "ASSET",
  kind: "银行卡",
  external: false,
  in_scope: true,
  ...extra,
});
const endpoints = [
  funding(1, "银行卡", 2),
  funding(2, "微信", 3),
  funding(3, "证券", 2),
  funding(4, "信用卡", 2, { role: "LIABILITY" }),
  funding(5, "零活动账户", 1),
  { key: "external:income", name: "外部收入", external: true, in_scope: false },
  {
    key: "external:expense",
    name: "外部支出",
    external: true,
    in_scope: false,
  },
  { key: "external:refund", name: "外部退款", external: true, in_scope: false },
];
const flow = (id, source, target, amount, kind = "TRANSFER", index = 0) => ({
  id: `flow:${id}:${index}`,
  transaction_id: id,
  source,
  target,
  amount,
  kind,
  occurred_at: "2026-10-10 12:00:00",
});
const flows = [
  flow(1, "account:1", "account:2", 10000),
  flow(2, "account:2", "account:1", 4000),
  flow(3, "external:income", "account:1", 20000, "INCOME"),
  flow(4, "account:2", "external:expense", 3000, "EXPENSE"),
  flow(5, "external:refund", "account:2", 500, "REFUND"),
  flow(6, "account:1", "account:4", 700),
  flow(7, "account:4", "account:1", 800),
  flow(8, "account:1", "account:3", 2000),
  flow(9, "account:1", "account:2", 100),
  flow(9, "account:1", "account:3", 200, "TRANSFER", 1),
  flow(12, "external:income", "account:1", 250, "INCOME"),
];
const transactions = [...new Set(flows.map((row) => row.transaction_id))].map(
  (id) => ({
    id,
    kind: flows.find((row) => row.transaction_id === id).kind,
    occurred_at: "2026-10-10 12:00:00",
    allocation: "allocated",
    amount: flows
      .filter((row) => row.transaction_id === id)
      .reduce((sum, row) => sum + row.amount, 0),
    counterparty: "交易方",
    entries: [],
    category_names: [],
    account_names: [],
  }),
);
transactions.push(
  {
    id: 10,
    kind: "TRANSFER",
    amount: 1000,
    allocation: "unallocated",
    occurred_at: "2026-10-10 12:00:00",
    entries: [],
    counterparty: "多方交易",
  },
  {
    id: 11,
    kind: "TRANSFER",
    amount: 2000,
    allocation: "merged_internal",
    occurred_at: "2026-10-10 12:00:00",
    entries: [],
    counterparty: "合并内转账",
  },
);
const report = {
  start: "2026-10-01",
  end: "2026-10-18",
  groups,
  endpoints,
  flows,
  transactions,
  scope_account_ids: [1, 2, 3, 4, 5],
  unallocated: [
    {
      transaction_id: 10,
      amount: 1000,
      scope_amount: 1000,
      reason: "多方线路待分配",
    },
  ],
  merged_internal: {
    transaction_count: 1,
    amount: 2000,
    transaction_ids: [11],
  },
  excluded: [
    {
      reason: "OPENING",
      label: "期初录入不属于资金流转",
      transaction_count: 2,
      amount: 200000,
      transaction_ids: [98, 99],
    },
  ],
};
const original = JSON.stringify(report);
function conservation(data) {
  assert.equal(
    new Set(data.nodes.map((row) => row.name)).size,
    data.nodes.length,
  );
  assert.equal(
    data.nodes
      .filter((row) => row.depth === 0)
      .reduce((sum, row) => sum + row.value, 0),
    data.positiveTotal,
  );
  assert.equal(
    data.nodes
      .filter((row) => row.depth === 1)
      .reduce((sum, row) => sum + row.value, 0),
    data.positiveTotal,
  );
  for (const node of data.nodes) {
    const links = data.links.filter((link) =>
      node.depth === 0 ? link.source === node.name : link.target === node.name,
    );
    assert.equal(
      links.reduce((sum, row) => sum + row.value, 0),
      node.value,
    );
  }
  for (const link of data.links) {
    assert.ok(link.value > 0);
    assert.equal(data.nodes.find((node) => node.name === link.source).depth, 0);
    assert.equal(data.nodes.find((node) => node.name === link.target).depth, 1);
    const selection = data.selection({ dataType: "edge", data: link });
    assert.equal(
      data.flowRows(selection).reduce((sum, row) => sum + row.amount, 0),
      link.value,
    );
  }
}
const data = new FundFlowData(report);
conservation(data);
assert.equal(data.positiveTotal, 41550);
assert.deepEqual(data.summary(), {
  amount: 41550,
  incoming: 38550,
  outgoing: 20800,
  net: 17750,
  internal: 17800,
  external_inflow: 20750,
  external_outflow: 3000,
  count: 10,
});
assert.equal(data.stats().find((row) => row.key === "account:1").net, 12050);
assert.equal(
  data.stats().reduce((sum, row) => sum + row.net, 0),
  17750,
);
assert.equal(
  data.stats().find((row) => row.key === "account:5").transaction_count,
  0,
);
assert.equal(data.transactions().length, 12);
const sourceNode = data.nodes.find((row) =>
  row.name.endsWith("source:account:1"),
);
const targetNode = data.nodes.find((row) =>
  row.name.endsWith("target:account:1"),
);
assert.ok(
  sourceNode && targetNode && sourceNode.name !== targetNode.name,
  "Bidirectional accounts occupy two distinct columns",
);
const route = data.links.find(
  (row) =>
    row.selection.source === "account:1" &&
    row.selection.target === "account:2",
);
const selection = data.selection({ dataType: "edge", data: route });
assert.equal(route.value, 10100);
assert.deepEqual(
  data.transactions(selection).map((row) => row.id),
  [1, 9],
);
assert.equal(
  data.transactions(selection).find((row) => row.id === 9).selected_flow_amount,
  100,
);
assert.equal(
  data.transactions(selection).find((row) => row.id === 9).amount,
  300,
  "Local route amounts must not replace the complete original transaction",
);
const nodeSelection = data.selection({ dataType: "node", data: sourceNode });
assert.ok(
  data.flowRows(nodeSelection).every((row) => row.source === "account:1"),
);
nodeSelection.source = "changed";
assert.equal(data.selectionFor(sourceNode.name).source, "account:1");
const grouped = new FundFlowData(report, "group");
conservation(grouped);
assert.equal(
  grouped.stats().find((row) => row.key === "group:2").internal_amount,
  3700,
);
assert.equal(grouped.stats().find((row) => row.key === "group:2").net, 14150);
const within = grouped.links.find(
  (row) =>
    row.selection.source === "group:2" && row.selection.target === "group:2",
);
assert.ok(
  within,
  "Group-internal movements retain a same-group left-to-right route",
);
assert.equal(within.value, 3700);
assert.equal(
  grouped.summary(grouped.selection({ dataType: "edge", data: within })).net,
  0,
);
assert.equal(
  new FundFlowData(report, "account", "internal").summary().amount,
  17800,
);
assert.equal(new FundFlowData(report, "account", "internal").summary().net, 0);
assert.ok(
  new FundFlowData(report, "account", "internal")
    .transactions()
    .some((row) => row.id === 11),
);
assert.ok(
  !new FundFlowData(report, "account", "external")
    .transactions()
    .some((row) => row.id === 10 || row.id === 11),
);
assert.equal(
  new FundFlowData(report, "group", "external").summary().amount,
  23750,
);
const scoped = {
  ...report,
  scope_account_ids: [1],
  endpoints: endpoints.map((row) => ({
    ...row,
    in_scope: row.account_id === 1,
  })),
  flows: flows.filter(
    (row) => row.source === "account:1" || row.target === "account:1",
  ),
};
const one = new FundFlowData(scoped);
assert.equal(one.summary().incoming, 25050);
assert.equal(one.summary().outgoing, 13000);
assert.equal(one.stats().length, 1);
assert.ok(
  one.nodes.some((row) => row.displayName === "微信"),
  "The other side stays visible across a selected account boundary",
);
assert.equal(
  one.flowRows().find((row) => row.source === "account:2").source_in_scope,
  false,
);
assert.equal(JSON.stringify(report), original);
function render(data, mode) {
  const chart = echarts.init(null, null, {
    renderer: "svg",
    ssr: true,
    width: 1180,
    height: data.height,
  });
  chart.setOption(
    ChartAppearance.option(distributionOption(data, 2), mode, true),
  );
  const svg = chart.renderToSVGString();
  assert.ok(!svg.includes("NaN") && !svg.includes("Infinity"));
  const graph = chart.getModel().getSeriesByIndex(0).getGraph();
  for (const depth of [0, 1]) {
    const centers = graph.nodes
      .filter((node) => data.nodes[node.dataIndex].depth === depth)
      .map((node) => node.getLayout().y + node.getLayout().dy / 2)
      .sort((a, b) => a - b);
    for (let i = 1; i < centers.length; i++)
      assert.ok(centers[i] - centers[i - 1] >= 36);
  }
  chart.dispose();
  return svg;
}
render(data, "forest");
render(data, "dark");
render(grouped, "forest");
const empty = new FundFlowData({
  groups: [],
  endpoints: [],
  flows: [],
  transactions: [],
});
assert.equal(empty.nodes.length, 0);
assert.equal(empty.summary().net, 0);
const columns = new DistributionDiagram({
  data,
  label: "资金流转",
  columns: ["转出方", "转入方"],
}).render().props.children.props.children[0].props.children;
assert.ok(
  columns[1].props.style.left.includes("100%"),
  "The two-column target heading aligns with the recipient column",
);
const { FundFlowWorkspace } = source("FundFlowWorkspace.tsx");
const { PagedTable } = source("PagedTable.tsx");
const { AnalysisDrilldownBar } = source("AnalysisDrilldown.tsx");
const { renderToStaticMarkup } = require("react-dom/server");
function elements(node, predicate) {
  if (Array.isArray(node))
    return node.flatMap((item) => elements(item, predicate));
  if (!node || typeof node !== "object") return [];
  return [
    ...(predicate(node) ? [node] : []),
    ...elements(node.props?.children, predicate),
    ...elements(node.props?.extra, predicate),
    ...(node.props?.items || []).flatMap((item) =>
      elements(item.children, predicate),
    ),
  ];
}
let opened;
function workspace() {
  const value = new FundFlowWorkspace({
    accounts: endpoints
      .filter((row) => !row.external)
      .map((row) => ({ ...row, id: row.account_id, active: true })),
    groups,
    refreshKey: "test",
    onDetail: (row) => {
      opened = row;
    },
  });
  value.state = { ...value.state, report, loading: false };
  value.setState = (patch, done) => {
    value.state = {
      ...value.state,
      ...(typeof patch === "function" ? patch(value.state) : patch),
    };
    done?.();
  };
  return value;
}
const page = workspace();
let tree = page.renderReport(report);
const diagram = elements(tree, (node) => node.type === DistributionDiagram)[0];
assert.deepEqual(diagram.props.columns, ["转出方", "转入方"]);
diagram.props.onSelect(selection);
assert.deepEqual(
  new FundFlowData(report)
    .transactions(page.state.selection)
    .map((row) => row.id),
  [1, 9],
);
tree = page.renderReport(report);
let tables = elements(tree, (node) => node.type === PagedTable);
assert.equal(tables.length, 3);
assert.equal(tables[1].props.dataSource.length, 2);
const txTable = tables[2];
const selectedTx = txTable.props.dataSource.find((row) => row.id === 9);
assert.equal(selectedTx.selected_flow_amount, 100);
txTable.props.columns
  .find((column) => column.title === "操作")
  .render(null, selectedTx)
  .props.onClick();
assert.equal(
  opened,
  report.transactions.find((row) => row.id === 9),
);
assert.equal(opened.amount, 300);
page.state.loading = true;
opened = undefined;
page.openTransaction(1);
assert.equal(opened, undefined);
page.state.loading = false;
elements(
  page.renderReport(report),
  (node) => node.type === AnalysisDrilldownBar,
)[0].props.onReset();
assert.equal(page.state.selection, undefined);
page.select(selection);
page.display({ dimension: "group" });
assert.equal(page.state.selection, undefined);
assert.equal(page.state.dimension, "group");
page.state.activeTab = "stats";
page.state.perspective = "network";
const html = renderToStaticMarkup(page.render());
assert.ok(
  html.includes("资金流转图") &&
    html.includes("组内互转") &&
    html.includes("多方交易") &&
    html.includes("期初录入"),
);
const many = Array.from({ length: 26 }, (_, index) => ({
  id: index + 1000,
  occurred_at: "2026-10-10 12:00:00",
  kind: "TRANSFER",
  amount: 100,
  selected_flow_amount: 100,
  allocation: "allocated",
  counterparty: `分页交易${String(index).padStart(2, "0")}`,
}));
const manyTable = elements(
  page.transactionTable(many, "many"),
  (node) => node.type === PagedTable,
)[0];
const pager = new PagedTable(manyTable.props);
const first = renderToStaticMarkup(pager.render());
pager.state = { ...pager.state, current: 2 };
const second = renderToStaticMarkup(pager.render());
assert.ok(first.includes("分页交易00") && !first.includes("分页交易10"));
assert.ok(second.includes("分页交易10") && !second.includes("分页交易00"));
assert.equal(manyTable.props.dataSource.length, 26);
assert.equal(JSON.stringify(report), original);
async function requests() {
  const current = workspace(),
    pending = [];
  current.api.request = (url) =>
    new Promise((resolve, reject) => pending.push({ url, resolve, reject }));
  current.state.filters = { account_id: 1, start: "2026-10-01" };
  const first = current.load();
  current.state.filters = { group_id: 3, start: "2026-10-02" };
  const second = current.load();
  assert.ok(
    pending[0].url.includes("account_id=1") &&
      pending[1].url.includes("group_id=3"),
  );
  pending[1].resolve({ ...report, start: "2026-10-02" });
  await second;
  pending[0].resolve({ ...report, start: "2026-10-01" });
  await first;
  assert.equal(current.state.report.start, "2026-10-02");
  const third = current.load();
  current.componentWillUnmount();
  pending[2].resolve({ ...report, start: "2026-10-03" });
  await third;
  assert.equal(current.state.report.start, "2026-10-02");
  const failure = workspace();
  failure.api.request = async () => {
    throw new Error("加载失败");
  };
  await failure.load();
  assert.equal(failure.state.loading, false);
  assert.equal(failure.state.report, undefined);
  assert.equal(failure.state.error, "加载失败");
  console.log(
    "Fund flow local linkage, complete transaction details, true pagination and request-race handling passed.",
  );
}
requests().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
if (process.argv[2]) {
  const actual = JSON.parse(fs.readFileSync(process.argv[2]));
  const report = actual.fundFlows || actual;
  for (const dimension of ["account", "group"]) {
    const projected = new FundFlowData(report, dimension);
    conservation(projected);
    if (projected.nodes.length) render(projected, "forest");
    assert.equal(projected.summary().incoming, report.totals.scope_inflow);
    assert.equal(projected.summary().outgoing, report.totals.scope_outflow);
  }
  const live = workspace();
  live.state.report = report;
  const output = renderToStaticMarkup(live.render());
  assert.ok(output.includes("资金流转图") && output.includes("流转明细"));
}
console.log(
  "Fund flow bidirectional conservation, group-internal routes, gross scope totals, exact selections and SVG rendering passed.",
);
