const assert = require("node:assert/strict");
const path = require("node:path");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { loadTs } = require("./source-loader.cjs");
const source = (name) => loadTs(path.resolve(__dirname, "../src", name));
const { FinancialAnalysisWorkspace } = source("FinancialAnalysisWorkspace.tsx");
const { AnalysisFilterPanel } = source("AnalysisFilterPanel.tsx");
const { AnalysisDrilldownBar } = source("AnalysisDrilldown.tsx");
const { ScopeFundFlowSection } = source("ScopeFundFlowSection.tsx");
const { AccountMovementSection } = source("AccountMovementSection.tsx");
const { DistributionDiagram } = source("DistributionDiagram.tsx");
const { PagedTable } = source("PagedTable.tsx");
const { Chart } = source("Chart.tsx");

function instance(Component, props, state = {}) {
  const value = new Component(props);
  value.state = { ...value.state, ...state };
  value.setState = (patch, done) => {
    value.state = {
      ...value.state,
      ...(typeof patch === "function"
        ? patch(value.state, value.props)
        : patch),
    };
    done?.();
  };
  return value;
}
// Tabs keep their children in plain item objects; include them when inspecting
// element contracts, then use full SSR below to check what actually mounts.
function elements(tree, seen = new WeakSet()) {
  if (!tree || typeof tree !== "object" || seen.has(tree)) return [];
  seen.add(tree);
  if (Array.isArray(tree)) return tree.flatMap((row) => elements(row, seen));
  if (React.isValidElement(tree))
    return [
      tree,
      ...Object.entries(tree.props)
        .filter(([key]) => key !== "ref" && key !== "elementRef")
        .flatMap(([, row]) => elements(row, seen)),
    ];
  return Object.values(tree).flatMap((row) => elements(row, seen));
}
const find = (tree, type) => elements(tree).find((row) => row.type === type);
const byLabel = (tree, label) =>
  elements(tree).find((row) => row.props["aria-label"] === label);
const tabs = (page) =>
  elements(page.render()).find((row) =>
    row.props.className?.split(" ").includes("financial-analysis-tabs"),
  );
const tab = (page, key) =>
  tabs(page).props.items.find((row) => row.key === key);
const ids = (table) => table.props.dataSource.map((row) => row.id);

const groups = [{ id: 1, name: "家庭", parent_id: null }];
const categories = [
  { id: 101, name: "工资", kind: "INCOME", parent_id: null },
  { id: 102, name: "奖金", kind: "INCOME", parent_id: 101 },
  { id: 201, name: "日常", kind: "EXPENSE", parent_id: null },
];
const transactions = Array.from({ length: 26 }, (_, index) => ({
  id: index + 1,
  kind: index % 3 === 0 ? "INCOME" : index % 3 === 1 ? "EXPENSE" : "REFUND",
  direction: index % 3 === 0 ? "INCOME" : "EXPENSE",
  amount: 10000 + index,
  occurred_at: `2026-10-${index < 10 ? "07" : index < 20 ? "08" : "17"} 12:00:00`,
  counterparty: `明细交易${String(index + 1).padStart(2, "0")}`,
  category_names: [index % 3 === 0 ? "工资" : "日常"],
  account_names: ["资金账户"],
  entries: [
    {
      account_id: 1,
      account: "资金账户",
      role: "ASSET",
      amount: index % 3 === 1 ? -10000 - index : 10000 + index,
    },
  ],
}));
const movements = {
  start: "2026-10-01",
  end: "2026-10-18",
  accounts: [
    {
      id: 1,
      name: "资金账户",
      group_id: 1,
      role: "ASSET",
      kind: "银行卡",
      active: true,
      opening_balance: 1000,
      ending_balance: 1200,
      net_change: 200,
      opening_added: 0,
      operating_change: 200,
      inflow: 300,
      outflow: 100,
      operating_inflow: 300,
      operating_outflow: 100,
      transaction_count: 2,
      breakdown: [],
      reconciled: true,
    },
  ],
  totals: { opening_balance: 1000, ending_balance: 1200, net_change: 200 },
};
const report = {
  start: "2026-10-01",
  end: "2026-10-18",
  income: 90000,
  expense: 40000,
  net: 50000,
  count: transactions.length,
  income_count: 9,
  expense_count: 9,
  large_count: 3,
  large_amount_minor: 100000,
  transactions,
  large_transactions: transactions.slice(0, 3),
  categories: {
    income: [{ id: 101, name: "工资", amount: 90000, count: 9, share: 1 }],
    expense: [{ id: 201, name: "日常", amount: 40000, count: 9, share: 1 }],
  },
  trend: ["07", "08", "17"].map((day) => ({
    period: `2026-10-${day}`,
    income: 30000,
    expense: 10000,
    net: 20000,
  })),
  account_movements: movements,
};
const props = {
  accounts: [{ id: 1, name: "资金账户", role: "ASSET", group_id: 1 }],
  groups,
  categories,
  tags: [],
  refreshKey: "test",
  onDetail() {},
};
const filters = {
  start: "2026-10-01",
  end: "2026-10-18",
  account_id: 1,
  group_id: 1,
  tag: "重要",
};
const workspace = (state = {}, onDetail = () => {}) =>
  instance(
    FinancialAnalysisWorkspace,
    { ...props, onDetail },
    {
      report,
      loading: false,
      filters: { ...filters },
      ...state,
    },
  );
const beforeReport = JSON.stringify(report);

function verifyLayoutAndPagination() {
  const page = workspace();
  assert.equal(
    new FinancialAnalysisWorkspace(props).state.activeTab,
    "overview",
  );
  const root = page.render();
  const navigation = tabs(page);
  assert.deepEqual(
    navigation.props.items.map((row) => row.key),
    ["overview", "funds", "movements", "categories", "large", "details"],
  );
  assert.deepEqual(
    navigation.props.items.map((row) => row.label),
    ["收支概览", "资金进出", "账户变动", "分类分析", "大额分析", "收支明细"],
  );
  assert.equal(
    elements(root).filter((row) => row.type === AnalysisFilterPanel).length,
    1,
  );
  assert.equal(
    elements(navigation.props.items).filter(
      (row) => row.type === AnalysisFilterPanel,
    ).length,
    0,
  );
  assert.notEqual(navigation.props.destroyOnHidden, true);
  assert.notEqual(navigation.props.destroyInactiveTabPane, true);
  for (const item of navigation.props.items) {
    assert.notEqual(item.forceRender, true, "Unvisited sections mount lazily");
    assert.notEqual(
      item.destroyOnHidden,
      true,
      "Visited sections retain component state",
    );
    assert.notEqual(item.destroyInactiveTabPane, true);
    assert.equal(
      Boolean(byLabel(item.children, "大额交易门槛")),
      item.key === "large",
    );
  }
  assert.equal(
    find(tab(page, "funds").children, ScopeFundFlowSection).props.filters,
    page.state.filters,
  );
  assert.equal(
    find(tab(page, "movements").children, AccountMovementSection).props.report,
    movements,
  );
  assert.equal(
    elements(tab(page, "overview").children).filter(
      (row) => row.type === PagedTable,
    ).length,
    0,
  );
  assert.equal(
    elements(tab(page, "categories").children).filter(
      (row) => row.props.title === "分类联动明细",
    ).length,
    0,
  );

  const content = {
    overview: "收入与支出在何时发生？",
    funds: "范围资金进出 · 剔除内部互转",
    movements: "各账户变动明细",
    categories: "收入来源与支出去向",
    large: "大额支出 · 付款与退款单独分析",
    details: "完整收支，不受趋势点选影响",
  };
  for (const key of Object.keys(content)) {
    page.changeTab(key);
    const html = renderToStaticMarkup(page.render());
    for (const [other, marker] of Object.entries(content))
      assert.equal(
        html.includes(marker),
        key === other,
        `${key} must mount only its own ${other} content`,
      );
    for (const metric of ["income", "expense", "net", "large-count"])
      assert.equal(
        html.split(`data-testid="analysis-${metric}"`).length - 1,
        1,
      );
    assert.equal(html.includes('aria-label="大额交易门槛"'), key === "large");
    assert.ok(html.includes("统计口径与读图说明"));
    assert.ok(!html.includes("NaN") && !html.includes("Infinity"));
  }

  let opened;
  const detailPage = workspace({}, (row) => {
    opened = row;
  });
  let full = find(detailPage.renderDetails(report), PagedTable);
  assert.equal(full.props.defaultPageSize, 10);
  assert.equal(
    full.props.dataSource.length,
    26,
    "Pagination receives the complete filtered result",
  );
  const pager = instance(PagedTable, full.props);
  assert.ok(renderToStaticMarkup(pager.render()).includes("明细交易01"));
  pager
    .render()
    .props.onChange(
      { current: 2, pageSize: 10 },
      {},
      {},
      { action: "paginate" },
    );
  const secondPage = renderToStaticMarkup(pager.render());
  assert.ok(
    secondPage.includes("明细交易11") && !secondPage.includes("明细交易01"),
  );
  const oldKey = full.props.pageResetKey;
  detailPage.selectPeriod("2026-10-07");
  assert.equal(detailPage.state.activeTab, "overview");
  const overview = find(detailPage.renderOverview(report), PagedTable);
  assert.deepEqual(
    ids(overview),
    transactions.slice(0, 10).map((row) => row.id),
  );
  full = find(detailPage.renderDetails(report), PagedTable);
  assert.equal(
    full.props.pageResetKey,
    oldKey,
    "Trend selection never resets the complete-details page",
  );
  assert.deepEqual(
    ids(full),
    transactions.map((row) => row.id),
  );
  detailPage.changeTab("details");
  assert.ok(renderToStaticMarkup(detailPage.render()).includes("明细交易01"));
  assert.ok(
    !renderToStaticMarkup(detailPage.render()).includes("趋势联动明细"),
  );
  assert.equal(
    detailPage.state.detailPeriod.start,
    "2026-10-07",
    "Switching views retains the overview selection",
  );
  const transactionButton = full.props.columns
    .find((row) => row.title === "操作")
    .render(undefined, transactions[0]);
  transactionButton.props.onClick();
  assert.equal(
    opened,
    transactions[0],
    "Details open the original full transaction object",
  );
  detailPage.load = async () => {};
  detailPage.setFilter({ account_id: 2, start: "2026-10-08" });
  assert.equal(detailPage.state.activeTab, "details");
  assert.equal(detailPage.state.filters.tag, "重要");
  assert.equal(detailPage.state.detailPeriod, undefined);
  const changed = find(detailPage.renderDetails(report), PagedTable);
  assert.notEqual(changed.props.pageResetKey, oldKey);
  pager.props = changed.props;
  pager.componentDidUpdate(full.props);
  assert.equal(
    pager.state.current,
    1,
    "Changing the shared report scope resets local pagination",
  );
  detailPage.resetFilters();
  assert.deepEqual(detailPage.state.filters, { period: "latest_month" });
  assert.equal(detailPage.state.activeTab, "details");
}

function verifyChartLinks() {
  let opened;
  const page = workspace({}, (row) => {
    opened = row;
  });
  let requests = 0;
  page.load = async () => {
    requests++;
  };
  find(page.renderOverview(report), Chart).props.onClick({
    data: { period: "2026-10-08" },
  });
  assert.equal(page.state.activeTab, "overview");
  assert.deepEqual(
    ids(find(page.renderOverview(report), PagedTable)),
    transactions.slice(10, 20).map((row) => row.id),
  );
  assert.equal(requests, 0);
  const period = page.state.detailPeriod;
  for (const invalid of ["2026-10-09", "bad", undefined])
    page.selectPeriod(invalid);
  assert.equal(
    page.state.detailPeriod,
    period,
    "Empty or invalid trend points do not open empty details",
  );
  page.state.grain = "month";
  page.state.filters.start = "2026-10-06";
  page.selectPeriod("2026-10");
  assert.equal(page.state.detailPeriod.start, "2026-10-06");
  assert.equal(page.state.detailPeriod.end, "2026-10-18");
  page.clearPeriod();
  assert.equal(page.state.detailPeriod, undefined);

  page.state.level = 2;
  find(page.renderCategories("income"), Chart).props.onClick({
    data: { id: 102 },
  });
  assert.equal(page.state.activeTab, "categories");
  assert.equal(page.state.filters.category_id, 102);
  assert.equal(page.state.filters.exact_category, true);
  assert.equal(requests, 1);
  assert.equal(page.state.filters.account_id, 1);
  page.state.detailPeriod = {
    start: "2026-10-07",
    end: "2026-10-07",
    label: "10月7日",
  };
  assert.equal(
    find(page.renderDetails(report, "categories"), PagedTable).props.dataSource
      .length,
    26,
    "Category detail never inherits the overview's local date",
  );
  page.resetCategory();
  assert.equal(page.state.filters.category_id, undefined);
  assert.equal(page.state.filters.exact_category, undefined);
  assert.equal(page.state.detailPeriod, undefined);
  assert.equal(page.state.activeTab, "categories");
  page.state.level = 1;
  const categoryTable = find(page.renderCategories("income"), PagedTable);
  categoryTable.props.columns[0]
    .render(undefined, report.categories.income[0])
    .props.onClick();
  assert.equal(page.state.filters.category_id, 101);
  assert.equal(page.state.filters.exact_category, undefined);
  const count = requests;
  for (const invalid of [0, -1, NaN, undefined, "101"])
    page.selectCategory(invalid);
  assert.equal(requests, count);

  page.state.largeKind = "EXPENSE";
  const large = page.renderLargeAnalysis(report);
  assert.deepEqual(
    ids(find(large, PagedTable)),
    [2, 3],
    "Expense type retains both payments and refunds",
  );
  find(large, Chart).props.onClick({ data: { id: 3 } });
  assert.equal(opened, transactions[2]);
  find(large, Chart).props.onClick({ data: { id: 999 } });
  assert.equal(opened, transactions[2]);
  byLabel(large, "大额分析收支方向").props.onChange("INCOME");
  assert.deepEqual(
    ids(find(page.renderLargeAnalysis(report), PagedTable)),
    [1],
  );
  assert.equal(
    find(page.renderDetails(report), PagedTable).props.dataSource.length,
    26,
  );
  const threshold = byLabel(large, "大额交易门槛");
  threshold.props.onChange(2500);
  assert.equal(page.state.expenseThreshold, 2500);
  assert.equal(requests, count);
  byLabel(large, "应用大额门槛").props.onClick();
  assert.equal(requests, count + 1);
  threshold.props.onKeyDown({ key: "Enter" });
  assert.equal(requests, count + 2);

  for (const activeTab of [
    "overview",
    "categories",
    "details",
    "funds",
    "movements",
    "large",
  ]) {
    page.changeTab(activeTab);
    const bars = elements(tabs(page).props.items).filter(
      (row) => row.type === AnalysisDrilldownBar,
    );
    const owned = bars.filter(
      (row) => row.props.elementRef === page.detailFocus.ref,
    );
    assert.equal(
      owned.length,
      activeTab === "categories" ? 1 : 0,
      "Only the active local-detail panel owns the parent scroll target",
    );
  }
  page.changeTab("overview");
  page.selectPeriod("2026-10");
  assert.equal(page.detailPeriodBar().props.elementRef, page.detailFocus.ref);
  assert.equal(page.categoryDetailBar().props.elementRef, undefined);
  page.changeTab("categories");
  assert.equal(page.detailPeriodBar().props.elementRef, undefined);
  assert.equal(page.categoryDetailBar().props.elementRef, page.detailFocus.ref);
}

const boundaryReport = {
  start: "2026-10-01",
  end: "2026-10-18",
  groups,
  endpoints: [
    { key: "external", name: "外部收入", external: true },
    {
      key: "account:1",
      name: "资金账户",
      account_id: 1,
      group_id: 1,
      in_scope: true,
      external: false,
    },
  ],
  flows: [
    {
      id: "flow:1",
      transaction_id: 1,
      source: "external",
      target: "account:1",
      amount: 5000,
      kind: "INCOME",
    },
  ],
  transactions: [transactions[0]],
  summary: {
    key: "total",
    level: "total",
    name: "整体",
    account_ids: [1],
    incoming: 5000,
    outgoing: 0,
    net: 5000,
    incoming_count: 1,
    outgoing_count: 0,
    internal_count: 0,
    internal_excluded: 0,
    incoming_flow_ids: ["flow:1"],
    outgoing_flow_ids: [],
    count: 1,
  },
  group_scopes: [],
  account_scopes: [],
  scope_account_ids: [1],
};

async function verifyRequestsAndReveal() {
  const globals = ["window", "requestAnimationFrame", "cancelAnimationFrame"];
  const originals = globals.map((key) =>
    Object.getOwnPropertyDescriptor(global, key),
  );
  const frames = new Map(),
    scrolls = [];
  let sequence = 0;
  global.window = { innerHeight: 800, matchMedia: () => ({ matches: false }) };
  global.requestAnimationFrame = (callback) => {
    frames.set(++sequence, callback);
    return sequence;
  };
  global.cancelAnimationFrame = (id) => frames.delete(id);
  const target = (name) => ({
    isConnected: true,
    dataset: {},
    closest: () => null,
    getBoundingClientRect: () => ({ top: 1000, height: 60 }),
    scrollIntoView: () => scrolls.push(name),
    focus: () => assert.fail("Chart selection must not move keyboard focus"),
  });
  const flush = () => {
    for (let pass = 0; pass < 4 && frames.size; pass++)
      for (const [id, callback] of [...frames]) {
        frames.delete(id);
        callback();
      }
    assert.equal(frames.size, 0);
  };
  const settle = async () => {
    await Promise.resolve();
    await Promise.resolve();
  };
  const deferred = (page) => {
    const pending = [];
    page.api.request = (url) =>
      new Promise((resolve, reject) => pending.push({ url, resolve, reject }));
    return pending;
  };
  try {
    const page = workspace({ level: 2 });
    const pending = deferred(page);
    page.detailFocus.ref.current = target("parent");
    const originalFilters = JSON.stringify(page.state.filters);
    page.selectPeriod("2026-10-07");
    assert.equal(
      scrolls.length,
      0,
      "Wait for the local result to commit before positioning",
    );
    flush();
    assert.deepEqual(scrolls.splice(0), ["parent"]);
    assert.equal(pending.length, 0);
    assert.equal(JSON.stringify(page.state.filters), originalFilters);
    const fullKey = find(page.renderDetails(report), PagedTable).props
      .pageResetKey;
    for (const key of [
      "funds",
      "movements",
      "categories",
      "large",
      "details",
      "overview",
    ])
      tabs(page).props.onChange(key);
    assert.equal(
      pending.length,
      0,
      "Changing the active tab never requests the parent report",
    );
    assert.equal(
      find(page.renderDetails(report), PagedTable).props.pageResetKey,
      fullKey,
    );
    assert.equal(JSON.stringify(page.state.filters), originalFilters);

    page.selectPeriod("2026-10-08");
    page.changeTab("details");
    flush();
    assert.deepEqual(scrolls, [], "Leaving a tab cancels a scheduled scroll");
    page.selectCategory(102);
    assert.equal(page.state.loading, true);
    assert.equal(page.state.activeTab, "categories");
    assert.equal(pending.length, 1);
    const query = new URL(pending[0].url, "http://fixture.test").searchParams;
    for (const [key, value] of Object.entries({
      ...filters,
      grain: "day",
      level: 2,
      category_id: 102,
      exact_category: true,
    }))
      assert.equal(query.get(key), String(value));
    flush();
    assert.deepEqual(
      scrolls,
      [],
      "Async category details wait for the new report",
    );
    page.selectCategory(101);
    page.selectPeriod("2026-10-07");
    assert.equal(
      pending.length,
      1,
      "Clicks against a loading report are ignored",
    );
    assert.equal(page.state.activeTab, "categories");
    const categoryReport = {
      ...report,
      transactions: [transactions[3], transactions[21]],
      count: 2,
    };
    pending[0].resolve(categoryReport);
    await settle();
    assert.equal(page.state.report, categoryReport);
    assert.equal(page.state.loading, false);
    assert.deepEqual(
      ids(find(page.renderDetails(categoryReport, "categories"), PagedTable)),
      [4, 22],
    );
    assert.equal(scrolls.length, 0);
    flush();
    assert.deepEqual(scrolls.splice(0), ["parent"]);

    page.selectCategory(101);
    page.changeTab("large");
    pending[1].resolve(report);
    await settle();
    flush();
    assert.equal(page.state.activeTab, "large");
    assert.deepEqual(
      scrolls,
      [],
      "A category response cannot reveal a tab the user left",
    );
    page.selectCategory(102);
    page.setFilter({ account_id: 2 });
    pending[2].resolve(categoryReport);
    await settle();
    assert.equal(
      page.state.report,
      report,
      "A superseded category response is discarded",
    );
    assert.equal(page.state.loading, true);
    const latestReport = { ...report, net: 12345 };
    pending[3].resolve(latestReport);
    await settle();
    assert.equal(page.state.report, latestReport);
    assert.equal(page.state.loading, false);
    flush();
    assert.deepEqual(scrolls, []);

    const fundElement = find(tab(page, "funds").children, ScopeFundFlowSection);
    const fund = instance(ScopeFundFlowSection, fundElement.props);
    const fundPending = deferred(fund);
    page.fundFlowRef.current = fund;
    fund.detailFocus.ref.current = target("fund");
    fund.componentDidMount();
    assert.equal(
      fundPending.length,
      1,
      "The funds tab loads once on first mount",
    );
    assert.ok(fundPending[0].url.startsWith("/reports/fund-boundaries?"));
    const fundQuery = new URL(fundPending[0].url, "http://fixture.test")
      .searchParams;
    assert.equal(fundQuery.get("account_id"), "2");
    assert.equal(fundQuery.has("category_id"), false);
    assert.equal(fundQuery.has("tag"), false);
    fundPending[0].resolve(boundaryReport);
    await settle();
    const fundDiagram = find(
      fund.renderReport(boundaryReport),
      DistributionDiagram,
    );
    const selection = fundDiagram.props.data.selectionFor(
      fundDiagram.props.data.nodes[0].name,
    );
    fundDiagram.props.onSelect(selection);
    assert.equal(fund.state.selection.direction, "IN");
    const fundTabs = elements(fund.renderReport(boundaryReport)).find((row) =>
      row.props.items?.some((item) => item.key === "transactions"),
    );
    const fundRows = find(fundTabs.props.items[0].children, PagedTable);
    assert.deepEqual(ids(fundRows), [1]);
    let opened;
    fund.props = {
      ...fund.props,
      onDetail: (row) => {
        opened = row;
      },
    };
    fundRows.props.columns
      .find((row) => row.title === "操作")
      .render(undefined, fundRows.props.dataSource[0])
      .props.onClick();
    assert.equal(
      opened,
      transactions[0],
      "Funds open the original transaction, not its allocated projection",
    );
    const movementElement = find(
      tab(page, "movements").children,
      AccountMovementSection,
    );
    const movement = instance(AccountMovementSection, movementElement.props);
    page.movementRef.current = movement;
    movement.detailFocus.ref.current = target("movement");
    const movementDiagram = find(movement.render(), DistributionDiagram);
    movementDiagram.props.onSelect(
      movementDiagram.props.data.selectionFor(
        movementDiagram.props.data.nodes[0].name,
      ),
    );
    assert.deepEqual(ids(find(movement.render(), PagedTable)), [1]);
    const rememberedFund = fund.state.selection,
      rememberedMovement = movement.state.selection;
    page.changeTab("overview");
    flush();
    assert.deepEqual(
      scrolls,
      [],
      "The parent also cancels hidden child-module scrolls",
    );
    page.changeTab("funds");
    let previous = fund.props;
    fund.props = find(tab(page, "funds").children, ScopeFundFlowSection).props;
    fund.componentDidUpdate(previous);
    page.changeTab("movements");
    movement.componentDidUpdate(movement.props);
    assert.equal(
      fundPending.length,
      1,
      "Returning to an already mounted funds tab does not reload it",
    );
    assert.equal(fund.state.selection, rememberedFund);
    assert.equal(movement.state.selection, rememberedMovement);
    previous = fund.props;
    fund.props = {
      ...fund.props,
      filters: { ...fund.props.filters, category_id: 201, tag: "其他" },
    };
    fund.componentDidUpdate(previous);
    assert.equal(
      fundPending.length,
      1,
      "Transaction category and tag do not refetch account-boundary flows",
    );
    previous = fund.props;
    fund.props = {
      ...fund.props,
      filters: { ...fund.props.filters, account_id: 3 },
    };
    fund.componentDidUpdate(previous);
    assert.equal(
      fundPending.length,
      2,
      "Changing the shared account scope reloads a mounted funds module",
    );
    assert.equal(fund.state.selection, undefined);
    fundPending[1].resolve(boundaryReport);
    await settle();

    const ending = workspace();
    const endingPending = deferred(ending);
    ending.detailFocus.ref.current = target("unmounted");
    ending.selectPeriod("2026-10-07");
    ending.componentWillUnmount();
    flush();
    assert.deepEqual(scrolls, [], "Unmounting cancels a pending trend reveal");
    const loading = workspace();
    const loadingPending = deferred(loading);
    loading.selectCategory(102);
    const saved = loading.state.report;
    loading.componentWillUnmount();
    loadingPending[0].resolve(categoryReport);
    await settle();
    assert.equal(
      loading.state.report,
      saved,
      "An unmounted report ignores late responses",
    );
    flush();
    assert.deepEqual(scrolls, []);
    assert.equal(endingPending.length, 0);
  } finally {
    frames.clear();
    globals.forEach((key, index) => {
      if (originals[index])
        Object.defineProperty(global, key, originals[index]);
      else delete global[key];
    });
  }
}

async function verify() {
  verifyLayoutAndPagination();
  verifyChartLinks();
  await verifyRequestsAndReveal();
  assert.equal(JSON.stringify(report), beforeReport);
  console.log(
    "Financial six-tab SSR, shared scope and pagination, chart-to-detail links, lazy child retention, request races and stale-scroll cancellation passed.",
  );
}
verify().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
