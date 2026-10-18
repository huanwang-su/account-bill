const assert = require("node:assert/strict");
const path = require("node:path");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { loadTs } = require("./source-loader.cjs");
const source = (name) => loadTs(path.resolve(__dirname, "../src", name));
const { InvestmentWorkspace } = source("InvestmentWorkspace.tsx");
const { CounterpartyWorkspace } = source("CounterpartyWorkspace.tsx");
const { Chart } = source("Chart.tsx");
const { PagedTable } = source("PagedTable.tsx");
const { AnalysisDrilldownBar } = source("AnalysisDrilldown.tsx");
const { Drawer } = require("antd");

function instance(Component, props, patch = {}) {
  const value = new Component(props);
  value.state = { ...value.state, ...patch };
  value.setState = (update, done) => {
    value.state = {
      ...value.state,
      ...(typeof update === "function" ? update(value.state, value.props) : update),
    };
    done?.();
  };
  value.api.request = () => assert.fail("Synthetic tests must not call the server");
  value.api.transaction = () => assert.fail("Synthetic tests must not read transactions");
  return value;
}
function elements(tree) {
  if (Array.isArray(tree)) return tree.flatMap(elements);
  if (!React.isValidElement(tree)) return [];
  return [tree, ...elements(tree.props.children), ...elements(tree.props.items?.map((item) => item.children))];
}
function chart(tree, label) {
  const result = elements(tree).find((node) => node.type === Chart && node.props.label === label);
  assert.ok(result, label);
  assert.equal(typeof result.props.onClick, "function", label + " has an action");
  return result;
}
function click(chart, series, index, patch = {}) {
  const option = chart.props.option;
  const item = option.series[series];
  chart.props.onClick({
    componentType: "series",
    seriesId: item.id,
    seriesName: item.name,
    name: (option.xAxis.type === "category" ? option.xAxis.data : option.yAxis.data)[index],
    data: item.data[index],
    dataIndex: 999, // Stable identifiers, rather than the array position, select the detail.
    ...patch,
  });
}
const commonProps = { refreshKey: "test", onDetail() {}, onUpdate() {}, onAccounts() {}, onValuation() {} };
const zeroMetrics = {
  gain: 0, loss: 0, ending: 0, profit: 0, beginning: 0, capital_net: 0,
  capital_in: 0, capital_out: 0, internal_net: 0, valuation_profit: 0,
  other_profit: 0, opening_added: 0, asset_profit: 0, other_changes: 0,
  active: true, kind: "证券", role: "ASSET",
};
const accounts = [
  { ...zeroMetrics, id: 1, name: "同名账户", group_id: 4 },
  { ...zeroMetrics, id: 2, name: "同名账户", group_id: 5 },
];
const investmentReport = {
  ...zeroMetrics, start: "2026-09-10", end: "2026-10-18", accounts,
  account_count: 2, asset_account_count: 2, reconciled: true, missing_opening_ids: [],
  trend: [
    { period: "2026-09", profit: 300, cumulative_profit: 300, assets: 1000 },
    { period: "2026-10", profit: -100, cumulative_profit: 200, assets: 900 },
  ],
  profits: [
    { id: 10, occurred_at: "2026-09-12", amount: 300, account_names: ["同名账户"] },
    { id: 11, occurred_at: "2026-10-12", amount: -100, account_names: ["同名账户"] },
  ],
  transfers: [],
};
const filters = { start: investmentReport.start, end: investmentReport.end, group_id: 4, category_id: 99 };

async function verify() {
  const investment = instance(InvestmentWorkspace, { ...commonProps, accounts, groups: [] }, {
    report: investmentReport, filters, loading: false,
  });
  const scopeBefore = JSON.stringify(investment.state.filters);
  const main = chart(investment.render(), "理财收益趋势");
  click(main, 0, 0);
  assert.deepEqual(investment.state.drillPeriod, {
    start: "2026-09-10", end: "2026-09-30", label: "2026-09-10 至 2026-09-30",
  });
  let profitTable = elements(investment.renderDrilldown()).find((node) => node.type === PagedTable && node.props.dataSource.some((row) => row.id === 10));
  assert.deepEqual(profitTable.props.dataSource.map((row) => row.id), [10]);
  click(main, 0, 1);
  assert.equal(investment.state.drillPeriod.start, "2026-10-01");
  assert.equal(investment.state.drillPeriod.end, "2026-10-18");
  assert.equal(JSON.stringify(investment.state.filters), scopeBefore);
  investment.closeDrilldown();
  main.props.onClick({ componentType: "series", dataIndex: 0, name: "not-a-period" });
  assert.equal(investment.state.drilldown, undefined);
  investment.state.loading = true;
  click(main, 0, 0);
  assert.equal(investment.state.drilldown, undefined);
  investment.state.loading = false;

  const accountReport = {
    ...investmentReport, account_id: 2, accounts: [accounts[1]],
    trend: [
      { period: "2026-09-12", profit: 300, assets: 1000 },
      { period: "2026-10-12", profit: -100, assets: 900 },
    ],
  };
  investment.state.grain = "day";
  const requests = [];
  investment.api.request = async (url) => { requests.push(url); return accountReport; };
  investment.openDrilldown(investment.accountSelection(accounts[1]));
  await Promise.resolve();
  assert.equal(investment.state.drillReport.account_id, 2);
  const query = new URLSearchParams(requests[0].split("?")[1]);
  assert.equal(query.get("account_id"), "2");
  assert.equal(query.get("category_id"), "99");
  assert.equal(query.get("group_id"), "4");
  assert.equal(query.get("start"), investmentReport.start);
  assert.equal(query.get("end"), investmentReport.end);
  const drawerChart = chart(investment.renderDrilldown(), "账户盈亏趋势，点击查看该期明细");
  click(drawerChart, 0, 1);
  assert.equal(investment.state.drillPeriod.start, "2026-10-12");
  assert.equal(investment.state.drilldown.account_id, 2);
  assert.equal(investment.state.drillTab, "profit");
  assert.ok(renderToStaticMarkup(investment.renderDrilldown()).includes("2026-10-12"));
  investment.closeDrilldown();
  click(drawerChart, 0, 0);
  assert.equal(investment.state.drilldown, undefined, "A closed drawer's stale chart cannot select a period");
  assert.equal(investment.state.drillPeriod, undefined);
  investment.load = async () => {};
  investment.changeScope({ grain: "month" });
  click(main, 0, 0);
  assert.equal(investment.state.drilldown, undefined, "Old charts cannot reopen after the report scope changes");

  const movement = (id, day, amount, kind = amount > 0 ? "INCOME" : "EXPENSE") => ({
    id, occurred_at: day + " 12:00:00", account_change: amount, kind, note: "示例", source: "手工",
  });
  const party = (key, transactions, valuation = false) => ({
    key, counterparty: "同名交易方", valuation, transactions,
    incoming: transactions.reduce((sum, row) => sum + Math.max(0, row.account_change), 0),
    outgoing: transactions.reduce((sum, row) => sum + Math.max(0, -row.account_change), 0),
    net: transactions.reduce((sum, row) => sum + row.account_change, 0),
    count: transactions.length, first_at: "2026-10-10", last_at: "2026-10-11",
  });
  const first = party("party:first", [movement(1, "2026-10-10", 100), movement(2, "2026-10-10", -200), movement(3, "2026-10-11", 50, "REFUND")]);
  const second = party("party:second", [movement(4, "2026-10-10", -400, "TRANSFER"), movement(5, "2026-10-11", 500, "TRANSFER")]);
  const valuation = party("valuation:first", [movement(6, "2026-10-10", 600), movement(7, "2026-10-10", -700)], true);
  const partyReport = {
    account_id: 1, account_name: "示例账户", parties: [first, second], valuations: [valuation],
    incoming: 650, outgoing: 600, net: 50, party_count: 2, count: 5,
    valuation_gain: 600, valuation_loss: 700, valuation_net: -100,
  };
  const counter = instance(CounterpartyWorkspace, { ...commonProps, accounts, initialAccountId: 1 }, {
    report: partyReport, loading: false, filters: { start: "2026-10-10", end: "2026-10-11", q: "同名" },
  });
  const originalScope = JSON.stringify(counter.state.filters);
  for (const target of [first, second]) {
    for (const [seriesIndex, direction] of [[0, "incoming"], [1, "outgoing"]]) {
      const rank = chart(counter.render(), "交易方收付规模排行");
      const index = rank.props.option.yAxis.data.indexOf(target.key);
      click(rank, seriesIndex, index);
      assert.equal(counter.state.selected, target, "Equal display names retain distinct party keys");
      assert.equal(counter.state.selectedDirection, direction);
      assert.deepEqual(counter.selectedRows().map((row) => row.id), target.transactions.filter((row) => direction === "incoming" ? row.account_change > 0 : row.account_change < 0).map((row) => row.id));
    }
  }
  const ranking = chart(counter.render(), "交易方收付规模排行");
  ranking.props.onClick({ componentType: "yAxis", value: first.key });
  assert.equal(counter.state.selectedDirection, undefined, "Party label deliberately opens both directions");
  assert.deepEqual(counter.selectedRows().map((row) => row.id), [1, 2, 3]);
  for (const [seriesIndex, direction, ids] of [[0, "incoming", [1]], [1, "outgoing", [2, 4]]]) {
    const daily = chart(counter.render(), "交易方每日收付趋势");
    click(daily, seriesIndex, 0);
    assert.equal(counter.state.selected.aggregate, true);
    assert.equal(counter.state.selectedDay, "2026-10-10");
    assert.equal(counter.state.selectedDirection, direction);
    assert.deepEqual(counter.selectedRows().map((row) => row.id).sort(), ids);
  }
  counter.openParty(first);
  for (const [seriesIndex, ids] of [[0, [1]], [1, [2]]]) {
    const daily = chart(counter.render(), "同名交易方每日收付");
    click(daily, seriesIndex, 0);
    assert.equal(counter.state.selected.key, first.key);
    assert.deepEqual(counter.selectedRows().map((row) => row.id), ids);
  }
  let body = elements(counter.render()).find((node) => node.type === Drawer).props.children;
  let bar = elements(body).find((node) => node.type === AnalysisDrilldownBar);
  assert.ok(bar.props.items.some((item) => item.key === "direction" && item.label === "仅付款"));
  assert.ok(renderToStaticMarkup(body).includes("仅付款"));
  bar.props.items.find((item) => item.key === "direction").onClear();
  assert.equal(counter.state.selectedDay, "2026-10-10");
  assert.deepEqual(counter.selectedRows().map((row) => row.id), [1, 2]);
  counter.openParty(valuation);
  for (const [seriesIndex, ids] of [[0, [6]], [1, [7]]]) {
    const daily = chart(counter.render(), "同名交易方每日估值盈亏");
    click(daily, seriesIndex, 0);
    assert.deepEqual(counter.selectedRows().map((row) => row.id), ids);
  }
  assert.equal(JSON.stringify(counter.state.filters), originalScope);
  const stale = chart(counter.render(), "同名交易方每日估值盈亏");
  counter.closeParty();
  click(stale, 0, 0);
  assert.equal(counter.state.selectedDay, undefined);
  assert.equal(counter.state.selectedDirection, undefined);
  ranking.props.onClick({ componentType: "series", name: "invalid", seriesId: "incoming", dataIndex: 0 });
  assert.equal(counter.state.selected, undefined, "A fake or stale index never chooses a party");
  counter.state.loading = true;
  click(ranking, 0, 0);
  assert.equal(counter.state.selected, undefined);
  counter.state.loading = false;
  const pending = [];
  counter.api.request = (url) => url.includes("/valuations") ? Promise.resolve([]) : new Promise((resolve) => pending.push(resolve));
  counter.openParty(first, "2026-10-10", "incoming");
  const loading = counter.load();
  assert.deepEqual(counter.selectedRows(), []);
  counter.closeParty();
  pending.shift()(partyReport);
  await loading;
  assert.equal(counter.state.selected, undefined, "A report that arrives after drawer close cannot reopen it");

  const deferred = [];
  investment.load = InvestmentWorkspace.prototype.load;
  investment.state.loading = false;
  investment.state.report = investmentReport;
  investment.api.request = () => new Promise((resolve) => deferred.push(resolve));
  investment.openDrilldown(investment.accountSelection(accounts[0]));
  investment.openDrilldown(investment.accountSelection(accounts[1]));
  deferred[0]({ ...accountReport, account_id: 1 });
  await Promise.resolve();
  assert.equal(investment.state.drillReport, undefined);
  investment.closeDrilldown();
  deferred[1](accountReport);
  await Promise.resolve();
  assert.equal(investment.state.drillReport, undefined);

  counter.state.report = { ...partyReport, parties: [], valuations: [] };
  counter.state.selected = undefined;
  assert.ok(renderToStaticMarkup(counter.render()).includes("当前条件没有交易方往来"));
  console.log("Investment and counterparty bars passed: exact periods, stable identities, direction, scope, loading, stale events, late responses, close behavior, empty data and SSR.");
}
verify().catch((error) => { console.error(error); process.exitCode = 1; });
