const assert = require("node:assert/strict"),
  path = require("node:path"),
  fs = require("node:fs");
const { loadTs } = require("./source-loader.cjs"),
  echarts = require("echarts");
const source = (file) => loadTs(path.resolve(__dirname, "../src", file));
const { ScopeFundFlowData } = source("ScopeFundFlowData.ts");
const { ScopeFundFlowSection } = source("ScopeFundFlowSection.tsx");
const { DistributionDiagram, distributionOption } = source(
  "DistributionDiagram.tsx",
);
const { AnalysisDrilldownBar } = source("AnalysisDrilldown.tsx");
const { PagedTable } = source("PagedTable.tsx");
const { ChartAppearance } = source("ChartAppearance.ts");
const { renderToStaticMarkup } = require("react-dom/server");
const groups = [
  { id: 1, name: "家庭", parent_id: null },
  { id: 2, name: "甲", parent_id: 1 },
  { id: 3, name: "乙", parent_id: 1 },
];
const endpoints = [
  ...[1, 2, 3].map((id) => ({
    key: `account:${id}`,
    account_id: id,
    name: `账户${id}`,
    role: "ASSET",
    kind: "银行卡",
    group_id: id === 3 ? 3 : 2,
    external: false,
    in_scope: true,
  })),
  { key: "external:income", name: "外部收入", external: true, in_scope: false },
  {
    key: "external:expense",
    name: "外部支出",
    external: true,
    in_scope: false,
  },
];
const flow = (id, tx, source, target, amount) => ({
  id,
  transaction_id: tx,
  source,
  target,
  amount,
  kind: source.startsWith("external")
    ? "INCOME"
    : target.startsWith("external")
      ? "EXPENSE"
      : "TRANSFER",
  occurred_at: "2026-10-10 12:00:00",
});
const flows = [
  flow("1", 1, "external:income", "account:1", 1000),
  flow("2", 2, "account:1", "account:2", 200),
  flow("3", 3, "account:1", "account:3", 300),
  flow("4", 4, "account:3", "account:1", 100),
  flow("5", 5, "account:2", "external:expense", 50),
  flow("6a", 6, "external:income", "account:1", 600),
  flow("6b", 6, "external:income", "account:3", 400),
];
const transactions = [1, 2, 3, 4, 5, 6].map((id) => ({
  id,
  kind: flows.find((row) => row.transaction_id === id).kind,
  occurred_at: "2026-10-10 12:00:00",
  status: "POSTED",
  amount: flows
    .filter((row) => row.transaction_id === id)
    .reduce((sum, row) => sum + row.amount, 0),
  counterparty: `交易方${id}`,
  allocation: "allocated",
  entries: [{ account_id: 1, account: "账户1", role: "ASSET", amount: 100 }],
  tags: [],
}));
function scope(
  key,
  level,
  name,
  ids,
  incomingIds,
  outgoingIds,
  internalIds = [],
  extra = {},
) {
  const incoming = flows
      .filter((row) => incomingIds.includes(row.id))
      .reduce((sum, row) => sum + row.amount, 0),
    outgoing = flows
      .filter((row) => outgoingIds.includes(row.id))
      .reduce((sum, row) => sum + row.amount, 0);
  const inTx = [
      ...new Set(
        flows
          .filter((row) => incomingIds.includes(row.id))
          .map((row) => row.transaction_id),
      ),
    ],
    outTx = [
      ...new Set(
        flows
          .filter((row) => outgoingIds.includes(row.id))
          .map((row) => row.transaction_id),
      ),
    ];
  return {
    key,
    level,
    name,
    account_ids: ids,
    incoming,
    outgoing,
    net: incoming - outgoing,
    incoming_flow_ids: incomingIds,
    outgoing_flow_ids: outgoingIds,
    flow_ids: [...incomingIds, ...outgoingIds],
    incoming_count: inTx.length,
    outgoing_count: outTx.length,
    count: new Set([...inTx, ...outTx]).size,
    internal_excluded: flows
      .filter((row) => internalIds.includes(row.id))
      .reduce((sum, row) => sum + row.amount, 0),
    internal_count: internalIds.length,
    unallocated_count: 0,
    ...extra,
  };
}
const summary = scope(
  "total",
  "total",
  "整体",
  [1, 2, 3],
  ["1", "6a", "6b"],
  ["5"],
  ["2", "3", "4"],
);
const groupA = scope(
  "group:2",
  "group",
  "甲",
  [1, 2],
  ["1", "4", "6a"],
  ["3", "5"],
  ["2"],
  { group_id: 2, parent_id: 1 },
);
const report = {
  start: "2026-10-01",
  end: "2026-10-18",
  groups,
  endpoints,
  flows,
  transactions,
  scope_account_ids: [1, 2, 3],
  summary,
  group_scopes: [
    {
      ...summary,
      key: "group:1",
      level: "group",
      name: "家庭",
      group_id: 1,
      parent_id: null,
    },
    groupA,
    scope("group:3", "group", "乙", [3], ["3", "6b"], ["4"], [], {
      group_id: 3,
      parent_id: 1,
    }),
  ],
  account_scopes: [
    scope(
      "account:1",
      "account",
      "账户1",
      [1],
      ["1", "4", "6a"],
      ["2", "3"],
      [],
      { account_id: 1, group_id: 2 },
    ),
  ],
};
const unchanged = JSON.stringify(report);
function verify(data) {
  const left = data.nodes.filter((row) => row.depth === 0),
    right = data.nodes.filter((row) => row.depth === 1);
  assert.equal(
    left.reduce((sum, row) => sum + row.value, 0),
    data.positiveTotal,
  );
  assert.equal(
    right.reduce((sum, row) => sum + row.value, 0),
    data.positiveTotal,
  );
  for (const depth of [0, 1, 2, 3])
    assert.equal(
      data.nodes
        .filter((row) => row.depth === depth)
        .reduce((sum, row) => sum + row.value, 0),
      data.positiveTotal,
    );
  for (const node of data.nodes) {
    const linked = data.links.filter((row) =>
      node.depth === 0 ? row.source === node.name : row.target === node.name,
    );
    assert.equal(
      linked.reduce((sum, row) => sum + row.value, 0),
      node.value,
    );
    const selection = data.selection({ dataType: "node", data: node });
    assert.equal(
      data.flowRows(selection).reduce((sum, row) => sum + row.amount, 0),
      node.value,
    );
  }
  for (const link of data.links)
    assert.equal(
      data
        .flowRows(data.selection({ dataType: "edge", data: link }))
        .reduce((sum, row) => sum + row.amount, 0),
      link.value,
    );
  assert.equal(data.summary().incoming, data.scope.incoming);
  assert.equal(data.summary().outgoing, data.scope.outgoing);
  assert.equal(
    data.transactions().reduce((sum, row) => sum + row.boundary_incoming, 0),
    data.scope.incoming,
  );
  assert.equal(
    data.transactions().reduce((sum, row) => sum + row.boundary_outgoing, 0),
    data.scope.outgoing,
  );
}
const overall = new ScopeFundFlowData(report);
verify(overall);
assert.deepEqual(overall.summary(), {
  incoming: 2000,
  outgoing: 50,
  net: 1950,
  count: 3,
});
assert.ok(!overall.flowRows().some((row) => ["2", "3", "4"].includes(row.id)));
const grouped = new ScopeFundFlowData(report, "group:2");
verify(grouped);
assert.deepEqual(grouped.summary(), {
  incoming: 1700,
  outgoing: 350,
  net: 1350,
  count: 5,
});
assert.ok(!grouped.flowRows().some((row) => row.id === "2"));
const node = grouped.nodes.find(
  (row) =>
    row.depth === 3 &&
    row.selection.direction === "IN" &&
    row.selection.counterpart_key === "external:income",
);
const selected = grouped.selectionFor(node.name);
const partial = grouped.transactions(selected).find((row) => row.id === 6);
assert.equal(partial.amount, 1000);
assert.equal(partial.boundary_amount, 600);
assert.equal(grouped.transactions(selected).length, 2);
const single = new ScopeFundFlowData(report, "account:1");
verify(single);
assert.equal(single.summary().outgoing, 500);
assert.ok(
  single.flowRows().some((row) => row.id === "2"),
  "Same-group transfers cross a single account boundary",
);
assert.equal(JSON.stringify(report), unchanged);
function render(data, mode = "forest") {
  const chart = echarts.init(null, null, {
    renderer: "svg",
    ssr: true,
    width: 1180,
    height: data.height,
  });
  chart.setOption(
    ChartAppearance.option(distributionOption(data, 4), mode, true),
  );
  const svg = chart.renderToSVGString();
  assert.ok(!svg.includes("NaN") && !svg.includes("Infinity"));
  chart.dispose();
}
render(overall);
render(grouped, "dark");
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
const section = new ScopeFundFlowSection({
  filters: {
    start: "2026-10-01",
    end: "2026-10-18",
    category_id: 88,
    tag: "交易标签",
  },
  refreshKey: "test",
  onDetail: (row) => {
    opened = row;
  },
});
section.state = { ...section.state, report, loading: false };
section.setState = (patch, done) => {
  section.state = {
    ...section.state,
    ...(typeof patch === "function" ? patch(section.state) : patch),
  };
  done?.();
};
assert.deepEqual(section.scopeFilters(), {
  period: undefined,
  start: "2026-10-01",
  end: "2026-10-18",
  group_id: undefined,
  account_id: undefined,
  exclude_investment_accounts: undefined,
  exclude_single_accounts: undefined,
  excluded_account_ids: "[]",
});
section.changeDimension("group");
section.selectScope("group:2");
let tree = section.renderReport(report);
const diagram = elements(
  tree,
  (element) => element.type === DistributionDiagram,
)[0];
diagram.props.onSelect(selected);
assert.equal(section.state.activeTab, "transactions");
let tables = elements(
  section.renderReport(report),
  (element) => element.type === PagedTable,
);
assert.equal(tables[0].props.dataSource.length, 2);
const local = tables[0].props.dataSource.find((row) => row.id === 6);
assert.equal(local.boundary_incoming, 600);
tables[0].props.columns
  .find((column) => column.title === "操作")
  .render(null, local)
  .props.onClick();
assert.equal(
  opened,
  report.transactions.find((row) => row.id === 6),
);
assert.equal(opened.amount, 1000);
elements(
  section.renderReport(report),
  (element) => element.type === AnalysisDrilldownBar,
)[0].props.onReset();
assert.equal(section.state.selection, undefined);
assert.ok(
  renderToStaticMarkup(section.render()).includes("范围内部互转已剔除"),
);
const beforeProps = section.props;
section.props = {
  ...beforeProps,
  filters: { ...beforeProps.filters, category_id: 99, tag: "另一标签" },
};
let loads = 0;
const originalLoad = section.load;
section.load = () => {
  loads++;
};
section.componentDidUpdate(beforeProps);
assert.equal(
  loads,
  0,
  "Transaction category/tag must not reload or change boundary scopes",
);
section.load = originalLoad;
const manyFlows = Array.from({ length: 26 }, (_, index) =>
  flow(`p${index}`, index + 100, "external:income", "account:1", 100),
);
const manyTransactions = manyFlows.map((row, index) => ({
  id: row.transaction_id,
  kind: "INCOME",
  allocation: "allocated",
  amount: 100,
  occurred_at: row.occurred_at,
  counterparty: `分页进出${String(index).padStart(2, "0")}`,
  entries: [],
}));
const manyReport = {
  ...report,
  flows: manyFlows,
  transactions: manyTransactions,
  summary: {
    ...summary,
    incoming: 2600,
    outgoing: 0,
    incoming_flow_ids: manyFlows.map((row) => row.id),
    outgoing_flow_ids: [],
    count: 26,
  },
};
section.state = {
  ...section.state,
  scopeKey: "total",
  dimension: "total",
  selection: undefined,
};
const table = elements(
  section.renderReport(manyReport),
  (element) => element.type === PagedTable,
)[0];
const pager = new PagedTable(table.props);
const first = renderToStaticMarkup(pager.render());
pager.state = { ...pager.state, current: 2 };
const second = renderToStaticMarkup(pager.render());
assert.ok(first.includes("分页进出00") && !first.includes("分页进出10"));
assert.ok(second.includes("分页进出10") && !second.includes("分页进出00"));
if (process.argv[2]) {
  const actual = JSON.parse(fs.readFileSync(process.argv[2]));
  for (const scope of [
    actual.summary,
    ...actual.group_scopes,
    ...actual.account_scopes,
  ]) {
    const data = new ScopeFundFlowData(actual, scope.key);
    verify(data);
  }
  render(new ScopeFundFlowData(actual));
}
console.log(
  "Scope boundary flows, internal exclusions, precise partial transactions, filters, chart clicks and real pagination passed.",
);
