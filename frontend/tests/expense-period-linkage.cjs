const assert = require("node:assert/strict");
const path = require("node:path");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { loadTs } = require("./source-loader.cjs");
const source = (name) => loadTs(path.resolve(__dirname, "../src", name));
const { ExpenseWorkspace } = source("ExpenseWorkspace.tsx");
const { FinancialAnalysisWorkspace } = source("FinancialAnalysisWorkspace.tsx");
const { AnalysisDrilldownBar } = source("AnalysisDrilldown.tsx");
const { Chart } = source("Chart.tsx");
const { PagedTable } = source("PagedTable.tsx");

function instance(Component, props, state = {}) {
  const page = new Component(props);
  page.state = { ...page.state, ...state };
  page.setState = (patch, done) => {
    page.state = {
      ...page.state,
      ...(typeof patch === "function" ? patch(page.state, page.props) : patch),
    };
    done?.();
  };
  return page;
}
function elements(tree, seen = new WeakSet()) {
  if (!tree || typeof tree !== "object" || seen.has(tree)) return [];
  seen.add(tree);
  if (Array.isArray(tree)) return tree.flatMap((row) => elements(row, seen));
  if (React.isValidElement(tree))
    return [tree, ...Object.entries(tree.props)
      .filter(([key]) => key !== "ref" && key !== "elementRef")
      .flatMap(([, row]) => elements(row, seen))];
  return Object.values(tree).flatMap((row) => elements(row, seen));
}
const find = (tree, predicate) => elements(tree).find(predicate);
const table = (tree) => find(tree, (row) => row.type === PagedTable);
const ids = (rows) => rows.map((row) => row.id);
const tabs = (page) => find(page.render(), (row) => row.props.items?.some((item) => item.key === "merchants"));
const tab = (page, key) => tabs(page).props.items.find((item) => item.key === key);
const trend = (page) => find(page.render(), (row) => row.type === Chart && row.props.label === "每日家庭开支趋势");
const linked = (page) => find(tab(page, page.state.activeTab).children,
  (row) => row.props.title === "日支出联动明细" || row.props.title === "这些开支和退款由哪些交易组成？");

const groups = [{ id: 1, name: "家庭", parent_id: null }];
const categories = [{ id: 201, name: "日常", kind: "EXPENSE", parent_id: null }];
const transactions = [
  [1, "EXPENSE", 5000, "07"],
  [2, "REFUND", -1500, "07"],
  [3, "REFUND", -700, "08"],
  [4, "EXPENSE", 600, "09"],
  [5, "REFUND", -600, "09"],
].map(([id, kind, amount, day]) => ({
  id, kind, amount, occurred_at: `2026-10-${day} 12:00:00`,
  counterparty: "同名交易方", category_names: ["日常"], note: `交易 ${id}`,
  entries: [{ account_id: 3, role: "ASSET", amount: -amount }],
}));
const report = {
  start: "2026-10-01", end: "2026-10-18", days: 18,
  previous_start: "2026-09-13", previous_end: "2026-09-30",
  expense: 2800, paid: 5600, refunds: 2800, average_daily: 156, change: 0, count: 2,
  parents: [{ id: 201, name: "日常", amount: 2800, previous_amount: 2800, change: 0, share: 1, count: 2 }],
  merchants: [], group_category_details: [], excluded_account_ids: [9],
  large_count: 1, large_amount_minor: 1000, large_transactions: [transactions[0]], transactions,
  trend: [
    { day: "2026-10-07", expense: 3500 },
    { day: "2026-10-08", expense: -700 },
    { day: "2026-10-09", expense: 0 },
    { day: "2026-10-10", expense: 0 },
  ],
};
const props = {
  groups, categories, accounts: [{ id: 3, name: "家庭卡", role: "ASSET", group_id: 1 }],
  refreshKey: "test", onDetail() {},
};
const filters = {
  start: "2026-10-01", end: "2026-10-18", account_id: 3,
  group_id: 1, direct_group: true, category_id: 201, exact_category: true,
};
const workspace = (state = {}) => instance(ExpenseWorkspace, props, {
  report, loading: false, filters: { ...filters }, ...state,
});
const beforeReport = JSON.stringify(report);

function verifyLocalDetails() {
  const page = workspace();
  let requests = 0;
  page.api.request = async () => { requests++; return report; };
  const scope = page.state.filters;
  assert.deepEqual(trend(page).props.option.series[0].data, report.trend.map((row) => ({
    value: row.expense / 100, day: row.day,
  })), "Every bar keeps the complete date, including negative and zero buckets");
  for (const key of ["categories", "merchants", "large", "details"]) {
    tabs(page).props.onChange(key);
    trend(page).props.onClick({ data: { day: "2026-10-07" } });
    assert.equal(page.state.activeTab, key, "A daily bar reveals details within the current tab");
    assert.equal(page.state.filters, scope);
    assert.equal(page.state.report, report);
    assert.deepEqual(ids(table(linked(page)).props.dataSource), [1, 2]);
    const owned = elements(page.render()).filter((row) => row.type === AnalysisDrilldownBar && row.props.elementRef === page.detailFocus.ref);
    assert.equal(owned.length, 1, "Only the visible linked result owns the scroll target");
    const flow = find(tab(page, "details").children,
      (row) => row.type === AnalysisDrilldownBar && row.props.label === "图表联动范围");
    assert.ok(flow.props.items.some((item) => item.key === "exact-category"), "The Sankey's exact classification stays visible");
    const selectedKey = table(linked(page)).props.pageResetKey;
    const html = renderToStaticMarkup(page.render());
    assert.ok(html.includes("明细日期") && html.includes("2026-10-07"));
    assert.ok(html.includes("-15.00") && html.includes("退款抵减"));
    owned[0].props.items[0].onClear();
    assert.equal(page.state.detailPeriod, undefined);
    assert.equal(page.state.filters, scope);
    assert.equal(page.state.activeTab, key);
    if (key === "details") {
      assert.deepEqual(ids(table(linked(page)).props.dataSource), ids(transactions));
      assert.notEqual(table(linked(page)).props.pageResetKey, selectedKey);
    } else assert.equal(linked(page), undefined);
  }
  page.changeTab("merchants");
  trend(page).props.onClick({ data: trend(page).props.option.series[0].data[1] });
  assert.deepEqual(ids(table(linked(page)).props.dataSource), [3], "A negative refund-only day remains selectable");
  trend(page).props.onClick({ data: trend(page).props.option.series[0].data[2] });
  assert.deepEqual(ids(table(linked(page)).props.dataSource), [4, 5], "A net-zero day retains its payment and refund");
  const chosen = page.state.detailPeriod;
  for (const value of ["2026-10-10", "2026-09-30", "2026-02-30", "10-07", undefined, 0])
    page.selectPeriod(value);
  assert.equal(page.state.detailPeriod, chosen, "Empty, out-of-scope or invalid buckets cannot replace a valid selection");
  page.detailPeriodBar().props.onReset();
  assert.equal(page.state.detailPeriod, undefined);
  page.selectPeriod("2026-10-07");
  page.selectFlow({ group_id: 1, direct_group: true, category_id: 201, exact_category: true });
  assert.equal(page.state.activeTab, "details");
  assert.equal(page.state.detailPeriod, undefined, "A Sankey selection reveals its complete selected flow, without an old local date");
  assert.equal(page.state.filters, scope);
  assert.deepEqual(ids(table(linked(page)).props.dataSource), ids(transactions));
  const previousChart = trend(page);
  page.state.report = { ...report };
  previousChart.props.onClick({ data: { day: "2026-10-07" } });
  assert.equal(page.state.detailPeriod, undefined, "An old chart cannot select a date in a refreshed report");
  assert.equal(requests, 0, "Local daily selection never refetches the main report");
}

async function verifyRevealCancellation() {
  const keys = ["window", "requestAnimationFrame", "cancelAnimationFrame"];
  const originals = keys.map((key) => Object.getOwnPropertyDescriptor(global, key));
  const frames = new Map(), scrolls = [];
  let sequence = 0;
  global.window = { innerHeight: 800, matchMedia: () => ({ matches: false }) };
  global.requestAnimationFrame = (callback) => { frames.set(++sequence, callback); return sequence; };
  global.cancelAnimationFrame = (id) => frames.delete(id);
  const flush = () => {
    for (let pass = 0; pass < 4 && frames.size; pass++)
      for (const [id, callback] of [...frames]) { frames.delete(id); callback(); }
    assert.equal(frames.size, 0);
  };
  const deferred = (page) => {
    const pending = [];
    page.api.request = (url) => new Promise((resolve) => pending.push({ url, resolve }));
    return pending;
  };
  const target = {
    isConnected: true, dataset: {}, closest: () => null,
    getBoundingClientRect: () => ({ top: 1000, height: 60 }),
    scrollIntoView: () => scrolls.push("details"),
    focus: () => assert.fail("Chart selection must not move keyboard focus"),
  };
  try {
    const page = workspace();
    page.detailFocus.ref.current = target;
    const pending = deferred(page);
    page.selectPeriod("2026-10-07");
    assert.equal(scrolls.length, 0, "Positioning waits for the committed local result");
    flush();
    assert.deepEqual(scrolls.splice(0), ["details"]);
    for (const cancel of [
      () => page.clearPeriod(),
      () => page.changeTab("merchants"),
      () => page.changeTab("large"),
    ]) {
      page.selectPeriod("2026-10-08");
      cancel();
      flush();
      assert.deepEqual(scrolls, []);
    }
    page.selectPeriod("2026-10-07");
    const loading = page.load();
    assert.equal(page.state.detailPeriod, undefined);
    page.selectPeriod("2026-10-08");
    assert.equal(page.state.detailPeriod, undefined, "Loading bars cannot reveal stale transactions");
    flush();
    assert.deepEqual(scrolls, []);
    pending[0].resolve(report);
    await loading;
    flush();
    assert.deepEqual(scrolls, []);
    page.selectPeriod("2026-10-07");
    page.filter({ account_id: 4 });
    assert.equal(page.state.detailPeriod, undefined);
    assert.equal(page.state.filters.account_id, 4);
    assert.equal(page.state.filters.exact_category, true);
    flush();
    assert.deepEqual(scrolls, [], "A new primary scope cancels a pending local scroll");
    page.componentWillUnmount();
    pending[1].resolve({ ...report, expense: 99 });
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(page.state.report, report, "Unmount ignores a late report response");
    const ending = workspace();
    ending.detailFocus.ref.current = target;
    ending.selectPeriod("2026-10-07");
    ending.componentWillUnmount();
    flush();
    assert.deepEqual(scrolls, []);
  } finally {
    frames.clear();
    keys.forEach((key, index) => {
      if (originals[index]) Object.defineProperty(global, key, originals[index]);
      else delete global[key];
    });
  }
}

function verifyFinancialRank() {
  const large = Array.from({ length: 12 }, (_, index) => ({
    id: index + 1, kind: index % 2 ? "REFUND" : "INCOME",
    direction: index % 2 ? "EXPENSE" : "INCOME", amount: 1200 - index,
    category_names: ["同名分类"], counterparty: "同名交易方",
  }));
  const opened = [];
  const page = instance(FinancialAnalysisWorkspace, { ...props, tags: [], onDetail: (row) => opened.push(row) }, {
    report: { large_transactions: large }, loading: false,
  });
  const rank = find(page.renderLargeAnalysis(page.state.report), (row) => row.type === Chart);
  rank.props.onClick({ data: rank.props.option.series[0].data[1] });
  assert.equal(opened[0], large[3], "Rank opens the exact transaction even when names match");
  for (const id of [11, "2", 0, -1, undefined, 999]) rank.props.onClick({ data: { id } });
  assert.equal(opened.length, 1, "Only valid IDs in the visible top ten can open a rank item");
  page.state.loading = true;
  rank.props.onClick({ data: { id: 2 } });
  assert.equal(opened.length, 1);
  page.state.loading = false;
  page.state.largeKind = "INCOME";
  rank.props.onClick({ data: { id: 2 } });
  assert.equal(opened.length, 1, "An old bar from a different type is ignored");
  const replacement = { ...large[0], counterparty: "刷新后的原交易" };
  page.state.report = { large_transactions: [replacement] };
  rank.props.onClick({ data: { id: 1 } });
  assert.equal(opened.length, 1, "A retained handler cannot open a transaction in a refreshed report");
  find(page.renderLargeAnalysis(page.state.report), (row) => row.type === Chart)
    .props.onClick({ data: { id: 1 } });
  assert.equal(opened[1], replacement, "The current bar opens the current original transaction object");
}

async function verify() {
  verifyLocalDetails();
  await verifyRevealCancellation();
  verifyFinancialRank();
  assert.equal(JSON.stringify(report), beforeReport);
  console.log("Expense daily bars: current-tab SSR details, exact refund dates, unchanged report scope, reset/pagination and stale-scroll cancellation passed; financial rank IDs and loading guards passed.");
}
verify().catch((error) => { console.error(error); process.exitCode = 1; });
