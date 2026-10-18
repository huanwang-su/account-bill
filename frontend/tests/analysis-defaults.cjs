const assert = require("node:assert/strict");
const path = require("node:path");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { loadTs } = require("./source-loader.cjs");
const source = (name) => loadTs(path.resolve(__dirname, "../src", name));
const { FinancialAnalysisWorkspace } = source("FinancialAnalysisWorkspace.tsx");
const { IncomeWorkspace } = source("IncomeWorkspace.tsx");
const { ExpenseWorkspace } = source("ExpenseWorkspace.tsx");
const { FundFlowWorkspace } = source("FundFlowWorkspace.tsx");
const { OverviewWorkspace } = source("OverviewWorkspace.tsx");
const { ReportAccountFilters } = source("ReportAccountFilters.tsx");
const { AnalysisSettings } = source("AnalysisSettings.tsx");
const { AccountMovementSection } = source("AccountMovementSection.tsx");
const { PagedTable } = source("PagedTable.tsx");
const { Chart } = source("Chart.tsx");
const { message } = require("antd");
message.success = () => {};
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
function elements(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  if (React.isValidElement(value))
    return [value, ...elements(value.props, seen)];
  return Object.values(value).flatMap((child) => elements(child, seen));
}
const labelled = (value, label) =>
  elements(value).find((row) => row.props["aria-label"] === label);
const config = {
  revision: 5,
  exclude_investment_accounts: false,
  exclude_single_accounts: false,
  large_income_threshold_minor: 250001,
  large_expense_threshold_minor: 80001,
  income_excluded_account_ids: [],
  expense_excluded_account_ids: [],
  single_account_ids: [],
  single_account_modes: {},
};
const report = {
  account_scope: config,
  large_income_amount_minor: 250001,
  large_expense_amount_minor: 80001,
  large_amount_minor: 80001,
  transactions: [],
  categories: { income: [], expense: [] },
  trend: [],
  income: 0,
  expense: 0,
  net: 0,
  count: 0,
  income_count: 0,
  expense_count: 0,
  refund_count: 0,
  large_count: 3,
  large_transactions: [
    {
      id: 1,
      direction: "INCOME",
      kind: "INCOME",
      amount: 300000,
      category_names: ["工资"],
    },
    {
      id: 2,
      direction: "EXPENSE",
      kind: "EXPENSE",
      amount: 100000,
      category_names: ["购物"],
    },
    {
      id: 3,
      direction: "EXPENSE",
      kind: "REFUND",
      amount: 90000,
      category_names: ["购物"],
    },
  ],
};
const props = {
  accounts: [],
  groups: [],
  categories: [],
  tags: [],
  refreshKey: "test",
  onDetail() {},
};
async function run() {
  const settings = instance(
    AnalysisSettings,
    { accounts: [], onChanged() {}, onSingleAccounts() {} },
    { config, loading: false },
  );
  assert.equal(
    labelled(settings.render(), "大额收入默认门槛").props.value,
    2500.01,
  );
  assert.equal(
    labelled(settings.render(), "大额支出默认门槛").props.value,
    800.01,
  );
  labelled(settings.render(), "大额收入默认门槛").props.onChange(1234.56);
  labelled(settings.render(), "默认屏蔽所选单账户").props.onChange(true);
  assert.equal(settings.state.config.large_income_threshold_minor, 123456);
  let body;
  settings.api.request = async (_, method, payload) => {
    body = payload;
    return payload;
  };
  await settings.save();
  assert.equal(body.large_income_threshold_minor, 123456);
  assert.equal(body.large_expense_threshold_minor, 80001);
  assert.equal(body.exclude_single_accounts, true);
  assert.equal(body.exclude_investment_accounts, false);

  for (const Component of [
    FinancialAnalysisWorkspace,
    IncomeWorkspace,
    ExpenseWorkspace,
    FundFlowWorkspace,
    OverviewWorkspace,
  ]) {
    const page = instance(Component, props);
    let url;
    page.api.request = async (value) => {
      url = value;
      return report;
    };
    await page.load();
    const query = new URLSearchParams(url.split("?")[1]);
    assert.equal(
      query.has("large_amount"),
      false,
      `${Component.name} must defer initial thresholds to settings`,
    );
    assert.equal(query.has("exclude_investment_accounts"), false);
    assert.equal(query.has("exclude_single_accounts"), false);
    assert.equal(page.state.filters.exclude_single_accounts, undefined);
    if (
      Component === FinancialAnalysisWorkspace ||
      Component === FundFlowWorkspace
    ) {
      const filter = elements(page.render()).find(
        (row) => row.type === ReportAccountFilters,
      );
      const rendered = new ReportAccountFilters(filter.props).render();
      assert.equal(labelled(rendered, "屏蔽证券理财账户").props.checked, false);
      assert.equal(labelled(rendered, "屏蔽单账户名单").props.checked, false);
    }
  }
  const page = instance(FinancialAnalysisWorkspace, props, {
    report,
    loading: false,
  });
  let bodyView = page.renderLargeAnalysis(report);
  let table = elements(bodyView).find((row) => row.type === PagedTable);
  assert.deepEqual(
    table.props.dataSource.map((row) => row.id),
    [2, 3],
  );
  assert.equal(labelled(bodyView, "大额交易门槛").props.value, 800.01);
  const rank = elements(bodyView).find((row) => row.type === Chart);
  assert.deepEqual(
    rank.props.option.series[0].data.map((row) => row.value),
    [1000, -900],
  );
  labelled(bodyView, "大额交易门槛").props.onChange(1200);
  assert.equal(page.state.expenseThreshold, 1200);
  assert.equal(page.state.threshold, undefined);
  labelled(bodyView, "大额分析收支方向").props.onChange("INCOME");
  bodyView = page.renderLargeAnalysis(report);
  assert.equal(labelled(bodyView, "大额交易门槛").props.value, 2500.01);
  table = elements(bodyView).find((row) => row.type === PagedTable);
  assert.deepEqual(
    table.props.dataSource.map((row) => row.id),
    [1],
  );
  labelled(bodyView, "大额交易门槛").props.onChange(3100);
  let query;
  page.api.request = async (url) => {
    query = new URLSearchParams(url.split("?")[1]);
    return report;
  };
  await page.load();
  assert.equal(query.get("large_income_amount"), "3100");
  assert.equal(query.get("large_expense_amount"), "1200");
  page.resetFilters();
  assert.equal(page.state.threshold, undefined);
  assert.equal(page.state.expenseThreshold, undefined);
  const negative = {
    start: "2026-07-15",
    end: "2026-10-18",
    accounts: [],
    totals: {
      opening_balance: 0,
      ending_balance: -52653505,
      opening_added: -53762651,
      net_change: -52653505,
      operating_change: 1109146,
      ending_assets: 54836095,
      ending_liabilities: 107489600,
    },
    account_scope: { excluded_account_ids: [1, 2] },
  };
  const section = new AccountMovementSection({ report: negative, groups: [] });
  const html = renderToStaticMarkup(section.render());
  for (const label of [
    "所选范围期末净值",
    "548,360.95",
    "1,074,896.00",
    "-526,535.05",
    "不是完整家庭净资产",
    "负值不表示期间亏损",
  ])
    assert.ok(html.includes(label), label);
  assert.ok(!html.includes("NaN"));
  console.log(
    "Persisted settings UI/payload, all initial report defaults, separate income/expense thresholds and exact negative-position explanation passed.",
  );
}
run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
