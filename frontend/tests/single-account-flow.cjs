const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { loadTs } = require("./source-loader.cjs");
const source = (name) => loadTs(path.resolve(__dirname, "../src", name));
const { SingleAccountFlowData } = source("SingleAccountFlowData.ts");
const { SingleAccountFlow } = source("SingleAccountFlow.tsx");
const { SingleAccountDrilldown } = source("SingleAccountDrilldown.ts");
const { SingleAccountWorkspace } = source("SingleAccountWorkspace.tsx");
const { DistributionDiagram, distributionOption } = source("DistributionDiagram.tsx");
const { Chart } = source("Chart.tsx");
const { PagedTable } = source("PagedTable.tsx");

function instance(Component, props, patch = {}) {
  const value = new Component(props);
  value.state = { ...value.state, ...patch };
  value.setState = (next, done) => {
    value.state = { ...value.state, ...(typeof next === "function" ? next(value.state) : next) };
    done?.();
  };
  return value;
}
function elements(tree, result = []) {
  if (Array.isArray(tree)) tree.forEach((child) => elements(child, result));
  else if (React.isValidElement(tree)) {
    result.push(tree);
    for (const value of Object.values(tree.props))
      if (React.isValidElement(value) || Array.isArray(value)) elements(value, result);
  }
  return result;
}
function only(values) {
  assert.equal(values.length, 1);
  return values[0];
}
function ids(scope) {
  return scope.movement.transaction_ids;
}
function freeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(freeze);
  }
  return value;
}
function conservation(graph) {
  assert.equal(graph.total, graph.positiveTotal);
  assert.equal(graph.signedTotal, graph.incoming - graph.outgoing);
  assert.equal(graph.positiveTotal, graph.incoming + graph.outgoing);
  assert.equal(new Set(graph.nodes.map((node) => node.name)).size, graph.nodes.length);
  for (const depth of [0, 1, 2])
    assert.equal(graph.nodes.filter((node) => node.depth === depth).reduce((sum, node) => sum + node.value, 0), graph.positiveTotal);
  for (const node of graph.nodes) {
    assert.ok(Number.isInteger(node.value) && node.value > 0);
    if (node.depth > 0)
      assert.equal(graph.links.filter((link) => link.target === node.name).reduce((sum, link) => sum + link.value, 0), node.value);
    if (node.depth < 2)
      assert.equal(graph.links.filter((link) => link.source === node.name).reduce((sum, link) => sum + link.value, 0), node.value);
    assert.equal(new Set(ids(graph.selectionFor(node.name))).size, ids(graph.selectionFor(node.name)).length);
    assert.equal(graph.selectionFor(node.name).movement.mode, graph.mode);
  }
  for (const link of graph.links) {
    assert.ok(Number.isInteger(link.value) && link.value > 0);
    assert.equal(Math.abs(link.signedValue), link.value);
    assert.equal(link.shareTotal, graph.positiveTotal);
    assert.deepEqual(graph.selection({ dataType: "edge", data: link }), graph.selectionFor(link.target));
  }
  assert.equal(new Set(ids(graph.all())).size, ids(graph.all()).length);
  assert.equal(graph.selectionFor("not-a-node"), undefined);
  assert.equal(graph.selection({ dataType: "legend", data: graph.nodes[0] }), undefined);
}
const funding = (amount, id = 42, name = "分析账户") => ({ account_id: id, account: name, role: "ASSET", amount, category_id: null });
const category = (amount, id, name) => ({ account_id: 1, role: "SYSTEM", amount, category_id: id, category: name, selected: true });
const transaction = (id, kind, change, entries, extra = {}) => ({
  id, kind, amount: Math.abs(change), account_change: change,
  occurred_at: `2026-10-${String(id).padStart(2, "0")} 12:00:00`,
  counterparty: "同名往来", note: "", source: "手工", category_names: [], entries,
  ...extra,
});
const transactions = [
  transaction(1, "INCOME", 3000, [funding(3000), category(-3000, 101, "工资")]),
  transaction(2, "EXPENSE", -1000, [funding(-1000), category(600, 201, "餐饮"), category(400, 202, "交通")]),
  transaction(3, "REFUND", 200, [funding(200), category(-200, 201, "餐饮")], { related_id: 2 }),
  transaction(4, "TRANSFER", 500, [funding(500), funding(-500, 77, "同名对端")]),
  transaction(5, "TRANSFER", -700, [funding(-700), funding(700, 78, "同名对端")]),
  transaction(6, "INCOME", 100, [funding(100), category(-100, 301, "理财收益")], { source: "证券余额更新" }),
  transaction(7, "EXPENSE", -50, [funding(-50), category(50, 302, "投资亏损")], { source: "证券余额更新" }),
  transaction(8, "OPENING", 400, [funding(400), category(-400, null, "")]),
  transaction(9, "ADJUSTMENT", -30, [funding(-30), category(30, null, "")]),
];
function party(key, rows, name = "同名往来", valuation = false) {
  const incoming = rows.reduce((sum, row) => sum + Math.max(0, row.account_change), 0);
  const outgoing = rows.reduce((sum, row) => sum + Math.max(0, -row.account_change), 0);
  return { key, counterparty: name, valuation, incoming, outgoing, net: incoming - outgoing, count: rows.length, transactions: rows };
}
const account = freeze({
  id: 42, name: "完整账户名称 · 用于单账户流向验证", role: "ASSET", kind: "证券", analysis_mode: "both",
  opening_balance: 10000, ending_balance: 12420, change: 2420, reconciled: true, count: 8,
  income: 3000, expense: 1000, refunds: 200, transfer_in: 500, transfer_out: 700,
  valuation_profit: 50, adjustments: 370,
  categories: [
    { id: 101, kind: "INCOME", name: "工资", amount: 3000, count: 1, transaction_ids: [1] },
    { id: 201, kind: "EXPENSE", name: "餐饮", amount: 600, count: 1, transaction_ids: [2] },
    { id: 202, kind: "EXPENSE", name: "交通", amount: 400, count: 1, transaction_ids: [2] },
  ],
  trend: [{ day: "2026-10-01", balance: 12420, change: 2420, income: 3000, expense: 800 }],
  transactions,
  counterparties: {
    incoming: 3700, outgoing: 1730, net: 1970, party_count: 2, valuation_count: 2,
    parties: [party("party:alpha", [transactions[0], transactions[1], transactions[2], transactions[8]]), party("party:beta", [transactions[3], transactions[4]])],
    valuations: [party("valuation:同名往来", [transactions[5], transactions[6]], "同名往来", true)],
  },
});
const before = JSON.stringify(account);
const cashflow = new SingleAccountFlowData(account, "cashflow");
conservation(cashflow);
assert.deepEqual([cashflow.incoming, cashflow.outgoing, cashflow.total, cashflow.signedTotal], [4200, 1780, 5980, 2420]);
assert.deepEqual(ids(cashflow.all()), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
assert.equal(cashflow.unallocated, 0);
const food = only(cashflow.nodes.filter((node) => node.depth === 2 && node.displayName === "餐饮"));
const transport = only(cashflow.nodes.filter((node) => node.depth === 2 && node.displayName === "交通"));
assert.deepEqual([food.value, transport.value], [600, 400]);
assert.deepEqual(ids(cashflow.selectionFor(food.name)), [2]);
assert.deepEqual(ids(cashflow.selectionFor(transport.name)), [2]);
assert.equal(SingleAccountDrilldown.rows(account, cashflow.selectionFor(food.name))[0].account_change, -1000);
assert.equal(only(cashflow.nodes.filter((node) => node.depth === 1 && node.displayName === "收入")).value, 3000);
assert.deepEqual(ids(cashflow.selectionFor(only(cashflow.nodes.filter((node) => node.depth === 1 && node.displayName === "退款")).name)), [3]);
assert.equal(cashflow.nodes.filter((node) => node.depth === 1 && node.displayName.includes("估值")).reduce((sum, node) => sum + node.value, 0), 150);
const transferLeaves = cashflow.nodes.filter((node) => node.depth === 2 && node.displayName === "同名对端");
assert.equal(transferLeaves.length, 2);
assert.notEqual(transferLeaves[0].name, transferLeaves[1].name);
assert.deepEqual(new Set(transferLeaves.flatMap((node) => ids(cashflow.selectionFor(node.name)))), new Set([4, 5]));
const selectedCopy = cashflow.selectionFor(food.name);
selectedCopy.movement.transaction_ids.push(9999);
assert.deepEqual(ids(cashflow.selectionFor(food.name)), [2]);
const option = distributionOption(cashflow);
const foodEdge = only(cashflow.links.filter((link) => link.target === food.name));
assert.ok(option.tooltip.formatter({ dataType: "edge", data: foodEdge }).includes("-6.00"));
assert.equal(option.animation, false);

const counterparties = new SingleAccountFlowData(account, "counterparties");
conservation(counterparties);
assert.deepEqual([counterparties.incoming, counterparties.outgoing, counterparties.total, counterparties.signedTotal], [3700, 1730, 5430, 1970]);
assert.deepEqual(ids(counterparties.all()), [1, 2, 3, 4, 5, 9]);
assert.equal(counterparties.excludedValuationCount, 2);
assert.equal(counterparties.partyCount, 2);
const partyLeaves = counterparties.nodes.filter((node) => node.depth === 2);
assert.equal(partyLeaves.length, 4);
assert.equal(new Set(partyLeaves.map((node) => node.name)).size, 4);
assert.equal(new Set(partyLeaves.map((node) => node.displayName)).size, 1);
assert.deepEqual(new Set(partyLeaves.map((node) => ids(counterparties.selectionFor(node.name)).join(","))), new Set(["1,3", "2,9", "4", "5"]));
assert.deepEqual(SingleAccountDrilldown.rows(account, { movement: { key: "empty", label: "空范围", mode: "cashflow", transaction_ids: [] } }), []);
assert.deepEqual(SingleAccountDrilldown.rows(account, { ...cashflow.all(), day: "2026-10-03" }).map((row) => row.id), [3]);
assert.equal(SingleAccountDrilldown.sanitize({ ...account, analysis_mode: "counterparties" }, cashflow.all()).movement, undefined);
assert.equal(SingleAccountDrilldown.sanitize({ ...account, analysis_mode: "cashflow" }, counterparties.all()).movement, undefined);
assert.equal(JSON.stringify(account), before);

const opening = transaction(20, "OPENING", 500, [funding(500)], { source: "证券余额更新" });
const baseline = new SingleAccountFlowData({ ...account, categories: [], transactions: [opening, transactions[5]] }, "cashflow");
assert.deepEqual(ids(baseline.selectionFor(only(baseline.nodes.filter((node) => node.depth === 1 && node.displayName.includes("期初"))).name)), [20]);
assert.equal(baseline.nodes.filter((node) => node.depth === 1 && node.displayName.includes("估值")).reduce((sum, node) => sum + node.value, 0), 100);
conservation(baseline);
const multiFunding = transaction(30, "EXPENSE", -300, [funding(-300), funding(-300, 77), category(600, 201, "餐饮")]);
const ambiguous = transaction(31, "EXPENSE", -250, [funding(-250), category(150, 211, "子项甲"), category(100, 212, "子项乙")]);
for (const [row, categories, expected] of [
  [multiFunding, [{ id: 201, kind: "EXPENSE", name: "餐饮", amount: 600, transaction_ids: [30] }], 300],
  [ambiguous, [{ id: 209, kind: "EXPENSE", name: "父项甲", amount: 150, transaction_ids: [31] }, { id: 210, kind: "EXPENSE", name: "父项乙", amount: 100, transaction_ids: [31] }], 250],
]) {
  const graph = new SingleAccountFlowData({ ...account, categories, transactions: [row] }, "cashflow");
  conservation(graph);
  assert.equal(graph.total, expected);
  assert.equal(graph.unallocated, expected);
  assert.equal(only(graph.nodes.filter((node) => node.depth === 2)).displayName, "分类未分配");
  assert.deepEqual(ids(graph.all()), [row.id]);
}
const repeated = new SingleAccountFlowData({ ...account, transactions: [...transactions, transactions[1], transaction(32, "TRANSFER", 0, [funding(0)])] }, "cashflow");
assert.equal(repeated.total, cashflow.total);
assert.deepEqual(ids(repeated.all()), ids(cashflow.all()));
const liability = new SingleAccountFlowData({ ...account, role: "LIABILITY", opening_balance: -20000 }, "cashflow");
assert.deepEqual([liability.incoming, liability.outgoing, liability.signedTotal], [4200, 1780, 2420]);
const missingAmounts = new SingleAccountFlowData({ ...account, categories: [], transactions: [
  { id: 40, kind: "TRANSFER", amount: 999, entries: [funding(60), funding(-10), funding(-50, 77)] },
  { id: 41, kind: "INCOME", amount: 999, entries: [funding(999, 77)] },
] }, "cashflow");
conservation(missingAmounts);
assert.equal(missingAmounts.total, 50, "Use this account's signed entries, never the whole transaction amount");
assert.equal(missingAmounts.unavailableCount, 1);
assert.deepEqual(ids(missingAmounts.all()), [40]);

const rankedRows = Array.from({ length: 10 }, (_, index) => transaction(1001 + index, "INCOME", (index + 1) * 100, [], { occurred_at: "2026-10-10 12:00:00" }));
const rankedAccount = { ...account, transactions: rankedRows, counterparties: { parties: rankedRows.map((row, index) => party(`party:${index}`, [row], `交易方${index + 1}`)), valuations: [] } };
const limited = new SingleAccountFlowData(rankedAccount, "counterparties", { partyLimit: 8 });
const allParties = new SingleAccountFlowData(rankedAccount, "counterparties");
conservation(limited);
conservation(allParties);
assert.equal(limited.partyCount, 10);
assert.equal(limited.displayedPartyCount, 8);
assert.equal(allParties.displayedPartyCount, 10);
assert.equal(limited.total, allParties.total);
assert.deepEqual(limited.all(), allParties.all());
const others = only(limited.nodes.filter((node) => node.depth === 2 && node.displayName.startsWith("其他 ")));
assert.equal(others.value, 300);
assert.deepEqual(ids(limited.selectionFor(others.name)), [1001, 1002]);
let received;
const component = instance(SingleAccountFlow, { account: rankedAccount, mode: "counterparties", loading: false, onSelect: (scope) => { received = scope; } });
let rendered = elements(component.render());
let diagram = only(rendered.filter((element) => element.type === DistributionDiagram));
assert.equal(diagram.props.data.displayedPartyCount, 8);
only(rendered.filter((element) => element.props["aria-label"] === "交易方桑基图显示范围")).props.onChange("all");
diagram = only(elements(component.render()).filter((element) => element.type === DistributionDiagram));
assert.equal(diagram.props.data.displayedPartyCount, 10);
const selectAll = only(elements(component.render()).filter((element) => element.props.children === "全部图中交易"));
selectAll.props.onClick();
assert.deepEqual(ids(received), rankedRows.map((row) => row.id));
const componentFlow = instance(SingleAccountFlow, { account, mode: "cashflow", loading: false, onSelect: (scope) => { received = scope; } });
diagram = only(elements(componentFlow.render()).filter((element) => element.type === DistributionDiagram));
const chart = only(elements(new DistributionDiagram(diagram.props).render()).filter((element) => element.type === Chart));
chart.props.onClick({ dataType: "edge", data: foodEdge });
assert.deepEqual(ids(received), [2]);
const loadingFlow = instance(SingleAccountFlow, { account, mode: "cashflow", loading: true, onSelect() { throw new Error("Loading flow must not select stale rows"); } });
const loadingTree = elements(loadingFlow.render());
only(loadingTree.filter((element) => element.props.children === "全部图中交易")).props.onClick();
only(loadingTree.filter((element) => element.type === DistributionDiagram)).props.onSelect(cashflow.all());
console.log("Single-account flow conservation, split allocations, refund/transfer/valuation separation, exact IDs and party limits passed.");

let opened;
const workspace = instance(SingleAccountWorkspace, { refreshKey: "test", onConfigure() {}, onDetail: (row) => { opened = row; } }, { loading: false, selected: "42", report: { accounts: [account] } });
const detailTable = (tab = "transactions") => only(elements(workspace.renderTransactions(account, "test", tab)).filter((element) => element.type === PagedTable));
const detailIds = (tab) => detailTable(tab).props.dataSource.map((row) => row.id);
workspace.selectDetails(received);
assert.equal(workspace.state.analysisTab, "cashflow");
const selectedTable = detailTable("cashflow");
assert.deepEqual(selectedTable.props.dataSource.map((row) => row.id), [2]);
selectedTable.props.columns.at(-1).render(null, selectedTable.props.dataSource[0]).props.onClick();
assert.equal(opened, transactions[1]);
assert.equal(opened.account_change, -1000, "A split category must open the original whole transaction");
assert.deepEqual(detailIds(), transactions.map((row) => row.id), "The all-movements tab ignores local chart selections");
assert.deepEqual(detailIds("parties"), [1, 2, 3, 4, 5, 9], "Party details exclude openings and valuation movements even without a selection");

const cashflowTree = elements(workspace.renderCashflow(account, "test"));
only(cashflowTree.filter((element) => element.type === SingleAccountFlow)).props.onSelect(cashflow.all());
assert.equal(workspace.state.analysisTab, "cashflow");
assert.deepEqual(detailIds("cashflow"), transactions.map((row) => row.id));
const expenseCategoryTable = only(cashflowTree.filter((element) => element.type === PagedTable && element.props.dataSource.some((row) => row.id === 201)));
expenseCategoryTable.props.columns[0].render("餐饮", account.categories[1]).props.onClick();
assert.equal(workspace.state.analysisTab, "cashflow");
assert.deepEqual(workspace.detailScope("cashflow"), { category: { id: 201, kind: "EXPENSE", name: "餐饮" } });
assert.deepEqual(detailIds("cashflow"), [2]);
only(cashflowTree.filter((element) => element.type === Chart)).props.onClick({ componentType: "series", dataIndex: 0, seriesIndex: 0 });
assert.equal(workspace.state.analysisTab, "cashflow");
assert.deepEqual(workspace.detailScope("cashflow"), { day: "2026-10-01", flow: "income" });
assert.deepEqual(detailIds("cashflow"), [1]);

const partyTree = elements(workspace.renderCounterparties(account, "test"));
only(partyTree.filter((element) => element.type === SingleAccountFlow)).props.onSelect(counterparties.all());
assert.equal(workspace.state.analysisTab, "parties");
assert.deepEqual(detailIds("parties"), [1, 2, 3, 4, 5, 9]);
const partyTable = only(partyTree.filter((element) => element.type === PagedTable && element.props.rowKey === "key"));
partyTable.props.columns[0].render("同名往来", account.counterparties.parties[1]).props.onClick();
assert.equal(workspace.state.analysisTab, "parties");
assert.deepEqual(detailIds("parties"), [4, 5]);
only(elements(workspace.renderBalance(account, "test")).filter((element) => element.type === Chart)).props.onClick({ componentType: "xAxis", targetType: "axisLabel", value: "2026-10-01" });
assert.equal(workspace.state.analysisTab, "balance");
assert.deepEqual(detailIds("balance"), [1]);
assert.deepEqual(detailIds("cashflow"), [1], "Balance date selection preserves cashflow filtering");
assert.deepEqual(detailIds("parties"), [4, 5], "Balance date selection preserves party filtering");
assert.deepEqual(detailIds(), transactions.map((row) => row.id));
assert.notEqual(detailTable("cashflow").props.pageResetKey, detailTable("balance").props.pageResetKey, "Each local table resets its own pagination");

workspace.renderDetailScope(account, "cashflow").props.items.find((item) => item.key === "day").onClear();
assert.deepEqual(workspace.detailScope("cashflow"), { flow: "income" });
assert.deepEqual(detailIds("parties"), [4, 5]);
workspace.renderDetailScope(account, "cashflow").props.onReset();
assert.deepEqual(detailIds("cashflow"), transactions.map((row) => row.id));
assert.deepEqual(detailIds("balance"), [1]);
assert.deepEqual(detailIds("parties"), [4, 5]);
workspace.renderDetailScope(account, "parties").props.onReset();
assert.deepEqual(detailIds("parties"), [1, 2, 3, 4, 5, 9]);
assert.deepEqual(detailIds("balance"), [1]);
const modeAccount = (mode) => ({ ...account, analysis_mode: mode, counterparties: mode === "cashflow" ? null : account.counterparties });
for (const mode of ["cashflow", "counterparties", "both"]) {
  workspace.state.analysisTab = undefined;
  const html = renderToStaticMarkup(workspace.renderAccount(modeAccount(mode)));
  assert.equal(html.includes("账户资金变动流向"), mode !== "counterparties");
  assert.equal(html.includes("交易方往来流向"), mode === "counterparties");
  if (mode === "both") {
    workspace.state.analysisTab = "parties";
    const partiesHtml = renderToStaticMarkup(workspace.renderAccount(modeAccount(mode)));
    assert.ok(partiesHtml.includes("交易方往来流向") && !partiesHtml.includes("账户资金变动流向"));
  }
}
const configured = Array.from({ length: 30 }, (_, index) => ({ ...account, id: index + 1, name: `完整分析账户${index + 1}`, ending_balance: 123456789 + index }));
workspace.state = { ...workspace.state, report: { start: "2026-10-01", end: "2026-10-18", accounts: configured }, selected: "1", search: "", analysisTab: "cashflow", drilldowns: {} };
const top = renderToStaticMarkup(workspace.render());
assert.ok(top.includes("single-account-layout-top") && top.includes("single-account-selector"));
assert.ok(!top.includes("<aside"), "Account selection must occupy the top, not a narrow sidebar");
assert.equal((top.match(/class="single-account-option(?: single-account-option-selected)?"/g) || []).length, 30);
assert.ok(top.includes('aria-label="完整分析账户30，期末余额 1,234,568.18 元，两者都看"'));
assert.equal((top.match(/aria-pressed="true"/g) || []).length, 1);
workspace.state.search = "账户30";
const searched = renderToStaticMarkup(workspace.render());
assert.equal((searched.match(/class="single-account-option(?: single-account-option-selected)?"/g) || []).length, 1);
assert.ok(searched.includes("<h2>完整分析账户1</h2>"));
workspace.state.search = "没有这个账户";
assert.ok(renderToStaticMarkup(workspace.render()).includes("没有匹配的账户"));
const filters = JSON.stringify(workspace.state.filters);
workspace.state.drilldowns = { cashflow: cashflow.all(), parties: counterparties.all(), balance: { day: "2026-10-01" } };
workspace.selectAccount(30);
assert.equal(workspace.state.selected, "30");
assert.deepEqual(workspace.state.drilldowns, {});
assert.equal(JSON.stringify(workspace.state.filters), filters);
assert.equal(workspace.state.search, "没有这个账户");
workspace.state.report = { accounts: [] };
assert.ok(renderToStaticMarkup(workspace.render()).includes("尚未配置关注或屏蔽账户"));
const empty = new SingleAccountFlowData({ ...account, transactions: [], counterparties: { parties: [], valuations: [] } }, "cashflow");
conservation(empty);
assert.deepEqual(ids(empty.all()), []);
console.log("Flow-to-details callbacks, three analysis modes, top account selection, search identity and empty states passed.");

for (const filename of process.argv.slice(2)) {
  const payload = JSON.parse(fs.readFileSync(filename, "utf8"));
  const report = payload.singleAccounts || payload;
  let checked = 0;
  for (const current of report.accounts || []) {
    const graph = new SingleAccountFlowData(current, "cashflow");
    conservation(graph);
    assert.equal(graph.incoming, current.transactions.reduce((sum, row) => sum + Math.max(0, row.account_change), 0));
    assert.equal(graph.outgoing, current.transactions.reduce((sum, row) => sum + Math.max(0, -row.account_change), 0));
    if (current.reconciled) assert.equal(graph.signedTotal, current.change);
    if (current.counterparties) {
      const parties = new SingleAccountFlowData(current, "counterparties");
      conservation(parties);
      assert.equal(parties.incoming, current.counterparties.incoming);
      assert.equal(parties.outgoing, current.counterparties.outgoing);
      assert.equal(parties.signedTotal, current.counterparties.net);
    }
    checked++;
  }
  assert.ok(checked, "An optional report fixture must contain accounts");
  console.log(`Read-only report fixture verified: ${checked} account flows.`);
}

async function verifyRefreshIdentity() {
  workspace.state = { ...workspace.state, selected: "30", search: "保留搜索", report: { accounts: configured }, drilldowns: {
    cashflow: new SingleAccountFlowData(configured[29], "cashflow").all(),
    parties: { party: { key: "party:beta", name: "同名往来" } },
    balance: { day: "2026-10-01" },
  } };
  const selectedScopes = workspace.state.drilldowns;
  workspace.api.request = async () => ({ accounts: configured });
  await workspace.load();
  assert.equal(workspace.state.selected, "30");
  assert.equal(workspace.state.search, "保留搜索");
  assert.deepEqual(workspace.state.drilldowns, selectedScopes);
  const cashflowConfigured = configured.map((item) => item.id === 30 ? { ...item, analysis_mode: "cashflow" } : item);
  workspace.state.report = { accounts: cashflowConfigured };
  workspace.state.drilldowns = {
    cashflow: { flow: "income", party: { key: "party:beta" } },
    parties: { party: { key: "party:beta" }, ...counterparties.all() },
    balance: { day: "2026-10-01", party: { key: "party:beta" } },
  };
  workspace.api.request = async () => ({ accounts: cashflowConfigured });
  await workspace.load();
  assert.deepEqual(workspace.state.drilldowns, { cashflow: { flow: "income" }, parties: {}, balance: { day: "2026-10-01" } }, "A same-account refresh sanitizes every tab's saved scope");
  workspace.api.request = async () => ({ accounts: configured.map((item) => item.id === 30 ? { ...item, analysis_mode: "counterparties" } : item) });
  await workspace.load();
  assert.equal(workspace.state.selected, "30");
  assert.deepEqual(workspace.state.drilldowns, {}, "A changed analysis mode must clear all previous tab scopes");
  workspace.api.request = async () => ({ accounts: configured.slice(0, 2) });
  await workspace.load();
  assert.equal(workspace.state.selected, "1");
  assert.deepEqual(workspace.state.drilldowns, {});
  assert.equal(JSON.stringify(workspace.state.filters), filters);
  console.log("Account refresh identity, mode changes and removed-configuration fallback passed.");
}
verifyRefreshIdentity().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
