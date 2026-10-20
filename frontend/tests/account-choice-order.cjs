const assert = require("node:assert/strict");
const path = require("node:path");
const React = require("react");
const { loadTs } = require("./source-loader.cjs");
const source = (name) => loadTs(path.resolve(__dirname, "../src", name));
const { AccountChoices } = source("AccountChoices.ts");
const { AnalysisAccountSelection } = source("AnalysisAccountScope.tsx");
const { SidebarNavigation } = source("SidebarNavigation.tsx");
const { BillReviewModel } = source("BillReviewModel.ts");
const { ScopeFundFlowSection } = source("ScopeFundFlowSection.tsx");
const { SingleAccountWorkspace } = source("SingleAccountWorkspace.tsx");
const { InvestmentWorkspace } = source("InvestmentWorkspace.tsx");
const { AccountSettings } = source("AccountSettings.tsx");

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
  if (React.isValidElement(value)) return [value, ...elements(value.props, seen)];
  return Object.values(value).flatMap((child) => elements(child, seen));
}
function labelled(page, label) {
  const element = elements(page.render()).find(
    (row) => row.props["aria-label"] === label && row.props.options,
  );
  assert.ok(element, label);
  return element.props;
}
const noop = () => {};
const account = (id, patch = {}) => Object.freeze({
  id, name: "同名账户", role: "ASSET", kind: "银行", active: true,
  group_id: null, tags: [], balance: 0, ...patch,
});
const accounts = Object.freeze([
  account(10),
  account(20, { is_followed: true }),
  account(30, { role: "LIABILITY", active: false }),
  account(40, { is_followed: true, kind: "证券" }),
  account(50, { merged_into_id: 20, active: false }),
  account(60, { role: "SYSTEM" }),
  account(70, { is_followed: true, role: "LIABILITY", active: false }),
  account(80, { kind: "理财" }),
]);
const before = JSON.stringify(accounts);
const ids = (rows) => rows.map((row) => row.id);
assert.deepEqual(ids(AccountChoices.rank(accounts)), [20, 40, 70, 10, 30, 50, 60, 80]);
assert.deepEqual(ids(AccountChoices.rank(accounts, [])), ids(accounts));
assert.deepEqual(ids(AccountChoices.rank(accounts, [80])), [80, 10, 20, 30, 40, 50, 60, 70]);
assert.deepEqual(new AnalysisAccountSelection(accounts).choices().map((row) => row.id), [20, 40, 70, 10, 30, 80]);
assert.deepEqual(new BillReviewModel({}, accounts).choices().map((row) => row.value), [20, 40, 10, 80]);
const props = {
  accounts, groups: [], categories: [], tags: [], refreshKey: "test",
  onDetail: noop, onConfigure: noop, onValuation: noop, onChanged: noop,
  onUpdate: noop, onAccounts: noop,
};
// Exercise actual page selectors, including the advanced-filter slots.
for (const [name, label] of [
  ["IncomeWorkspace", "收入分析账户"],
  ["ExpenseWorkspace", "支出分析账户"],
  ["FinancialAnalysisWorkspace", "收支分析账户"],
  ["FundFlowWorkspace", "资金流转账户"],
  ["CounterpartyWorkspace", "交易方分析账户"],
]) {
  const page = instance(source(name + ".tsx")[name], props);
  page.state.filters = { ...page.state.filters, account_id: 10 };
  page.state.accountId = 10;
  let selector = labelled(page, label);
  assert.deepEqual(selector.options.map((row) => row.value), [20, 40, 70, 10, 30, 80], name);
  assert.equal(selector.value, 10, name + " preserves selection");
  page.props = {
    ...props,
    accounts: accounts.map((row) => ({ ...row, is_followed: row.id === 80 })),
  };
  selector = labelled(page, label);
  assert.deepEqual(selector.options.map((row) => row.value), [80, 10, 20, 30, 40, 70], name + " refreshes priorities");
  assert.equal(selector.value, 10);
}
// Investment choices can come from the report rather than the workspace list.
const investment = instance(InvestmentWorkspace, props);
investment.state.filters.account_id = 80;
assert.deepEqual(labelled(investment, "理财分析账户").options.map((row) => row.value), ["all", 40, 80]);
investment.state.report = {
  available_accounts: [account(80, { kind: "理财" }), account(40, { kind: "证券" })],
  account_count: 0,
};
assert.deepEqual(labelled(investment, "理财分析账户").options.map((row) => row.value), ["all", 40, 80]);
assert.equal(labelled(investment, "理财分析账户").value, 80);
const settings = instance(AccountSettings, props, { source: 10 });
assert.deepEqual(labelled(settings, "合并来源账户").options.map((row) => row.value), [20, 40, 10, 80]);
assert.deepEqual(labelled(settings, "合并目标账户").options.map((row) => row.value), [20, 40, 80]);

// Boundary analysis uses account_id keys; a refresh must retain a valid selection.
async function checkBoundary() {
  const boundary = instance(ScopeFundFlowSection, {
    filters: {}, refreshKey: "test", onDetail: noop, dimension: "account",
  }, { scopeKey: "account:10" });
  const scopes = [10, 20, 40].map((account_id) => ({ account_id, key: "account:" + account_id }));
  boundary.api.request = async () => ({
    account_scopes: scopes, group_scopes: [{ key: "group:1" }],
    account_scope: { followed_account_ids: [20, 40] }, summary: { key: "total" },
  });
  await boundary.load();
  assert.deepEqual(boundary.scopes().map((row) => row.account_id), [20, 40, 10]);
  assert.equal(boundary.state.scopeKey, "account:10");
  assert.deepEqual(boundary.scopes("group").map((row) => row.key), ["group:1"]);
  assert.deepEqual(scopes.map((row) => row.account_id), [10, 20, 40]);
}
const single = instance(SingleAccountWorkspace, props, {
  selected: "10", loading: false,
  report: { accounts: [accounts[0], accounts[6], accounts[1]] },
});
single.renderAccount = () => null;
single.renderComparison = () => null;
const buttons = () => elements(single.render()).filter(
  (row) => row.type === "button" && row.props.className?.startsWith("single-account-option"),
);
assert.deepEqual(buttons().map((row) => Number(row.key)), [70, 20, 10]);
assert.equal(Number(buttons().find((row) => row.props["aria-pressed"]).key), 10);
single.state.search = "不存在";
assert.equal(buttons().length, 0);
assert.equal(single.state.selected, "10");
assert.equal(JSON.stringify(accounts), before, "selectors do not mutate workspace data");

// The reports branch starts open on every entry route, alongside its active branch.
for (const page of ["overview", "accounts", "reports", "bills", "settings"]) {
  const sidebar = instance(SidebarNavigation, { page, reportTab: "expenses", onNavigate: noop });
  assert.ok(sidebar.state.openKeys.includes("reports"), page);
}
const sidebar = instance(SidebarNavigation, { page: "overview", reportTab: "expenses", onNavigate: noop });
sidebar.render().props.children.props.onOpenChange(["reports", "ledger"]);
assert.deepEqual(sidebar.state.openKeys, ["reports", "ledger"]);
sidebar.render().props.children.props.onOpenChange([]);
sidebar.componentDidUpdate(sidebar.props);
assert.deepEqual(sidebar.state.openKeys, []);
let previous = sidebar.props;
sidebar.props = { ...previous, page: "accounts" };
sidebar.componentDidUpdate(previous);
assert.deepEqual(sidebar.state.openKeys, []);
previous = sidebar.props;
sidebar.props = { ...previous, page: "reports" };
sidebar.componentDidUpdate(previous);
assert.deepEqual(sidebar.state.openKeys, ["reports"]);

checkBoundary().then(() => {
  console.log("Followed-first account selectors, refresh/selection preservation and expanded reports passed.");
}).catch((error) => { console.error(error); process.exitCode = 1; });
