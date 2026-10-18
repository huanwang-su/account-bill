const assert = require("node:assert/strict");
const path = require("node:path");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { loadTs } = require("./source-loader.cjs");
const src = path.resolve(__dirname, "../src");
const source = (name) => loadTs(path.join(src, name));
const { OverviewWorkspace } = source("OverviewWorkspace.tsx");
const { OverviewBalanceDistribution, OverviewBalanceFlow } = source(
  "OverviewBalanceFlow.tsx",
);
const { DistributionDiagram } = source("DistributionDiagram.tsx");
const { ReportPeriodFilter } = source("ReportPeriodFilter.tsx");
const { ReportAccountFilters } = source("ReportAccountFilters.tsx");
const { Chart } = source("Chart.tsx");
const { Card } = require("antd");
const originalFetch = global.fetch;
global.fetch = () =>
  assert.fail("Synthetic presentation tests never access a service");
function elements(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  if (React.isValidElement(value))
    return [value, ...elements(value.props, seen)];
  return Object.values(value).flatMap((item) => elements(item, seen));
}
function instance(Component, props, state = {}) {
  const page = new Component(props);
  page.state = { ...page.state, ...state };
  page.setState = (patch, done) => {
    page.state = {
      ...page.state,
      ...(typeof patch === "function" ? patch(page.state) : patch),
    };
    done?.();
  };
  return page;
}
const groups = [
  { id: 1, name: "家庭", parent_id: null },
  { id: 2, name: "同名成员", parent_id: 1 },
  { id: 3, name: "同名成员", parent_id: 1 },
];
const account = (id, role, kind, amount, group_id) => ({
  id,
  name: `账户 ${id}`,
  role,
  kind,
  amount,
  group_id,
});
const snapshot = {
  groups,
  accounts: [
    account(1, "ASSET", "银行卡", 10000, 2),
    account(2, "ASSET", "证券", 20000, 2),
    account(3, "ASSET", "微信", 5000, 3),
    account(4, "ASSET", "银行卡", -500, 2),
    {
      ...account(5, "ASSET", "招商银行", 800, 1),
      composite: true,
      asset_amount: 1000,
      liability_amount: 200,
    },
    account(6, "LIABILITY", "房贷", 50000, 1),
    account(7, "ASSET", "微信", 0, 3),
    account(8, "LIABILITY", "信用卡", -100, 3),
    account(9, "ASSET", "现金", 700, null),
  ],
};
const tx = (id, kind, signed, day, source = "手工") => ({
  id,
  kind,
  amount: Math.abs(signed),
  account_change: signed,
  occurred_at: `2026-10-${day} 12:00:00`,
  source,
  category_names: [],
  entries: [],
  counterparty: `交易方 ${id}`,
});
const first = {
  ...snapshot.accounts[0],
  name: "独立账户甲",
  ending_balance: 14600,
  change: 4600,
  income: 1500,
  expense: 1200,
  refunds: 1200,
  transfer_net: 2000,
  valuation_profit: 300,
  analysis_mode: "counterparties",
  transactions: [
    tx(1, "INCOME", 1000, "02"),
    tx(2, "EXPENSE", -500, "02"),
    tx(3, "REFUND", 200, "02"),
    tx(4, "TRANSFER", 2000, "02"),
    tx(5, "INCOME", 300, "02", "证券余额更新"),
    tx(6, "OPENING", 800, "02"),
    tx(7, "EXPENSE", -700, "03"),
    tx(8, "REFUND", 1000, "03"),
    tx(9, "INCOME", 500, "03"),
  ],
  trend: [
    {
      day: "2026-10-02",
      income: 1000,
      expense: 300,
      transfer_in: 2000,
      transfer_out: 0,
    },
    { day: "2026-10-03", income: 500, expense: -300 },
    { day: "2026-10-04", income: 0, expense: 0 },
  ],
};
const second = {
  ...snapshot.accounts[2],
  name: "独立账户乙",
  ending_balance: -10000,
  change: -15000,
  income: 10000,
  expense: 20000,
  refunds: 0,
  transfer_net: -5000,
  valuation_profit: 0,
  transactions: [
    tx(11, "INCOME", 10000, "02"),
    tx(12, "EXPENSE", -20000, "03"),
    tx(13, "TRANSFER", -5000, "02"),
  ],
  trend: [
    {
      day: "2026-10-02",
      income: 10000,
      expense: 0,
      transfer_in: 0,
      transfer_out: 5000,
    },
    { day: "2026-10-03", income: 0, expense: 20000 },
  ],
};
const data = {
  as_of: "2026-10-31",
  month_start: "2026-10-01",
  period: {
    start: "2026-10-01",
    end: "2026-10-31",
    preset: "latest_month",
    latest_data_date: "2026-10-03",
  },
  account_scope: {
    exclude_investment_accounts: true,
    exclude_single_accounts: true,
  },
  balance_sheet: snapshot,
  groups: [],
  assets: 36200,
  liabilities: 50100,
  net_assets: -13900,
  account_count: 9,
  pending_count: 0,
  household: {
    income: 1000,
    expense: 500,
    net: 500,
    count: 1,
    refunds: 0,
    average_daily: 16,
    trend: [{ day: "2026-10-02", expense: 500 }],
  },
  income_report: {
    income: 1000,
    count: 1,
    categories: [],
    trend: [{ period: "2026-10-02", income: 1000 }],
  },
  investments: { assets: 20000, profit: 300, account_count: 1 },
  investment_report: {
    ending: 20000,
    profit: 300,
    account_count: 1,
    capital_in: 0,
    capital_out: 0,
    trend: [{ period: "2026-10-02", profit: 300 }],
  },
  single_accounts: { accounts: [first, second] },
};
const props = {
  refreshKey: "test",
  onReport() {},
  onAccounts() {},
  onPending() {},
  onImport() {},
  onDetail() {},
};
const page = instance(OverviewWorkspace, props, { data, loading: false });
const before = JSON.stringify(data);
try {
  const html = renderToStaticMarkup(page.render());
  assert.ok(html.indexOf("overview-hero") < html.indexOf("总览收支过滤条件"));
  assert.ok(
    html.indexOf("总览负债三级分布桑基图") < html.indexOf("总览收支过滤条件"),
  );
  assert.equal(
    page.state.filters.exclude_single_accounts,
    undefined,
    "Initial and reset requests defer to saved configuration",
  );
  const filter = elements(page.render()).find(
    (node) => node.type === ReportAccountFilters,
  );
  assert.equal(filter.props.defaults.exclude_single_accounts, true);
  let loads = 0;
  page.load = () => loads++;
  page.filter({ exclude_single_accounts: false });
  assert.equal(page.state.filters.exclude_single_accounts, false);
  const periodControl = elements(page.render()).find(
    (node) => node.type === ReportPeriodFilter,
  );
  periodControl.props.onChange({
    period: "latest_month",
    start: "2026-10-01",
    end: "2026-10-31",
  });
  assert.equal(
    page.state.filters.exclude_single_accounts,
    false,
    "Resetting dates preserves account masks",
  );
  assert.equal(loads, 2);
  for (const role of ["ASSET", "LIABILITY"]) {
    const model = new OverviewBalanceDistribution(snapshot, role);
    assert.deepEqual(
      [...new Set(model.nodes.map((node) => node.depth))].sort(),
      [0, 1, 2],
    );
    assert.equal(model.total, role === "ASSET" ? 36200 : 50100);
    assert.equal(model.positiveTotal, role === "ASSET" ? 36700 : 50200);
    assert.ok(model.links.every((link) => link.value > 0));
    assert.ok(
      !model.nodes.some((node) => node.accountId),
      "Last column is tags, not accounts",
    );
    for (const node of model.nodes) {
      const incoming = model.links.filter((link) => link.target === node.name);
      const outgoing = model.links.filter((link) => link.source === node.name);
      if (incoming.length)
        assert.equal(
          incoming.reduce((sum, link) => sum + link.value, 0),
          node.value,
        );
      if (outgoing.length)
        assert.equal(
          outgoing.reduce((sum, link) => sum + link.value, 0),
          node.value,
        );
    }
    const flow = new OverviewBalanceFlow({
      snapshot,
      role,
      onSelect: (value, selection) => page.openPosition(value, selection, data),
    });
    const diagramElement = elements(flow.render()).find(
      (node) => node.type === DistributionDiagram,
    );
    assert.deepEqual(diagramElement.props.columns, [
      role === "ASSET" ? "资产总额" : "负债总额",
      "账户组",
      "账户标签",
    ]);
    const diagram = new DistributionDiagram(diagramElement.props);
    const chart = elements(diagram.render()).find(
      (node) => node.type === Chart,
    );
    const series = chart.props.option.series[0];
    for (const [dataType, rows] of [
      ["node", series.data],
      ["edge", series.links],
    ]) {
      for (const row of rows) {
        chart.props.onClick({
          dataType,
          data: row,
          dataIndex: 999,
          name: "错误显示名称",
        });
        assert.equal(page.state.chartDetail.amount, row.value);
        assert.equal(
          page.state.chartDetail.count,
          page.state.chartDetail.accounts.length,
        );
        assert.equal(
          page.state.chartDetail.amount,
          page.state.chartDetail.accounts.reduce(
            (sum, account) => sum + account.analysis_amount,
            0,
          ),
        );
        if (page.state.chartSelection.level !== "root")
          assert.ok(
            page.state.chartDetail.accounts.every(
              (account) =>
                (account.group_id ?? 0) === page.state.chartSelection.group_id,
            ),
          );
      }
    }
    for (const row of model.adjustments) {
      const button = elements(flow.render()).find(
        (node) => node.props.children === row.name,
      );
      button.props.onClick();
      assert.equal(page.state.chartDetail.amount, row.amount);
      assert.deepEqual(
        page.state.chartDetail.accounts.map((account) => account.id),
        [row.id],
      );
    }
    const latest = page.state.chartDetail;
    page.state.data = { ...data };
    chart.props.onClick({ dataType: "node", data: series.data[0] });
    assert.equal(
      page.state.chartDetail,
      latest,
      "Old distribution callbacks cannot read a replaced scope",
    );
    page.state.data = data;
    page.state.loading = true;
    chart.props.onClick({ dataType: "node", data: series.data[0] });
    assert.equal(page.state.chartDetail, latest);
    page.state.loading = false;
  }
  const accountCards = elements(page.renderAttentionAccounts(data)).filter(
    (node) => node.type === Card,
  );
  assert.deepEqual(
    accountCards.map((node) => node.props.title.props.children),
    [first.name, second.name],
  );
  assert.equal(
    elements(page.renderAttentionAccounts(data)).filter(
      (node) => node.type === Chart,
    ).length,
    2,
  );
  for (const account of [first, second]) {
    const card = accountCards.find(
      (node) => node.props.title.props.children === account.name,
    );
    const chart = elements(card).find((node) => node.type === Chart);
    for (const series of chart.props.option.series) {
      assert.equal(series.type, "line");
      for (const point of series.data) {
        chart.props.onClick({
          data: point,
          dataIndex: 999,
          seriesName: "错误系列名",
        });
        assert.equal(page.state.chartDetail.amount, point.value * 100);
        const expected = account.transactions.filter(
          (row) =>
            row.occurred_at.slice(0, 10) === point.day &&
            row.source !== "证券余额更新" &&
            (point.flow === "income"
              ? row.kind === "INCOME"
              : point.flow === "expense"
                ? ["EXPENSE", "REFUND"].includes(row.kind)
                : row.kind === "TRANSFER" &&
                  row.account_change * (point.flow === "transfer-in" ? 1 : -1) >
                    0),
        );
        assert.deepEqual(
          page.state.chartDetail.transactions.map((row) => row.id),
          expected.map((row) => row.id),
        );
        assert.equal(
          page.state.chartDetail.amount,
          page.state.chartDetail.transactions.reduce(
            (sum, row) => sum + row.amount,
            0,
          ),
        );
      }
    }
    page.openSingle(account);
    assert.equal(page.state.chartDetail.amount, account.change);
    assert.deepEqual(
      page.state.chartDetail.transactions.map((row) => row.id),
      account.transactions.map((row) => row.id),
    );
    for (const flow of ["income", "expense"]) {
      page.openSingle(account, flow);
      assert.equal(
        page.state.chartDetail.amount,
        flow === "income" ? account.income : account.expense - account.refunds,
      );
    }
    const previous = page.state.chartDetail;
    chart.props.onClick({ data: { day: "2026-09-01", flow: "expense" } });
    assert.equal(page.state.chartDetail, previous);
    page.state.data = { ...data };
    chart.props.onClick({ data: chart.props.option.series[0].data[0] });
    assert.equal(page.state.chartDetail, previous);
    page.state.data = data;
  }
  assert.ok(
    elements(page.render())
      .filter((node) => node.type === Chart)
      .every((node) =>
        node.props.option.series.every((series) => series.type === "line"),
      ),
  );
  assert.equal(
    JSON.stringify(data),
    before,
    "Presentation and all drilldowns preserve the source snapshot",
  );
  const empty = new OverviewBalanceDistribution(
    { accounts: [], groups: [] },
    "ASSET",
  );
  assert.equal(empty.nodes.length, 0);
  assert.equal(empty.total, 0);
  assert.ok(
    renderToStaticMarkup(
      new OverviewBalanceFlow({
        snapshot: { accounts: [], groups: [] },
        role: "ASSET",
        onSelect() {},
      }).render(),
    ).includes("暂无正额资产"),
  );
  console.log(
    "Overview order/defaults, three-level assets/liabilities and every exact drilldown, independent account cash/curves, refunds/principal and stale-scope guards passed.",
  );
} finally {
  global.fetch = originalFetch;
}
