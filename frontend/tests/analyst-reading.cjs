const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const React = require("react");
const server = require("react-dom/server");
const { loadTs } = require("./source-loader.cjs");
const src = path.resolve(__dirname, "../src");
const { OverviewReading } = loadTs(path.join(src, "OverviewReading.ts"));
const { OverviewWorkspace } = loadTs(path.join(src, "OverviewWorkspace.tsx"));
const { ReportDetailReading } = loadTs(
  path.join(src, "ReportDetailReading.ts"),
);

const fixture = {
  as_of: "2026-10-18",
  month_start: "2026-10-01",
  assets: 100000,
  liabilities: 125000,
  net_assets: -25000,
  account_count: 2,
  groups: [
    {
      id: 1,
      name: "家庭",
      assets: 100000,
      liabilities: 125000,
      net_assets: -25000,
    },
  ],
  household: {
    income: 2000,
    expense: 1500,
    net: 500,
    count: 3,
    average_daily: 83,
    refunds: 200,
    change: -500,
    previous_start: "2026-09-13",
    previous_end: "2026-09-30",
    unknown_amount: 300,
    large_count: 0,
    frequent_count: 0,
    categories: [
      { id: 2, name: "退款抵减", amount: -1000 },
      { id: 1, name: "餐饮", amount: 1200 },
      { id: 3, name: "交通", amount: 300 },
    ],
    trend: [
      { day: "2026-10-01", expense: 1000 },
      { day: "2026-10-02", expense: -200 },
      { day: "2026-10-03", expense: 700 },
    ],
  },
  investments: {
    assets: 20000,
    profit: -500,
    account_count: 1,
    last_valuation: "2026-10-17 10:00:00",
  },
  pending_count: 2,
  recent: [
    {
      id: 1,
      kind: "EXPENSE",
      source: "证券余额更新",
      occurred_at: "2026-10-17 10:00:00",
      amount: 500,
    },
  ],
  last_activity: "2026-10-17 10:00:00",
  last_import: null,
};
const copy = JSON.stringify(fixture),
  reading = new OverviewReading(fixture);
assert.equal(reading.mainExpense.name, "餐饮");
assert.equal(reading.comparison.previous, 2000);
assert.match(reading.comparison.value, /减少.*5\.00/);
assert.equal(reading.liabilityRatio, "125.0%");
assert.equal(reading.investmentShare, "20.0%");
assert.deepEqual(
  reading.trend.map((r) => r.cumulative),
  [1000, 800, 1500],
);
assert.equal(JSON.stringify(fixture), copy);

const empty = {
  ...fixture,
  assets: 0,
  liabilities: 0,
  investments: { ...fixture.investments, assets: 0 },
  household: {
    ...fixture.household,
    income: 0,
    expense: 0,
    net: 0,
    count: 0,
    refunds: 0,
    change: 0,
    categories: [],
    trend: [],
  },
};
assert.match(new OverviewReading(empty).headline, /尚无生活收支记录/);
assert.equal(new OverviewReading(empty).liabilityRatio, undefined);
assert.equal(new OverviewReading(empty).investmentShare, undefined);
assert.match(new OverviewReading(empty).comparison.value, /暂不比较/);
const refunds = {
  ...fixture,
  household: {
    ...fixture.household,
    expense: -100,
    income: 0,
    net: 100,
    refunds: 500,
    change: -50,
  },
};
assert.match(new OverviewReading(refunds).headline, /退款抵减超过付款/);
assert.match(new OverviewReading(refunds).comparison.value, /暂不比较/);
assert.equal(
  new OverviewReading({
    ...fixture,
    investments: { ...fixture.investments, assets: 200000 },
  }).investmentShare,
  undefined,
);

function find(element, predicate, results = []) {
  if (!React.isValidElement(element)) return results;
  if (predicate(element)) results.push(element);
  React.Children.forEach(element.props.children, (child) =>
    find(child, predicate, results),
  );
  React.Children.forEach(element.props.extra, (child) =>
    find(child, predicate, results),
  );
  return results;
}
function workspace(data) {
  const calls = [];
  const w = new OverviewWorkspace({
    refreshKey: "test",
    onReport: (tab) => calls.push(tab),
    onAccounts: () => calls.push("accounts"),
    onPending: () => calls.push("pending"),
    onImport: () => {},
    onDetail: () => {},
  });
  w.state = { ...w.state, data, loading: false };
  w.setState = (patch, callback) => {
    w.state = {
      ...w.state,
      ...(typeof patch === "function" ? patch(w.state) : patch),
    };
    callback?.();
  };
  return { w, calls };
}
const { w, calls } = workspace(fixture);
const daily = find(
  w.render(),
  (e) => e.props.label === "总览本月每日净开支",
)[0];
assert.deepEqual(
  daily.props.option.series[0].data.map((row) => row.value),
  [10, -2, 7],
);
const toggle = find(
  w.render(),
  (e) => e.props["aria-label"] === "总览开支趋势展示方式",
)[0];
toggle.props.onChange("cumulative");
const cumulative = find(
  w.render(),
  (e) => e.props.label === "总览本月累计净开支",
)[0];
assert.deepEqual(
  cumulative.props.option.series[0].data.map((row) => row.value),
  [10, 8, 15],
);
assert.equal(cumulative.props.option.yAxis.name, "元");
assert.equal(daily.props.option.series[0].type, "line");
assert.equal(cumulative.props.option.series[0].type, "line");
for (const data of [fixture, empty, refunds]) {
  const html = server.renderToStaticMarkup(workspace(data).w.render());
  assert.ok(
    !html.includes("本月看点") &&
      html.includes("本月家庭开支") &&
      html.includes("最近账务动态"),
  );
  assert.ok(!/NaN|Infinity/.test(html));
  assert.equal((html.match(/class="analysis-readout(?: |")/g) || []).length, 0);
}
const html = server.renderToStaticMarkup(w.render());
assert.ok(html.includes("已扣除独立退款") && !html.includes("另减独立退款"));
assert.ok(html.includes("证券估值亏损"));

const rows = [
  { id: 1, kind: "EXPENSE", amount: 1000 },
  { id: 2, kind: "REFUND", amount: 200 },
  { id: 3, kind: "TRANSFER", amount: 10000 },
  { id: 4, kind: "EXPENSE", amount: 500, source: "证券余额更新" },
];
const summary = {
  income: 0,
  expense: 1300,
  net: -1300,
  categories: [
    { id: 1, name: "餐饮", value: 1000 },
    { id: 2, name: "退款", value: -1500 },
    { id: 3, name: "零", value: 0 },
  ],
};
const frozen = JSON.stringify({ rows, summary }),
  details = new ReportDetailReading(summary, rows);
assert.equal(details.refunds, 200);
assert.equal(details.count("TRANSFER"), 1);
assert.equal(details.valuationCount, 1);
assert.deepEqual(
  details.categoriesByImpact.map((c) => c.id),
  [2, 1],
);
assert.equal(JSON.stringify({ rows, summary }), frozen);
console.log(
  "Overview stock/flow reading, zero/negative safeguards, daily/cumulative charts and refund wording passed.",
);
console.log(
  "Filtered detail refunds, valuation inclusion and signed category impact passed.",
);
if (process.argv[2]) {
  const bundle = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  const data = bundle.overview;
  if (data) {
    const actual = workspace(data).w;
    for (const view of ["daily", "cumulative"]) {
      actual.state.trendView = view;
      fs.writeFileSync(
        path.join(
          path.dirname(process.argv[2]),
          `overview-${view}-reading.html`,
        ),
        server.renderToStaticMarkup(actual.render()),
      );
    }
    const trend = new OverviewReading(data).trend;
    if (trend.length)
      assert.equal(trend.at(-1).cumulative, data.household.expense);
    console.log(
      "Current overview fixture reconciles daily and cumulative expense.",
    );
  }
}
