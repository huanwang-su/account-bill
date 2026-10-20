const assert = require("node:assert/strict");
const path = require("node:path");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const echarts = require("echarts");
const { loadTs } = require("./source-loader.cjs");
const source = (name) => loadTs(path.resolve(__dirname, "../src", name));
const { CounterpartyMovementChart } = source("CounterpartyMovementChart.tsx");
const { SingleAccountWorkspace } = source("SingleAccountWorkspace.tsx");
const { SingleAccountDrilldown } = source("SingleAccountDrilldown.ts");
const { ChartAmountPrivacy } = source("ChartAmountPrivacy.ts");
const { Chart } = source("Chart.tsx");

function elements(tree, result = []) {
  if (Array.isArray(tree)) tree.forEach((child) => elements(child, result));
  else if (React.isValidElement(tree)) {
    result.push(tree);
    for (const value of Object.values(tree.props))
      if (React.isValidElement(value) || Array.isArray(value)) elements(value, result);
  }
  return result;
}
function instance(Component, props, patch = {}) {
  const value = new Component(props);
  value.state = { ...value.state, ...patch };
  value.setState = (next, done) => {
    value.state = { ...value.state, ...(typeof next === "function" ? next(value.state) : next) };
    done?.();
  };
  return value;
}
const transaction = (id, change, kind) => ({ id, account_change: change, kind, occurred_at: "2026-10-02 12:00:00" });
const group = (key, name, transactions) => {
  const incoming = transactions.reduce((sum, row) => sum + Math.max(0, row.account_change), 0);
  const outgoing = transactions.reduce((sum, row) => sum + Math.max(0, -row.account_change), 0);
  return { key, counterparty: name, transactions, incoming, outgoing, net: incoming - outgoing, count: transactions.length };
};
const parties = [
  group("party:a", "同名交易方", [transaction(1, 3000, "INCOME"), transaction(2, 500, "REFUND"), transaction(3, -1500, "TRANSFER")]),
  group("party:b", "同名交易方", [transaction(4, 1000, "INCOME"), transaction(5, -6000, "EXPENSE")]),
  group("party:c", "<第三方>", [transaction(6, 9000, "TRANSFER")]),
];
const valuation = transaction(7, 999999, "INCOME");
valuation.purpose = "VALUATION";
const account = {
  id: 42, name: "分析账户", analysis_mode: "both", categories: [],
  counterparties: { parties, valuations: [group("valuation:c", "估值", [valuation])] },
  transactions: [...parties.flatMap((row) => row.transactions), valuation, transaction(8, 100000, "OPENING")],
};
const original = JSON.stringify(account);
let selected;
const chart = instance(CounterpartyMovementChart, { account, loading: false, onSelect: (scope) => { selected = scope; } });
const keys = () => chart.ranked().map((row) => row.key);
assert.deepEqual(keys(), ["party:c", "party:b", "party:a"]);
for (const [metric, order, expected] of [
  ["incoming", "desc", ["c", "a", "b"]],
  ["outgoing", "desc", ["b", "a", "c"]],
  ["net", "asc", ["b", "a", "c"]],
  ["net", "desc", ["c", "a", "b"]],
  ["count", "desc", ["a", "b", "c"]],
  ["gross", "asc", ["a", "b", "c"]],
]) {
  chart.setState({ metric, order });
  assert.deepEqual(keys(), expected.map((key) => "party:" + key));
}
const controls = elements(chart.render());
controls.find((element) => element.props["aria-label"] === "交易方收付图排序指标").props.onChange("incoming");
controls.find((element) => element.props["aria-label"] === "交易方收付图排序方向").props.onChange("desc");
assert.deepEqual(keys(), ["party:c", "party:a", "party:b"]);
const option = chart.option(chart.ranked());
assert.equal(option.grid.length, 3);
assert.equal(option.xAxis[0].inverse, true, "Receipts extend to the left");
assert.equal(option.xAxis[1].inverse, false, "Payments extend to the right");
assert.equal(option.xAxis[0].max, option.xAxis[1].max, "Receipts and payments use the same scale");
assert.ok(option.xAxis[2].min < 0 && option.xAxis[2].max > 0);
for (const axis of option.yAxis) assert.deepEqual(axis.data, keys());
assert.deepEqual(option.series.map((series) => series.data.map((row) => row.value)), [[90, 35, 10], [0, 15, 60], [90, 20, -50]]);
assert.deepEqual(option.series.map((series) => [series.xAxisIndex, series.yAxisIndex]), [[0, 0], [1, 1], [2, 2]]);
assert.deepEqual(option.series[0].data.map((row) => row.partyKey), keys());
assert.equal(option.yAxis[0].axisLabel.formatter("party:a"), "同名交易方");
assert.equal(option.series[2].data[1].label.formatter(), "+20.00");
assert.equal(option.series[2].data[2].label.formatter(), "-50.00");
const tooltip = option.tooltip.formatter([{ data: { partyKey: "party:a" } }]);
assert.ok(tooltip.includes("35.00") && tooltip.includes("15.00") && tooltip.includes("20.00"));
const masked = ChartAmountPrivacy.option(option, true);
assert.ok(!masked.tooltip.formatter([{ data: option.series[0].data[1], seriesName: "收款" }]).includes("35.00"));
assert.ok(masked.tooltip.formatter([{ data: option.series[0].data[1] }]).includes("****"));
assert.deepEqual(masked.series[0].data.map((row) => row.partyKey), keys());
assert.ok(!masked.series[2].data[1].label.formatter({ data: option.series[2].data[1] }).includes("20.00"));
const incomingClick = { componentType: "series", seriesName: "收款", data: { partyKey: "party:a" } };
const outgoingClick = { componentType: "series", seriesName: "付款", data: { partyKey: "party:a" } };
const incoming = chart.selection(incomingClick);
assert.deepEqual(SingleAccountDrilldown.rows(account, incoming).map((row) => row.id), [1, 2]);
assert.deepEqual(SingleAccountDrilldown.rows(account, chart.selection(outgoingClick)).map((row) => row.id), [3]);
const netClick = { componentType: "series", seriesName: "净额", data: { partyKey: "party:a" } };
assert.deepEqual(SingleAccountDrilldown.rows(account, chart.selection(netClick)).map((row) => row.id), [1, 2, 3]);
assert.deepEqual(SingleAccountDrilldown.rows(account, chart.selection({ ...netClick, data: { partyKey: "party:b" } })).map((row) => row.id), [4, 5]);
const nameSelection = chart.selection({ componentType: "yAxis", targetType: "axisLabel", value: "party:b" });
assert.deepEqual(SingleAccountDrilldown.rows(account, nameSelection).map((row) => row.id), [4, 5]);
assert.equal(chart.selection({ componentType: "legend" }), undefined);
assert.equal(chart.selection({ ...incomingClick, data: { partyKey: "unknown" } }), undefined);
elements(chart.render()).find((element) => element.type === Chart).props.onClick(incomingClick);
assert.deepEqual(selected, incoming);
selected = undefined;
const loading = instance(CounterpartyMovementChart, { ...chart.props, loading: true });
elements(loading.render()).find((element) => element.type === Chart).props.onClick(incomingClick);
assert.equal(selected, undefined);
assert.ok(elements(loading.render()).filter((element) => element.props["aria-label"]?.startsWith("交易方收付图排序")).every((element) => element.props.disabled));
const many = Array.from({ length: 26 }, (_, index) => group(`party:${index}`, `交易方${index}`, [transaction(100 + index, (index + 1) * 100, "INCOME")]));
const large = instance(CounterpartyMovementChart, { ...chart.props, account: { ...account, counterparties: { parties: many } } });
const largeOption = large.option(large.ranked());
assert.ok(largeOption.yAxis.every((axis) => axis.data.length === 26));
assert.equal(largeOption.series[0].data.length, 26);
assert.equal(largeOption.dataZoom[0].endValue, 9);
assert.ok(largeOption.dataZoom.every((zoom) => JSON.stringify(zoom.yAxisIndex) === "[0,1,2]"));
assert.equal(largeOption.series[0].data.reduce((sum, row) => sum + row.value, 0), 351);
const svgChart = echarts.init(null, null, { renderer: "svg", ssr: true, width: 900, height: 520 });
svgChart.setOption(largeOption);
const svg = svgChart.renderToSVGString();
assert.ok(svg.includes("交易方25") && svg.includes("收款") && svg.includes("付款"));
assert.ok(svg.includes("净额"));
svgChart.dispatchAction({ type: "dataZoom", dataZoomIndex: 0, startValue: 10, endValue: 19 });
const extents = [0, 1, 2].map((index) => svgChart.getModel().getComponent("yAxis", index).axis.scale.getExtent());
assert.deepEqual(extents, [[10, 19], [10, 19], [10, 19]], "All three columns scroll together");
svgChart.dispose();
const zeroParty = group("party:zero", "收付相抵", [transaction(9, 1000, "INCOME"), transaction(10, -1000, "EXPENSE")]);
const zeroOption = chart.option([zeroParty]);
assert.equal(zeroOption.series[2].data[0].value, 0);
assert.equal(zeroOption.series[2].data[0].label.formatter(), "0.00");
assert.ok(zeroOption.xAxis[2].max > zeroOption.xAxis[2].min);
const empty = instance(CounterpartyMovementChart, { ...chart.props, account: { ...account, counterparties: { parties: [] } } });
assert.ok(renderToStaticMarkup(empty.render()).includes("当前区间没有交易方往来"));
assert.equal(JSON.stringify(account), original, "Sorting and clicks must preserve report and ledger amounts");
const workspace = instance(SingleAccountWorkspace, { refreshKey: "test", onConfigure() {}, onDetail() {} }, {
  loading: false, selected: "42", report: { accounts: [account] },
});
const integrated = elements(workspace.renderCounterparties(account, "test")).find((element) => element.type === CounterpartyMovementChart);
integrated.props.onSelect(incoming);
assert.equal(workspace.state.analysisTab, "parties");
assert.deepEqual(workspace.detailScope("parties"), incoming);
const pickerAccount = { ...account, is_followed: true, ending_balance: 123, change: 0, count: 6 };
workspace.state.report.accounts = [pickerAccount];
workspace.renderAccount = () => null;
assert.ok(renderToStaticMarkup(workspace.render()).includes("关注"));
console.log("Counterparty chart direction totals, sorting, exact drill-down, privacy, scrolling, SVG rendering and integration passed.");
