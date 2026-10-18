const assert = require("node:assert/strict"),
  fs = require("fs"),
  path = require("path"),
  React = require("react");
const { loadTs } = require("./source-loader.cjs");
const source = (name) => loadTs(path.resolve(__dirname, "../src", name));
const { ReportPeriodFilter } = source("ReportPeriodFilter.tsx"),
  { OverviewWorkspace } = source("OverviewWorkspace.tsx"),
  { SingleAccountWorkspace } = source("SingleAccountWorkspace.tsx"),
  { ScopeFundFlowData } = source("ScopeFundFlowData.ts"),
  { distributionOption } = source("DistributionDiagram.tsx"),
  { Chart } = source("Chart.tsx");
const echarts = require("echarts");
function instance(Component, props, state = {}) {
  const p = new Component(props);
  p.state = { ...p.state, ...state };
  p.setState = (patch, done) => {
    p.state = {
      ...p.state,
      ...(typeof patch === "function" ? patch(p.state) : patch),
    };
    done?.();
  };
  return p;
}
function elements(v, seen = new Set()) {
  if (!v || typeof v !== "object" || seen.has(v)) return [];
  seen.add(v);
  return [
    ...(React.isValidElement(v) ? [v] : []),
    ...Object.values(React.isValidElement(v) ? v.props : v).flatMap((x) =>
      elements(x, seen),
    ),
  ];
}
async function periods() {
  const selected = [],
    c = instance(ReportPeriodFilter, {
      filters: { period: "latest_month" },
      onChange: (p) => selected.push(p),
    });
  c.api.request = async (url) => {
    const q = new URLSearchParams(url.split("?")[1]);
    return {
      start: q.get("period") === "3m" ? "2026-07-19" : "2026-10-01",
      end: q.get("period") === "3m" ? "2026-10-18" : "2026-10-31",
      latest_data_date: "2026-10-18",
      today: "2026-10-19",
    };
  };
  await c.resolve();
  assert.deepEqual(selected.pop(), {
    period: "latest_month",
    start: "2026-10-01",
    end: "2026-10-31",
  });
  await c.resolve("3m", true);
  assert.deepEqual(selected.pop(), {
    period: "3m",
    start: "2026-07-19",
    end: "2026-10-18",
  });
  const select = elements(c.render()).find(
    (n) => n.props["aria-label"] === "时间快捷范围",
  );
  assert.deepEqual(
    select.props.options.map((n) => n.value),
    ["latest_month", "1m", "3m", "6m", "1y", "custom"],
  );
  select.props.onChange("custom");
  assert.equal(selected.pop().period, "custom");
  const pending = [];
  c.api.request = () => new Promise((resolve) => pending.push(resolve));
  const first = c.resolve("1m", true),
    second = c.resolve("6m", true);
  pending[0]({ start: "old", end: "old" });
  await first;
  assert.equal(selected.length, 0);
  pending[1]({ start: "2026-04-19", end: "2026-10-18" });
  await second;
  assert.equal(selected.pop().period, "6m");
  const late = c.resolve("1y", true);
  c.componentWillUnmount();
  pending[2]({ start: "old", end: "old" });
  await late;
  assert.equal(selected.length, 0);
  for (const name of fs
    .readdirSync(path.resolve(__dirname, "../src"))
    .filter((n) => n.endsWith(".tsx") && n !== "ReportPeriodFilter.tsx"))
    assert.ok(
      !fs
        .readFileSync(path.resolve(__dirname, "../src", name), "utf8")
        .includes("DatePicker.RangePicker"),
      name,
    );
}
function attention() {
  const account = {
    id: 7,
    name: "关注账户",
    income: 0,
    expense: 0,
    refunds: 0,
    transfer_in: 1200,
    transfer_out: 400,
    transfer_net: 800,
    change: 800,
    ending_balance: 1000,
    transactions: [
      {
        id: 1,
        kind: "TRANSFER",
        account_change: 1200,
        occurred_at: "2026-10-02 12:00:00",
      },
      {
        id: 2,
        kind: "TRANSFER",
        account_change: -400,
        occurred_at: "2026-10-02 13:00:00",
      },
    ],
    trend: [
      {
        day: "2026-10-02",
        income: 0,
        expense: 0,
        transfer_in: 1200,
        transfer_out: 400,
      },
    ],
  };
  const data = {
      period: { start: "2026-10-01", end: "2026-10-31" },
      single_accounts: { accounts: [account] },
    },
    opened = [];
  const p = instance(
    OverviewWorkspace,
    { onSingleAccount: (...args) => opened.push(args) },
    { data, loading: false },
  );
  p.viewSingleAccount(account, data);
  assert.deepEqual(opened[0], [
    7,
    { period: "custom", start: "2026-10-01", end: "2026-10-31" },
  ]);
  p.state.data = { ...data };
  p.viewSingleAccount(account, data);
  assert.equal(opened.length, 1);
  p.state.data = data;
  const s = instance(SingleAccountWorkspace, {
    initialAccountId: 7,
    initialFilters: opened[0][1],
    refreshKey: "x",
    onConfigure() {},
    onDetail() {},
  });
  assert.equal(s.state.selected, "7");
  assert.equal(s.state.filters.start, "2026-10-01");
  const chart = elements(p.renderAttentionAccounts(data)).find(
    (n) => n.type === Chart,
  );
  assert.deepEqual(
    chart.props.option.series.map((n) => n.name),
    ["收入", "净支出", "内部转入", "内部转出"],
  );
  for (const [index, amount, id] of [
    [2, 1200, 1],
    [3, 400, 2],
  ]) {
    chart.props.onClick({ data: chart.props.option.series[index].data[0] });
    assert.equal(p.state.chartDetail.amount, amount);
    assert.deepEqual(
      p.state.chartDetail.transactions.map((n) => n.id),
      [id],
    );
  }
}
function layout(report) {
  const model = new ScopeFundFlowData(report),
    chart = echarts.init(null, null, {
      renderer: "svg",
      ssr: true,
      width: 1400,
      height: model.height,
    });
  chart.setOption(distributionOption(model, 4));
  const graph = chart.getModel().getSeries()[0].getGraph();
  let pairs = 0;
  for (const a of graph.edges)
    for (const b of graph.edges) {
      if (
        a.dataIndex >= b.dataIndex ||
        a.node1.getLayout().depth !== b.node1.getLayout().depth
      )
        continue;
      const al = a.getLayout(),
        bl = b.getLayout(),
        sa = a.node1.getLayout().y + al.sy + al.dy / 2,
        sb = b.node1.getLayout().y + bl.sy + bl.dy / 2,
        ta = a.node2.getLayout().y + al.ty + al.dy / 2,
        tb = b.node2.getLayout().y + bl.ty + bl.dy / 2;
      assert.ok(
        (sa - sb) * (ta - tb) >= -0.000001,
        "Tree branches must not cross",
      );
      pairs++;
    }
  for (const node of model.nodes)
    assert.equal(
      model.flowRows(node.selection).reduce((sum, r) => sum + r.amount, 0),
      node.value,
    );
  assert.equal(
    model.nodes.filter((n) => n.depth === 0)[0].selection.direction,
    "IN",
  );
  chart.dispose();
  return pairs;
}
const endpoints = [
  { key: "outside-in", name: "收入", external: true },
  { key: "outside-out", name: "支出", external: true },
  ...[
    [1, 1],
    [2, 1],
    [3, 2],
  ].map(([account_id, group_id]) => ({
    key: `account:${account_id}`,
    name: `账户${account_id}`,
    account_id,
    group_id,
  })),
];
const flows = [
  [1, 1, "OUT", 900],
  [2, 3, "IN", 1200],
  [3, 2, "OUT", 100],
  [4, 1, "IN", 600],
  [5, 3, "OUT", 200],
  [6, 2, "IN", 300],
].map(([id, account, direction, amount]) => ({
  id: String(id),
  transaction_id: id,
  amount,
  source: direction === "IN" ? "outside-in" : `account:${account}`,
  target: direction === "IN" ? `account:${account}` : "outside-out",
}));
const report = {
  groups: [
    { id: 1, name: "甲组" },
    { id: 2, name: "乙组" },
  ],
  endpoints,
  flows,
  summary: {
    key: "total",
    name: "全部",
    incoming: 2100,
    outgoing: 1200,
    incoming_flow_ids: ["2", "4", "6"],
    outgoing_flow_ids: ["1", "3", "5"],
  },
};
(async () => {
  await periods();
  attention();
  let pairs = layout(report);
  if (process.argv[2])
    pairs += layout(JSON.parse(fs.readFileSync(process.argv[2])));
  console.log(
    `Common periods/races, attention navigation/transfers and ${pairs} non-crossing Sankey edge pairs passed.`,
  );
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
