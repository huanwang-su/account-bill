const assert = require("node:assert/strict"),
  path = require("node:path"),
  React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { message } = require("antd");
message.success = () => {};
message.error = (value) => {
  throw new Error(String(value));
};
const { loadTs } = require("./source-loader.cjs");
const src = (name) => loadTs(path.resolve(__dirname, "../src", name));
const { OverviewWorkspace } = src("OverviewWorkspace.tsx"),
  { ReportAccountFilters } = src("ReportAccountFilters.tsx"),
  { FinancialAnalysisWorkspace } = src("FinancialAnalysisWorkspace.tsx"),
  { FundFlowWorkspace } = src("FundFlowWorkspace.tsx"),
  { ScopeFundFlowSection } = src("ScopeFundFlowSection.tsx"),
  { Chart } = src("Chart.tsx"),
  { ReportPeriodFilter } = src("ReportPeriodFilter.tsx"),
  { AnalysisSettings } = src("AnalysisSettings.tsx");
function instance(Class, props, state = {}) {
  const v = new Class(props);
  v.state = { ...v.state, ...state };
  v.setState = (patch, done) => {
    v.state = {
      ...v.state,
      ...(typeof patch === "function" ? patch(v.state) : patch),
    };
    done?.();
  };
  return v;
}
function elements(x) {
  if (Array.isArray(x)) return x.flatMap(elements);
  if (React.isValidElement(x))
    return [x, ...Object.values(x.props).flatMap(elements)];
  if (x && typeof x === "object") return Object.values(x).flatMap(elements);
  return [];
}
const find = (tree, predicate) => elements(tree).find(predicate);
const transaction = {
  id: 1,
  kind: "INCOME",
  occurred_at: "2026-10-02 12:00:00",
  amount: 1000,
  account_change: 1000,
  entries: [],
  category_names: [],
  counterparty: "工资",
};
const account = {
  id: 1,
  name: "关注账户",
  role: "ASSET",
  kind: "微信",
  group_id: 1,
  ending_balance: 5000,
  change: 1000,
  income: 1000,
  expense: 0,
  refunds: 0,
  transfer_net: 0,
  transactions: [transaction],
};
const data = {
  as_of: "2026-10-31",
  month_start: "2026-10-01",
  period: {
    start: "2026-10-01",
    end: "2026-10-31",
    preset: "latest_month",
    latest_data_date: "2026-10-02",
  },
  assets: 10000,
  liabilities: 2000,
  net_assets: 8000,
  account_count: 1,
  balance_sheet: { accounts: [account] },
  groups: [],
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
    categories: [{ id: 1, name: "工资", amount: 1000 }],
    trend: [{ period: "2026-10-02", income: 1000 }],
  },
  investments: { assets: 3000, profit: 50, account_count: 1 },
  investment_report: {
    ending: 3000,
    profit: 50,
    account_count: 1,
    capital_in: 200,
    capital_out: 100,
    trend: [{ period: "2026-10-02", profit: 50 }],
  },
  single_accounts: { accounts: [account] },
  pending_count: 0,
};
const overview = instance(
  OverviewWorkspace,
  {
    refreshKey: "x",
    onReport() {},
    onAccounts() {},
    onPending() {},
    onImport() {},
    onDetail() {},
    onConfigure() {},
  },
  { data, loading: false },
);
const html = renderToStaticMarkup(overview.render());
for (const text of [
  "家庭财务总览",
  "收入 · 来源与节奏",
  "支出 · 开支节奏",
  "理财 · 收益与本金",
  "关注账户 · 独立核对",
  "屏蔽证券理财账户",
  "屏蔽单账户名单",
  "屏蔽指定账户",
])
  assert.ok(html.includes(text), text);
let loads = 0;
overview.load = async () => {
  loads++;
};
find(overview.render(), (x) => x.type === ReportPeriodFilter).props.onChange({
  period: "3m",
});
assert.equal(overview.state.filters.period, "3m");
assert.equal(loads, 1);
const queries = ReportAccountFilters.query({
  exclude_investment_accounts: false,
  exclude_single_accounts: true,
  excluded_account_ids: [1, 2],
});
assert.deepEqual(JSON.parse(queries.excluded_account_ids), [1, 2]);
assert.equal(queries.exclude_investment_accounts, false);
assert.equal(queries.exclude_single_accounts, true);
let chosen;
overview.openChart = (selection) => {
  chosen = selection;
};
const income = find(
  overview.render(),
  (x) => x.type === Chart && x.props.label === "总览区间收入趋势",
);
income.props.onClick({ data: { day: "2026-10-02" } });
assert.equal(chosen.section, "income");
assert.equal(chosen.day, "2026-10-02");
overview.state.data = { ...data };
chosen = undefined;
income.props.onClick({ data: { day: "2026-10-02" } });
assert.equal(
  chosen,
  undefined,
  "Stale overview chart must not read a new scope",
);
overview.state.data = data;
overview.openSingle(account);
assert.equal(overview.state.chartDetail.amount, 1000);
assert.equal(overview.state.chartDetail.transactions[0].amount, 1000);
assert.equal(account.transactions[0], transaction);
const funds = instance(
  FundFlowWorkspace,
  { accounts: [account], groups: [], refreshKey: "x", onDetail() {} },
  { loading: false },
);
for (const perspective of ["total", "group", "account"]) {
  funds.state.perspective = perspective;
  const scope = find(funds.render(), (x) => x.type === ScopeFundFlowSection);
  assert.equal(scope.props.dimension, perspective);
  assert.equal(
    scope.props.filters.exclude_investment_accounts,
    undefined,
    "Unset defaults are resolved by saved server configuration",
  );
}
let scopeLoads = 0;
const section = instance(ScopeFundFlowSection, {
  filters: {},
  refreshKey: "x",
  onDetail() {},
});
section.load = () => scopeLoads++;
const old = section.props;
section.props = { ...old, filters: { exclude_single_accounts: true } };
section.componentDidUpdate(old);
assert.equal(scopeLoads, 1);
assert.equal(section.scopeFilters().exclude_single_accounts, true);
async function verifyRequests() {
  const financial = instance(
    FinancialAnalysisWorkspace,
    {
      accounts: [account],
      groups: [],
      categories: [],
      tags: [],
      refreshKey: "x",
      onDetail() {},
    },
    {
      loading: false,
      filters: {
        exclude_investment_accounts: false,
        exclude_single_accounts: true,
        excluded_account_ids: [1],
      },
    },
  );
  let url;
  financial.api.request = async (value) => {
    url = value;
    return { transactions: [] };
  };
  await financial.load();
  const params = new URLSearchParams(url.split("?")[1]);
  assert.equal(params.get("exclude_single_accounts"), "true");
  assert.equal(params.get("exclude_investment_accounts"), "false");
  assert.deepEqual(JSON.parse(params.get("excluded_account_ids")), [1]);
  const config = {
    revision: 1,
    exclude_investment_accounts: true,
    income_excluded_account_ids: [],
    expense_excluded_account_ids: [],
    single_account_ids: [1],
    single_account_modes: { 1: "both" },
  };
  const settings = instance(
    AnalysisSettings,
    { accounts: [account], onChanged() {}, onSingleAccounts() {} },
    { config, loading: false },
  );
  assert.ok(renderToStaticMarkup(settings.render()).includes("关注账户"));
  let payload;
  settings.api.request = async (_, method, body) => {
    payload = body;
    return body;
  };
  await settings.save();
  assert.deepEqual(payload.single_account_ids, [1]);
  assert.ok(!Object.hasOwn(payload, "overview_account_ids"));
  assert.ok(
    !renderToStaticMarkup(settings.render()).includes("总览展示的单账户"),
  );
}
verifyRequests()
  .then(() =>
    console.log(
      "Dashboard period/core panels, independent attention accounts, shared exclusions, explicit requests and fund perspectives passed.",
    ),
  )
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
