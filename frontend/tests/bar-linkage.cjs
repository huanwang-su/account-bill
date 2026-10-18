const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { loadTs } = require("./source-loader.cjs");
const src = path.resolve(__dirname, "../src");
const source = (name) => loadTs(path.join(src, name));
const { Chart } = source("Chart.tsx");
const { PagedTable } = source("PagedTable.tsx");
const { OverviewWorkspace } = source("OverviewWorkspace.tsx");
const { ExpenseWorkspace } = source("ExpenseWorkspace.tsx");
const { FinancialAnalysisWorkspace } = source("FinancialAnalysisWorkspace.tsx");
const { InvestmentWorkspace } = source("InvestmentWorkspace.tsx");
const { CounterpartyWorkspace } = source("CounterpartyWorkspace.tsx");
const { ReportCharts } = source("ReportCharts.tsx");

// Execute real callbacks from the components' returned Chart elements. Nothing
// mounts a browser, starts the application, or reaches the user's ledger.
const originalFetch = global.fetch;
global.fetch = () => assert.fail("Bar linkage tests must never access a service");
const covered = new Set();
function instance(Component, props, state = {}) {
  const value = new Component(props);
  value.state = { ...value.state, ...state };
  value.setState = (patch, done) => {
    value.state = {
      ...value.state,
      ...(typeof patch === "function" ? patch(value.state, value.props) : patch),
    };
    done?.();
  };
  if (value.api) value.api.request = () => assert.fail("Unexpected report query");
  return value;
}
function elements(value, found = [], visited = new Set()) {
  if (!value || typeof value !== "object" || visited.has(value)) return found;
  visited.add(value);
  if (React.isValidElement(value)) {
    found.push(value);
    elements(value.props, found, visited);
  } else if (Array.isArray(value)) {
    value.forEach((item) => elements(item, found, visited));
  } else {
    Object.values(value).forEach((item) => elements(item, found, visited));
  }
  return found;
}
function chart(tree, label) {
  const matches = elements(tree).filter(
    (node) => node.type === Chart && node.props.label === label,
  );
  assert.equal(matches.length, 1, `Expected exactly one chart: ${label}`);
  assert.equal(typeof matches[0].props.onClick, "function", `${label} is clickable`);
  return matches[0];
}
function click(node, seriesIndex, dataIndex, coverage, patch = {}) {
  const option = node.props.option;
  const series = option.series[seriesIndex];
  const axis = option.xAxis?.type === "category" ? option.xAxis : option.yAxis;
  if (coverage) {
    assert.equal(series.type, "bar", coverage);
    covered.add(coverage);
  }
  const data = series.data[dataIndex];
  return node.props.onClick({
    componentType: "series",
    seriesType: series.type,
    seriesIndex,
    seriesName: series.name,
    seriesId: series.id,
    dataIndex,
    name: axis?.data?.[dataIndex],
    data,
    value: typeof data === "object" ? data.value : data,
    ...patch,
  });
}
function tableRows(tree, className) {
  const tables = elements(tree).filter(
    (node) => node.type === PagedTable && (!className || node.props.className?.includes(className)),
  );
  assert.equal(tables.length, 1, `Expected one detail table: ${className || "all"}`);
  return tables[0].props.dataSource;
}
const ids = (rows) => rows.map((row) => row.id);
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
function freeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
const noop = () => {};
const groups = freeze([
  { id: 1, name: "同名组", parent_id: null },
  { id: 2, name: "同名组", parent_id: 1 },
]);
const accounts = freeze([
  { id: 11, name: "生活账户", role: "ASSET", kind: "银行", group_id: 1, active: true },
  { id: 12, name: "子组账户", role: "ASSET", kind: "银行", group_id: 2, active: true },
  { id: 21, name: "证券账户", role: "ASSET", kind: "证券", group_id: 1, active: true },
  { id: 13, name: "未分组账户", role: "ASSET", kind: "银行", group_id: null, active: true },
]);
const props = {
  accounts, groups, categories: [], tags: [], refreshKey: "synthetic",
  onDetail: noop, onReport: noop, onAccounts: noop, onPending: noop,
  onImport: noop, onUpdate: noop, onConfigure: noop, onValuation: noop,
};
const transaction = (id, kind, occurred_at, amount, extra = {}) => ({
  id, kind, occurred_at, amount, account_change: kind === "EXPENSE" ? -amount : amount,
  counterparty: "同名交易方", category_names: ["同名分类"], note: "测试记录", ...extra,
});
const expenseRows = freeze([
  transaction(101, "EXPENSE", "2026-10-07 00:00:00", 1000),
  transaction(102, "REFUND", "2026-10-07 23:59:59", 1800),
  transaction(103, "EXPENSE", "2026-10-08 00:00:00", 400),
]);

async function overviewLines() {
  const data = freeze({
    as_of: "2026-10-18", month_start: "2026-10-01", assets: 1500, liabilities: 200,
    net_assets: 1300, account_count: 3, pending_count: 0, recent: [],
    household: {
      income: 0, expense: -400, net: 400, paid: 1400, refunds: 1800, count: 2,
      change: 0, average_daily: 0, unknown_amount: 0, large_count: 0, frequent_count: 0,
      previous_start: "2026-09-13", previous_end: "2026-09-30", categories: [],
      trend: [{ day: "2026-10-07", expense: -800 }, { day: "2026-10-08", expense: 400 }],
    },
    investments: { assets: 0, profit: 0, capital_net: 0 },
    groups: [
      { id: 1, name: "同名组", assets: 1000, liabilities: 150, net_assets: 850 },
      { id: 2, name: "同名组", assets: 400, liabilities: 50, net_assets: 350 },
      { id: null, name: "未分组", assets: 100, liabilities: 0, net_assets: 100 },
    ],
  });
  const opened = [];
  const page = instance(OverviewWorkspace, { ...props, onDetail: (row) => opened.push(row) }, { data, loading: false });
  const requests = [];
  page.api.request = async (url) => {
    requests.push(url);
    const query = new URL(url, "http://synthetic.invalid").searchParams;
    assert.equal(query.get("as_of"), data.as_of);
    assert.ok(url.startsWith("/reports/overview/details?"));
    if (query.get("section") === "expense") {
      const cumulative = query.get("cumulative") === "true";
      const rows = expenseRows.filter((row) => cumulative
        ? row.occurred_at.slice(0, 10) <= query.get("day")
        : row.occurred_at.slice(0, 10) === query.get("day"));
      return { as_of: data.as_of, transactions: rows, count: rows.length, amount: rows.reduce((sum, row) => sum + row.amount * (row.kind === "REFUND" ? -1 : 1), 0) };
    }
    const groupId = Number(query.get("group_id"));
    const balances = { 11: [600, 100], 12: [400, 50], 21: [400, 50], 13: [100, 0] };
    const rows = accounts.filter((row) => (row.group_id ?? 0) === groupId)
      .map((row) => ({ ...row, analysis_amount: balances[row.id][query.get("section") === "assets" ? 0 : 1] }))
      .filter((row) => row.analysis_amount !== 0);
    return { as_of: data.as_of, accounts: rows, count: rows.length, amount: rows.reduce((sum, row) => sum + row.analysis_amount, 0) };
  };
  const daily = chart(page.render(), "总览本月每日净开支");
  await click(daily, 0, 0, undefined, { dataIndex: 99, name: "wrong-display-date" });
  await flush();
  assert.equal(page.state.chartSelection.day, "2026-10-07");
  assert.equal(page.state.chartSelection.cumulative, false);
  assert.deepEqual(ids(tableRows(page.renderChartDetails())), [101, 102]);
  assert.equal(page.state.chartDetail.amount, -800, "A negative day retains both payment and refund");
  page.api.transaction = async (id) => expenseRows.find((row) => row.id === id);
  const dailyTable = elements(page.renderChartDetails()).find((node) => node.type === PagedTable);
  await dailyTable.props.columns.find((column) => column.title === "操作").render(undefined, expenseRows[0]).props.onClick();
  assert.equal(opened[0], expenseRows[0], "Overview detail actions open the full original transaction");
  page.state.trendView = "cumulative";
  const cumulative = chart(page.render(), "总览本月累计净开支");
  await click(cumulative, 0, 1);
  await flush();
  assert.equal(page.state.chartSelection.day, "2026-10-08");
  assert.equal(page.state.chartSelection.cumulative, true);
  assert.deepEqual(ids(tableRows(page.renderChartDetails())), [101, 102, 103]);
  assert.equal(page.state.chartDetail.amount, cumulative.props.option.series[0].data[1].value * 100);
  assert.equal(page.state.data, data, "Detail clicks retain the overview snapshot");
  const before = requests.length;
  await daily.props.onClick({ data: { day: "2026-09-07" }, dataIndex: 0 });
  assert.equal(requests.length, before, "Invalid payloads never fall back to an index");
  page.state.loading = true;
  await click(cumulative, 0, 0);
  assert.equal(requests.length, before, "Loading curves cannot broaden an old scope");
  page.state.loading = false;
  page.state.data = { ...data, as_of: "2026-11-18" };
  await click(daily, 0, 0);
  assert.equal(requests.length, before, "Callbacks from replaced snapshots are inert");
  page.state.data = data;
  const pending = [];
  page.api.request = () => new Promise((done) => { pending.push(done); });
  click(cumulative, 0, 0);
  click(cumulative, 0, 1);
  pending.shift()({ transactions: [{ id: 999 }], amount: 1, count: 1 });
  await flush();
  assert.equal(page.state.chartDetail, undefined, "A late prior column cannot replace the latest selection");
  pending.shift()({ transactions: [{ id: 12 }], amount: 50, count: 1 });
  await flush();
  assert.deepEqual(ids(tableRows(page.renderChartDetails())), [12]);
  click(cumulative, 0, 0);
  page.closeChart();
  pending.shift()({ transactions: [{ id: 999 }], amount: 1, count: 1 });
  await flush();
  assert.equal(page.state.chartDetail, undefined, "Closing invalidates in-flight detail reads");
  page.state.data = { ...data, groups: [], household: { ...data.household, trend: [] } };
  assert.equal(elements(page.render()).filter((node) => node.type === Chart && node.props.option.series.some((series) => series.type === "bar")).length, 0);
  assert.ok(renderToStaticMarkup(page.render()).includes("本月暂无家庭开支记录"));
}

function expenseBars() {
  const filters = freeze({ start: "2026-10-07", end: "2026-10-18", account_id: 11, group_id: 1, direct_group: true, category_id: 101, exact_category: true });
  const report = freeze({
    expense: -400, paid: 1400, refunds: 1800, average_daily: 0, days: 12, count: 2,
    change: 0, large_count: 0, large_amount_minor: 100000, parents: [],
    previous_start: "2026-09-25", previous_end: "2026-10-06", excluded_account_ids: [12],
    trend: [{ day: "2026-10-07", expense: -800 }, { day: "2026-10-08", expense: 400 }],
    group_categories: [], categories: [], merchants: [], large_transactions: [], transactions: expenseRows,
  });
  const page = instance(ExpenseWorkspace, props, { filters, report, loading: false, activeTab: "categories" });
  const trend = chart(page.render(), "每日家庭开支趋势");
  click(trend, 0, 0, "expense:daily", { dataIndex: 1, name: "10-08" });
  assert.deepEqual(page.state.detailPeriod, { start: "2026-10-07", end: "2026-10-07", label: "2026-10-07" });
  assert.deepEqual(ids(tableRows(page.renderPeriodDetails(report))), [101, 102]);
  assert.equal(page.state.filters, filters);
  assert.equal(page.state.report, report);
  assert.equal(page.state.activeTab, "categories");
  click(trend, 0, 1);
  assert.deepEqual(ids(tableRows(page.renderPeriodDetails(report))), [103]);
  const selected = page.state.detailPeriod;
  trend.props.onClick({ data: { day: "2026-09-07" }, dataIndex: 0 });
  assert.equal(page.state.detailPeriod, selected);
  page.state.loading = true;
  click(trend, 0, 0);
  assert.equal(page.state.detailPeriod, selected);
  page.state.loading = false;
  page.clearPeriod();
  assert.equal(page.state.detailPeriod, undefined);
  assert.deepEqual(ids(page.transactionTable(report.transactions).props.dataSource), [101, 102, 103]);
  page.state.report = { ...report };
  click(trend, 0, 0);
  assert.equal(page.state.detailPeriod, undefined, "An old expense chart cannot select a replacement report");
  page.state.report = { ...report, transactions: [], trend: [] };
  const empty = chart(page.render(), "每日家庭开支趋势");
  assert.deepEqual(empty.props.option.series[0].data, []);
  empty.props.onClick({ data: { day: "2026-10-07" }, dataIndex: 0 });
  assert.equal(page.state.detailPeriod, undefined);
}

function financialBars() {
  const opened = [];
  const rows = freeze([
    transaction(301, "INCOME", "2026-10-07 12:00:00", 500000, { direction: "INCOME" }),
    transaction(302, "EXPENSE", "2026-10-07 12:00:00", 400000, { direction: "EXPENSE" }),
    transaction(303, "REFUND", "2026-10-08 12:00:00", 300000, { direction: "EXPENSE" }),
  ]);
  const report = freeze({ large_transactions: rows, transactions: rows, large_amount_minor: 100000 });
  const filters = freeze({ start: "2026-10-06", end: "2026-10-18", account_id: 11, category_id: 101 });
  const page = instance(FinancialAnalysisWorkspace, { ...props, onDetail: (row) => opened.push(row) }, { filters, report, loading: false, activeTab: "large" });
  page.state.largeKind = "EXPENSE";
  let rank = chart(page.renderLargeAnalysis(report), "大额交易金额排名");
  for (let index = 0; index < 2; index++) {
    click(rank, 0, index, "financial:large", { dataIndex: 99, name: "同名交易方" });
    assert.equal(opened.at(-1), rows[index + 1], "Ranking opens the exact original transaction object");
  }
  assert.equal(page.state.filters, filters);
  assert.equal(page.state.report, report);
  assert.equal(page.state.activeTab, "large");
  rank.props.onClick({ data: { id: 999 }, dataIndex: 0 });
  assert.equal(opened.length, 2);
  page.state.largeKind = "INCOME";
  rank = chart(page.renderLargeAnalysis(report), "大额交易金额排名");
  rank.props.onClick({ data: { id: 302 }, dataIndex: 0 });
  assert.equal(opened.length, 2, "A synthetic ID cannot escape the local direction");
  click(rank, 0, 0);
  assert.equal(opened.at(-1), rows[0]);
  page.state.loading = true;
  click(rank, 0, 0);
  assert.equal(opened.length, 3);
  page.state.loading = false;
  page.state.report = { ...report };
  click(rank, 0, 0);
  assert.equal(opened.length, 3, "An old rank chart cannot open a replacement report");
  page.state.report = { ...report, large_transactions: [], transactions: [] };
  assert.ok(renderToStaticMarkup(page.renderLargeAnalysis(page.state.report)).includes("没有达到门槛的交易"));
}

function reportBars() {
  const opened = [];
  const rows = freeze([
    transaction(401, "INCOME", "2026-10-07 12:00:00", 5000),
    transaction(402, "EXPENSE", "2026-10-07 12:00:00", 1000, {
      entries: [{ category_id: 51, amount: 600 }, { category_id: 52, amount: 400 }],
    }),
    transaction(403, "REFUND", "2026-10-08 12:00:00", 800, {
      entries: [{ category_id: 51, amount: -800 }],
    }),
    transaction(404, "INCOME", "2026-10-08 12:00:00", 100, { source: "证券余额更新" }),
    transaction(405, "TRANSFER", "2026-10-08 12:00:00", 9999),
    transaction(406, "INCOME", "2026-09-30 23:59:59", 700),
    transaction(407, "EXPENSE", "2026-09-30 23:59:59", 200, { entries: [{ category_id: 52, amount: 200 }] }),
  ]);
  const summary = freeze({
    months: [{ month: "2026-09", income: 700, expense: 200 }, { month: "2026-10", income: 5100, expense: 200 }],
    categories: [{ id: 51, name: "同名分类", value: -200 }, { id: 52, name: "同名分类", value: 600 }],
  });
  const page = instance(ReportCharts, { summary, transactions: rows, scopeKey: "account=11&group=1&category=51&date=2026-09:2026-10", onDetail: (row) => opened.push(row) });
  const trend = chart(page.render(), "统计明细月度收入与净支出");
  for (let series = 0; series < 2; series++) {
    for (let index = 0; index < 2; index++) {
      click(trend, series, index, `report:${series === 0 ? "income" : "expense"}`, { dataIndex: 99, name: "wrong-month" });
      const detail = tableRows(page.renderDetails());
      const expected = series === 0 ? index === 0 ? [406] : [401, 404] : index === 0 ? [407] : [402, 403];
      assert.deepEqual(ids(detail), expected, "Monthly direction excludes adjacent months and transfers");
      const sum = detail.reduce((total, row) => total + row.analysis_amount, 0);
      assert.equal(sum, summary.months[index][series === 0 ? "income" : "expense"]);
    }
  }
  const category = chart(page.render(), "统计明细分类净额排行");
  for (let index = 0; index < 2; index++) {
    click(category, 0, index, "report:category", { dataIndex: 99, name: "同名分类" });
    const detail = tableRows(page.renderDetails());
    const selected = category.props.option.series[0].data[index];
    assert.equal(detail.reduce((sum, row) => sum + row.analysis_amount, 0), selected.value * 100);
    assert.deepEqual(ids(detail), selected.id === 51 ? [402, 403] : [402, 407]);
    const table = elements(page.renderDetails()).find((node) => node.type === PagedTable);
    const action = table.props.columns.find((column) => column.title === "操作").render(undefined, detail[0]);
    action.props.onClick();
    assert.equal(opened.at(-1), rows.find((row) => row.id === detail[0].id), "Detail opens the original unsplit transaction");
    assert.equal(detail[0].amount, rows.find((row) => row.id === detail[0].id).amount);
  }
  const selection = page.state.selection;
  category.props.onClick({ data: { id: 999 }, dataIndex: 0 });
  trend.props.onClick({ data: { month: "2026-10", direction: "transfer" }, dataIndex: 0 });
  assert.equal(page.state.selection, selection);
  page.open(405);
  assert.equal(opened.length, 2, "An original transaction outside the selected category cannot be opened");
  const oldProps = page.props;
  page.props = { ...page.props, loading: true };
  const loadingCategory = chart(page.render(), "统计明细分类净额排行");
  click(loadingCategory, 0, 0);
  page.open(402);
  assert.equal(page.state.selection, selection);
  assert.equal(opened.length, 2, "Pending report loads cannot open a stale original transaction");
  page.componentDidUpdate(oldProps);
  assert.equal(page.state.selection, undefined);
  page.props = oldProps;
  page.state.selection = selection;
  page.props = { ...page.props, scopeKey: "account=12" };
  click(category, 0, 0);
  assert.equal(page.state.selection, selection, "Old callbacks do not cross a new report scope");
  const previous = page.props;
  page.props = { ...page.props, summary: { months: [], categories: [] }, transactions: [] };
  page.componentDidUpdate(previous);
  assert.equal(page.state.selection, undefined);
  assert.deepEqual(page.rows(), []);
  const empty = renderToStaticMarkup(page.render());
  assert.ok(empty.includes("记下第一笔") && empty.includes("确认支出后查看分类分布"));
}

function investmentBars() {
  const metric = {
    beginning: 1000, ending: 1300, gain: 400, loss: 100, profit: 300,
    valuation_profit: 300, other_profit: 0, capital_net: 0, capital_in: 0,
    capital_out: 0, internal_net: 0, opening_added: 0, asset_profit: 300,
    other_changes: 0,
  };
  const profitRows = freeze([
    transaction(601, "INCOME", "2026-10-06 00:00:00", 100, { account_names: ["证券账户"] }),
    transaction(602, "EXPENSE", "2026-10-31 23:59:59", -30, { account_names: ["证券账户"] }),
    transaction(603, "INCOME", "2026-11-01 00:00:00", 200, { account_names: ["证券账户"] }),
    transaction(604, "INCOME", "2026-11-05 23:59:59", 30, { account_names: ["证券账户"] }),
  ]);
  const transfers = freeze([
    transaction(611, "TRANSFER", "2026-10-07 12:00:00", 500, { from_accounts: ["生活账户"], to_accounts: ["证券账户"] }),
    transaction(612, "TRANSFER", "2026-11-02 12:00:00", -500, { from_accounts: ["证券账户"], to_accounts: ["生活账户"] }),
  ]);
  const report = freeze({
    ...metric, start: "2026-10-06", end: "2026-11-05", account_id: 21,
    account_count: 1, asset_account_count: 1, missing_opening_ids: [], reconciled: true,
    accounts: [{ ...accounts[2], ...metric }],
    trend: [
      { period: "2026-10", profit: 70, cumulative_profit: 70, assets: 1070 },
      { period: "2026-11", profit: 230, cumulative_profit: 300, assets: 1300 },
    ],
    profits: profitRows, transfers,
  });
  const filters = freeze({ start: report.start, end: report.end, account_id: 21 });
  const page = instance(InvestmentWorkspace, props, { report, filters, grain: "month", loading: false });
  const profitTables = () => elements(page.renderDrilldown()).filter((node) => node.type === PagedTable);
  for (let index = 0; index < 2; index++) {
    const trend = chart(page.render(), "理财收益趋势");
    click(trend, 0, index, "investment:main-profit", { dataIndex: 99, name: "wrong-period" });
    assert.deepEqual(page.state.drillPeriod, index === 0
      ? { start: "2026-10-06", end: "2026-10-31", label: "2026-10-06 至 2026-10-31" }
      : { start: "2026-11-01", end: "2026-11-05", label: "2026-11-01 至 2026-11-05" });
    assert.equal(page.state.drillTab, "profit");
    assert.equal(page.state.drillReport.account_id, 21);
    assert.deepEqual(ids(profitTables()[0].props.dataSource), index === 0 ? [601, 602] : [603, 604]);
    assert.deepEqual(ids(profitTables()[1].props.dataSource), index === 0 ? [611] : [612]);
    assert.equal(profitTables()[0].props.dataSource.reduce((sum, row) => sum + row.amount, 0), report.trend[index].profit);
    assert.equal(page.state.filters, filters);
    assert.equal(page.state.report, report);
  }
  page.state.drilldown = { namespace: "investment:asset", level: "account", account_id: 21, label: "证券账户" };
  page.state.drillReport = report;
  page.state.drillLoading = false;
  for (let index = 0; index < 2; index++) {
    const trend = chart(page.renderDrilldown(), "账户盈亏趋势，点击查看该期明细");
    click(trend, 0, index, "investment:account-profit", { dataIndex: 99, name: "wrong-period" });
    assert.equal(page.state.drilldown.account_id, 21, "Account-detail bars retain the selected account");
    assert.deepEqual(ids(profitTables()[0].props.dataSource), index === 0 ? [601, 602] : [603, 604]);
  }
  const trend = chart(page.render(), "理财收益趋势");
  const selected = page.state.drillPeriod;
  trend.props.onClick({ data: { period: "2026-09" }, dataIndex: 0 });
  assert.equal(page.state.drillPeriod, selected, "Unknown periods cannot borrow an index");
  page.state.loading = true;
  click(trend, 0, 0);
  assert.equal(page.state.drillPeriod, selected);
  page.state.loading = false;
  page.state.report = { ...report };
  click(trend, 0, 0);
  assert.equal(page.state.drillPeriod, selected, "An old report chart cannot narrow a replacement report");
  page.closeDrilldown();
  page.state.report = { ...report, account_count: 0, accounts: [], trend: [], profits: [], transfers: [] };
  assert.ok(renderToStaticMarkup(page.render()).includes("暂无理财账户"));
}

function counterpartyBars() {
  const party = (key, rows, valuation = false) => ({
    key, counterparty: valuation ? "证券估值" : "同名交易方", transactions: rows,
    valuation, incoming: rows.reduce((sum, row) => sum + Math.max(0, row.account_change), 0),
    outgoing: rows.reduce((sum, row) => sum + Math.max(0, -row.account_change), 0),
    net: rows.reduce((sum, row) => sum + row.account_change, 0), count: rows.length,
    first_at: rows[0].occurred_at, last_at: rows.at(-1).occurred_at,
  });
  const alphaRows = [
    transaction(501, "REFUND", "2026-10-07 00:00:00", 200),
    transaction(502, "EXPENSE", "2026-10-07 23:59:59", 1000),
    transaction(503, "TRANSFER", "2026-10-08 00:00:00", 700),
    transaction(504, "TRANSFER", "2026-10-08 23:59:59", 500, { account_change: -500 }),
  ];
  const betaRows = [
    transaction(505, "INCOME", "2026-10-07 12:00:00", 300),
    transaction(506, "EXPENSE", "2026-10-07 12:00:00", 400),
  ];
  const valuationRows = [
    transaction(507, "INCOME", "2026-10-07 12:00:00", 50, { source: "证券余额更新" }),
    transaction(508, "EXPENSE", "2026-10-07 12:00:00", 10, { source: "证券余额更新" }),
  ];
  const report = freeze({
    account_name: "生活账户", incoming: 1200, outgoing: 1900, net: -700, count: 6,
    party_count: 2, valuation_gain: 50, valuation_loss: 10, valuation_net: 40,
    parties: [party("alpha", alphaRows), party("beta", betaRows)],
    valuations: [party("valuation", valuationRows, true)],
  });
  const filters = freeze({ start: "2026-10-06", end: "2026-10-18", q: "同名" });
  const page = instance(CounterpartyWorkspace, props, { accountId: 11, filters, report, loading: false, reportScope: { accountId: 11, filters } });
  const detailIds = () => ids(tableRows(page.render(), "counterparty-detail-table"));
  for (let series = 0; series < 2; series++) {
    const rank = chart(page.render(), "交易方收付规模排行");
    for (let index = 0; index < rank.props.option.yAxis.data.length; index++) {
      click(rank, series, index, `party:rank-${series === 0 ? "incoming" : "outgoing"}`, { dataIndex: 99 });
      const key = rank.props.option.yAxis.data[index];
      assert.equal(page.state.selected.key, key, "Duplicate display names resolve by the stable party key");
      assert.equal(page.state.selectedDirection, series === 0 ? "incoming" : "outgoing");
      const expected = key === "alpha" ? series === 0 ? [501, 503] : [502, 504] : series === 0 ? [505] : [506];
      assert.deepEqual(detailIds(), expected);
      assert.equal(page.selectedRows().reduce((sum, row) => sum + row.account_change, 0), rank.props.option.series[series].data[index] * 100);
    }
  }
  for (let series = 0; series < 2; series++) {
    page.closeParty();
    const trend = chart(page.render(), "交易方每日收付趋势");
    click(trend, series, 0, `party:daily-${series === 0 ? "incoming" : "outgoing"}`, { dataIndex: 99, name: "wrong-day" });
    assert.equal(page.state.selected.aggregate, true);
    assert.equal(page.state.selectedDay, "2026-10-07");
    assert.deepEqual(detailIds(), series === 0 ? [501, 505] : [502, 506], "Aggregate day bars include only that day and direction, without valuations");
    assert.equal(page.selectedRows().reduce((sum, row) => sum + row.account_change, 0), trend.props.option.series[series].data[0].value * 100);
  }
  page.openParty(report.parties[0]);
  for (let series = 0; series < 2; series++) {
    const local = chart(page.render(), "同名交易方每日收付");
    click(local, series, 1, undefined, { dataIndex: 99, name: "wrong-day" });
    assert.equal(page.state.selected.key, "alpha");
    assert.equal(page.state.selectedDay, "2026-10-08");
    assert.deepEqual(detailIds(), series === 0 ? [503] : [504]);
  }
  const local = chart(page.render(), "同名交易方每日收付");
  local.props.onClick({ componentType: "xAxis", targetType: "axisLabel", value: "2026-10-07" });
  assert.equal(page.state.selectedDirection, undefined, "A date label restores both directions for that selected party");
  assert.deepEqual(detailIds(), [501, 502]);
  page.openParty(report.valuations[0]);
  for (let series = 0; series < 2; series++) {
    const valuation = chart(page.render(), "证券估值每日估值盈亏");
    click(valuation, series, 0);
    assert.deepEqual(detailIds(), series === 0 ? [507] : [508], "Valuation gain/loss bars stay in their distinct noncash scope");
  }
  assert.equal(page.state.filters, filters);
  assert.equal(page.state.report, report);
  assert.equal(page.state.accountId, 11);
  const rank = chart(page.render(), "交易方收付规模排行");
  const selected = page.state.selected;
  rank.props.onClick({ componentType: "series", name: "unknown", seriesId: "incoming", dataIndex: 0 });
  assert.equal(page.state.selected, selected);
  page.state.loading = true;
  click(rank, 0, 0);
  assert.equal(page.state.selected, selected);
  page.state.loading = false;
  page.state.report = { ...report };
  click(rank, 0, 0);
  assert.equal(page.state.selected, selected, "Old ranking callbacks ignore a replaced account report");
  page.closeParty();
  page.state.report = { ...report, parties: [], valuations: [], count: 0, party_count: 0 };
  const empty = renderToStaticMarkup(page.render());
  assert.ok(empty.includes("当前条件没有交易方往来") && empty.includes("当前范围没有账户变动"));
}

function assertCompleteInventory() {
  const ts = require("typescript");
  const inventory = {};
  for (const name of fs.readdirSync(src).filter((name) => /\.tsx?$/.test(name))) {
    const file = ts.createSourceFile(name, fs.readFileSync(path.join(src, name), "utf8"), ts.ScriptTarget.Latest, true);
    const visit = (node) => {
      if (ts.isPropertyAssignment(node) && node.name.getText(file).replace(/["']/g, "") === "type") {
        let bar = false;
        const literal = (value) => {
          if (ts.isStringLiteral(value) && value.text === "bar") bar = true;
          ts.forEachChild(value, literal);
        };
        literal(node.initializer);
        if (bar) inventory[name] = (inventory[name] || 0) + 1;
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  assert.deepEqual(inventory, {
    "CounterpartyWorkspace.tsx": 4,
    "ExpenseWorkspace.tsx": 1,
    "FinancialAnalysisWorkspace.tsx": 1,
    "InvestmentWorkspace.tsx": 2,
    "ReportCharts.tsx": 3,
  }, "Every new or moved bar series needs a real-callback coverage case");
  assert.equal(covered.size, 11, "Every one of the 11 bar series executes its actual callback");
}

async function run() {
  try {
    await overviewLines();
    expenseBars();
    financialBars();
    reportBars();
    investmentBars();
    counterpartyBars();
    assertCompleteInventory();
    console.log("All 11 bar series passed real-callback, exact date/direction/ID, scope, amount and empty-data checks using synthetic memory fixtures.");
  } finally {
    global.fetch = originalFetch;
  }
}
run().catch((error) => { console.error(error); process.exitCode = 1; });
