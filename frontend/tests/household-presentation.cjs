const assert = require("node:assert/strict"),
  path = require("node:path"),
  React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { loadTs } = require("./source-loader.cjs");
const source = (name) => loadTs(path.resolve(__dirname, "../src", name));
const { ReportMetrics } = source("ReportMetrics.ts");
const { IncomeWorkspace } = source("IncomeWorkspace.tsx");
const { ExpenseWorkspace } = source("ExpenseWorkspace.tsx");
const { FinancialAnalysisWorkspace } = source("FinancialAnalysisWorkspace.tsx");
function freeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
function elements(tree, result = []) {
  if (Array.isArray(tree)) tree.forEach((child) => elements(child, result));
  else if (React.isValidElement(tree)) {
    result.push(tree);
    Object.values(tree.props).forEach((value) => elements(value, result));
  } else if (tree && typeof tree === "object")
    Object.values(tree).forEach((value) => elements(value, result));
  return result;
}
function workspace(Component, report, onDetail = () => {}) {
  const instance = new Component({
    accounts: [{ id: 1, name: "工资卡", role: "ASSET", group_id: 1 }],
    groups: [{ id: 1, name: "家庭", parent_id: null }],
    categories: [
      { id: 1, name: "工资", kind: "INCOME", active: true, parent_id: null },
      { id: 2, name: "副业", kind: "INCOME", active: true, parent_id: null },
      { id: 3, name: "餐饮", kind: "EXPENSE", active: true, parent_id: null },
      {
        id: 4,
        name: "未知用途",
        kind: "EXPENSE",
        active: true,
        parent_id: null,
      },
    ],
    tags: [],
    refreshKey: "test",
    onDetail,
  });
  instance.state = {
    ...instance.state,
    report,
    loading: false,
    filters: { start: "2026-10-01", end: "2026-10-18" },
  };
  instance.setState = (patch, done) => {
    instance.state = {
      ...instance.state,
      ...(typeof patch === "function" ? patch(instance.state) : patch),
    };
    done?.();
  };
  instance.load = () => {};
  return instance;
}
const tx = (id, kind, amount) => ({
  id,
  kind,
  direction: kind === "INCOME" ? "INCOME" : "EXPENSE",
  amount,
  occurred_at: "2026-10-02 12:00:00",
  counterparty: "测试交易方",
  category_names: [kind === "INCOME" ? "工资" : "餐饮"],
  account_names: ["工资卡"],
});
const income = freeze({
  income: 10000,
  count: 3,
  start: "2026-10-01",
  end: "2026-10-18",
  average: 3333,
  average_daily: 555,
  change: 1000,
  change_ratio: null,
  previous_start: "2026-09-13",
  previous_end: "2026-09-30",
  categories: [
    { id: 1, name: "工资", amount: 6000, count: 1, share: 0.6 },
    { id: 2, name: "副业", amount: 4000, count: 2, share: 0.4 },
  ],
  sources: [
    { name: "甲", amount: 5000, count: 1 },
    { name: "乙", amount: 3000, count: 1 },
    { name: "未填写交易方", amount: 2000, count: 1 },
  ],
  accounts: [{ id: 1, name: "工资卡", amount: 10000, count: 3 }],
  large_income: 3000,
  large_count: 1,
  large_amount_minor: 2500,
  large_transactions: [tx(2, "INCOME", 3000)],
  transactions: [
    tx(1, "INCOME", 5000),
    tx(2, "INCOME", 3000),
    tx(3, "INCOME", 2000),
  ],
  trend: [{ period: "2026-10-02", income: 10000 }],
  group_categories: [
    { group_id: 1, category_id: 1, name: "工资", amount: 10000 },
  ],
});
const expense = freeze({
  paid: 10000,
  refunds: 12000,
  expense: -2000,
  count: 5,
  refund_count: 2,
  income: 0,
  net: 2000,
  days: 18,
  average_daily: -111,
  start: "2026-10-01",
  end: "2026-10-18",
  previous_start: "2026-09-13",
  previous_end: "2026-09-30",
  change: -7000,
  parents: [
    {
      id: 3,
      name: "餐饮",
      amount: 3000,
      paid: 6000,
      refunds: 3000,
      count: 3,
      share: 1,
      previous_amount: 5000,
      change: -2000,
    },
    {
      id: 4,
      name: "未知用途",
      amount: -5000,
      paid: 4000,
      refunds: 9000,
      count: 2,
      share: 0,
      previous_amount: 0,
      change: -5000,
    },
  ],
  unknown_amount: 0,
  merchants: [
    {
      name: "超市",
      count: 3,
      amount: -2000,
      refund_count: 2,
      active_days: 1,
      average: -666,
    },
  ],
  frequent_merchants: [],
  large_count: 1,
  large_paid: 4000,
  large_amount_minor: 3000,
  group_categories: [
    { group_id: 1, category_id: 3, name: "餐饮", amount: 3000 },
    { group_id: 1, category_id: 4, name: "未知用途", amount: -5000 },
  ],
  large_transactions: [tx(10, "EXPENSE", 4000)],
  transactions: [tx(10, "EXPENSE", 10000), tx(11, "REFUND", -12000)],
  trend: [{ day: "2026-10-02", expense: -2000 }],
});
const financial = freeze({
  income: 10000,
  expense: 4000,
  net: 6000,
  count: 3,
  income_count: 1,
  expense_count: 1,
  large_count: 2,
  large_share: 2 / 3,
  large_amount_minor: 1000,
  categories: {
    income: [{ id: 1, name: "工资", amount: 10000, count: 1, share: 1 }],
    expense: [
      { id: 3, name: "餐饮", amount: 6000, count: 1, share: 1 },
      { id: 4, name: "退款", amount: -2000, count: 0, share: 0 },
    ],
  },
  transactions: [
    tx(21, "INCOME", 10000),
    tx(22, "EXPENSE", 6000),
    tx(23, "REFUND", 2000),
  ],
  large_transactions: [tx(22, "EXPENSE", 6000), tx(23, "REFUND", 2000)],
  trend: [{ period: "2026-10-02", income: 10000, expense: 4000, net: 6000 }],
});
for (const [n, d] of [
  [0, 0],
  [1, 0],
  [-1, 10],
  [11, 10],
  [NaN, 10],
  [1, Infinity],
])
  assert.equal(ReportMetrics.percentage(n, d), undefined);
assert.equal(ReportMetrics.percentage(1, 100000), "<0.1%");
assert.equal(ReportMetrics.percentage(99999, 100000), ">99.9%");
for (const [Component, report] of [
  [IncomeWorkspace, income],
  [ExpenseWorkspace, expense],
  [FinancialAnalysisWorkspace, financial],
]) {
  const instance = workspace(Component, report, () => {});
  const html = renderToStaticMarkup(instance.render());
  assert(
    !html.includes("本期看点") && !html.includes('class="analysis-readout'),
  );
  assert(html.includes("统计口径与读图说明"));
  assert(!html.includes("NaN") && !html.includes("Infinity"));
}
console.log(
  "Household presentation: shared percentages, removed readouts and 3-page SSR passed.",
);
