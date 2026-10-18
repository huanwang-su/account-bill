const assert = require("node:assert/strict");
const path = require("node:path");
const { loadTs } = require("./source-loader.cjs");
const source = (file) => loadTs(path.resolve(__dirname, "../src", file));
const { DistributionDiagram } = source("DistributionDiagram.tsx");
const { Chart } = source("Chart.tsx");
const { IncomeDistribution } = source("GroupedCategoryDistribution.ts");
const { ExpenseDistribution } = source("ExpenseDistribution.ts");
const { AnalysisFlowSelection } = source("AnalysisFlowSelection.ts");
const { BalanceSheetDistribution, BalanceSheetStructure } = source(
  "BalanceSheetStructure.ts",
);
const { BalanceSheetWorkspace } = source("BalanceSheetWorkspace.tsx");
const { InvestmentDistribution } = source("InvestmentDistribution.ts");
const { InvestmentWorkspace } = source("InvestmentWorkspace.tsx");
const { SingleAccountFlowData } = source("SingleAccountFlowData.ts");
const { SingleAccountDrilldown } = source("SingleAccountDrilldown.ts");
const { AccountMovementDistribution } = source(
  "AccountMovementDistribution.ts",
);
const { FundFlowData } = source("FundFlowData.ts");
const { IncomeWorkspace } = source("IncomeWorkspace.tsx");
const { ExpenseWorkspace } = source("ExpenseWorkspace.tsx");
const groups = [
  { id: 1, name: "同名组", parent_id: null },
  { id: 2, name: "下级组", parent_id: 1 },
  { id: 3, name: "同名组", parent_id: null },
];
const categories = [
  { id: 10, name: "收入父类", kind: "INCOME", parent_id: null },
  { id: 11, name: "收入子类", kind: "INCOME", parent_id: 10 },
  { id: 20, name: "支出父类", kind: "EXPENSE", parent_id: null },
  { id: 21, name: "支出子类", kind: "EXPENSE", parent_id: 20 },
];
function elements(node, predicate) {
  if (Array.isArray(node))
    return node.flatMap((item) => elements(item, predicate));
  if (!node || typeof node !== "object") return [];
  return [
    ...(predicate(node) ? [node] : []),
    ...elements(node.props?.children, predicate),
  ];
}
function instance(Type, props, state = {}) {
  const page = new Type(props);
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
// Exercise the actual shared chart callback, not only selectionFor helpers.
function everyClick(graph, verify) {
  let count = 0;
  let selected;
  const view = new DistributionDiagram({
    data: graph,
    label: "测试",
    onSelect: (value) => {
      count++;
      verify(value, selected);
    },
  });
  const chart = elements(view.render(), (element) => element.type === Chart)[0];
  for (const data of graph.nodes) {
    selected = data;
    const previous = count;
    chart.props.onClick({ dataType: "node", data });
    assert.equal(count, previous + 1, `Node ${data.name} must select data`);
  }
  for (const data of graph.links) {
    selected = data;
    const previous = count;
    chart.props.onClick({ dataType: "edge", data });
    assert.equal(
      count,
      previous + 1,
      `Edge ${data.source} -> ${data.target} must select data`,
    );
  }
}
const funding = (id, group_id, amount, role = "ASSET", kind = "银行卡") => ({
  id,
  group_id,
  name: `账户${id}`,
  amount,
  role,
  kind,
  active: true,
});
const owners = [
  funding(1, 1, 100),
  funding(2, 2, 110),
  funding(3, 3, -50, "LIABILITY"),
];
const incomeRows = [
  {
    id: 101,
    kind: "INCOME",
    amount: 100,
    occurred_at: "2026-10-01 10:00:00",
    entries: [
      { account_id: 1, role: "ASSET", amount: 100 },
      { role: "SYSTEM", amount: -100, category_id: 11, selected: true },
    ],
  },
  {
    id: 102,
    kind: "INCOME",
    amount: 80,
    occurred_at: "2026-10-02 10:00:00",
    entries: [
      { account_id: 2, role: "ASSET", amount: 80 },
      { role: "SYSTEM", amount: -80, category_id: null, selected: true },
    ],
  },
  {
    id: 103,
    kind: "INCOME",
    amount: 30,
    occurred_at: "2026-10-03 10:00:00",
    entries: [
      { account_id: 2, role: "ASSET", amount: 30 },
      { role: "SYSTEM", amount: -30, category_id: 10, selected: true },
    ],
  },
];
const income = {
  accounts: owners,
  transactions: incomeRows,
  group_categories: [
    {
      group_id: 1,
      category_id: 10,
      name: "收入父类",
      amount: 100,
      transaction_ids: [101],
    },
    {
      group_id: 2,
      category_id: 0,
      name: "未分类",
      amount: 80,
      transaction_ids: [102],
    },
    {
      group_id: 2,
      category_id: 10,
      name: "收入父类",
      amount: 30,
      transaction_ids: [103],
    },
  ],
};
const incomeGraph = new IncomeDistribution(income, groups);
everyClick(incomeGraph, (selection, selected) => {
  let matching;
  if (selection.income_detail) {
    assert.deepEqual(selection.income_detail.transaction_ids, [102]);
    assert.equal(selection.income_detail.amount, 80);
    matching = incomeRows.filter((row) =>
      selection.income_detail.transaction_ids.includes(row.id),
    );
  } else if (selection.category_id !== undefined)
    assert.ok(selection.category_id > 0);
  if (!matching)
    matching = incomeRows.filter((row) => {
      const owner = owners.find((account) =>
        row.entries.some(
          (entry) => entry.role !== "SYSTEM" && entry.account_id === account.id,
        ),
      );
      return (
        (selection.group_id === undefined ||
          (owner?.group_id ?? 0) === selection.group_id) &&
        (selection.category_id === undefined ||
          row.entries.some(
            (entry) =>
              entry.category_id &&
              AnalysisFlowSelection.descendant(
                categories,
                entry.category_id,
                selection.category_id,
              ),
          ))
      );
    });
  assert.equal(
    matching.reduce((sum, row) => sum + row.amount, 0),
    selected.value,
  );
});
const legacyIncome = {
  ...income,
  group_categories: income.group_categories.map(
    ({ transaction_ids, ...row }) => row,
  ),
};
assert.deepEqual(
  IncomeDistribution.uncategorized(legacyIncome, 2).transaction_ids,
  [102],
);
assert.equal(IncomeDistribution.uncategorized(legacyIncome, 2).exact, true);
const expense = {
  group_category_details: [
    {
      group_id: 1,
      category_id: 21,
      name: "支出子类",
      parent_id: 20,
      parent_name: "支出父类",
      amount: 100,
    },
    {
      group_id: 2,
      category_id: 20,
      name: "支出父类",
      parent_id: 20,
      parent_name: "支出父类",
      amount: 50,
    },
    {
      group_id: 1,
      category_id: 0,
      name: "未分类",
      parent_id: 0,
      parent_name: "未分类",
      amount: 10,
    },
    {
      group_id: 1,
      category_id: -1,
      name: "退款",
      parent_id: -1,
      parent_name: "退款抵减",
      amount: -5,
    },
  ],
};
const expenseGraph = new ExpenseDistribution(expense, groups);
everyClick(expenseGraph, (selection) =>
  assert.ok(
    selection.category_id === undefined ||
      Number.isInteger(selection.category_id),
  ),
);
assert.equal(expenseGraph.adjustments[0].selection.category_id, -1);
const sheet = {
  groups,
  accounts: [
    ...owners,
    funding(4, 1, -5),
    funding(5, null, 0),
    {
      ...funding(6, 2, 250),
      composite: true,
      asset_amount: 300,
      liability_amount: 50,
    },
  ],
};
const balancePage = instance(
  BalanceSheetWorkspace,
  { groups },
  { snapshot: sheet },
);
assert.deepEqual(
  balancePage
    .drilldownRows({ namespace: "ASSET", account_id: 5 })
    .map((row) => row.id),
  [5],
);
for (const role of ["ASSET", "LIABILITY"])
  everyClick(
    new BalanceSheetDistribution(new BalanceSheetStructure(sheet), role),
    (selection) => {
      const rows = balancePage.drilldownRows(selection);
      assert.ok(rows.length > 0);
      if (selection.account_id !== undefined)
        assert.deepEqual(
          rows.map((row) => row.id),
          [selection.account_id],
        );
      if (selection.direct_group)
        assert.ok(
          rows.every((row) => (row.group_id ?? 0) === selection.group_id),
        );
    },
  );
const investmentReport = {
  accounts: owners.map((row, index) => ({
    ...row,
    ending: Math.abs(row.amount),
    profit: [20, -10, 0][index],
  })),
};
const investmentPage = instance(
  InvestmentWorkspace,
  { accounts: owners, groups },
  { report: investmentReport },
);
const investment = new InvestmentDistribution(investmentReport, owners, groups);
for (const graph of [investment.assets, investment.returns])
  everyClick(graph, (selection) => {
    const rows = investmentPage.drilldownAccounts(selection);
    assert.ok(rows.length > 0);
    if (selection.namespace === "investment:gain")
      assert.ok(rows.every((row) => row.profit > 0));
    if (selection.namespace === "investment:loss")
      assert.ok(rows.every((row) => row.profit < 0));
  });
const single = {
  id: 1,
  name: "单账户",
  analysis_mode: "both",
  categories: [],
  transactions: incomeRows.map((row) => ({
    ...row,
    account_change: row.amount,
  })),
  counterparties: {
    parties: incomeRows.map((row, index) => ({
      key: `party:${index}`,
      counterparty: "同名",
      transactions: [{ ...row, account_change: row.amount }],
    })),
  },
};
for (const mode of ["cashflow", "counterparties"])
  everyClick(new SingleAccountFlowData(single, mode), (selection) => {
    const rows = SingleAccountDrilldown.rows(single, selection);
    assert.ok(rows.length > 0);
    assert.deepEqual(
      rows.map((row) => row.id).sort(),
      [...selection.movement.transaction_ids].sort(),
    );
  });
const movements = new AccountMovementDistribution(
  {
    accounts: [
      {
        ...owners[0],
        net_change: 1000,
        opening_added: 1000,
        operating_change: 0,
      },
      {
        ...owners[1],
        net_change: 100,
        opening_added: 150,
        operating_change: -50,
      },
      {
        ...owners[2],
        net_change: -100,
        opening_added: -150,
        operating_change: 50,
      },
    ],
  },
  groups,
);
everyClick(movements, (selection) =>
  assert.ok(movements.rows(selection).length > 0),
);
assert.ok(!movements.nodes.some((node) => node.accountId === 1));
assert.deepEqual(
  movements.rows({ account_id: 1 }).map((row) => row.id),
  [1],
);
const flowReport = {
  groups,
  scope_account_ids: [1, 2],
  endpoints: [
    { key: "income", name: "收入", external: true, in_scope: false },
    { key: "account:1", ...owners[0], account_id: 1, in_scope: true },
    { key: "account:2", ...owners[1], account_id: 2, in_scope: true },
    { key: "account:3", ...owners[2], account_id: 3, in_scope: false },
  ],
  flows: [
    {
      id: "f1",
      source: "income",
      target: "account:1",
      transaction_id: 1,
      amount: 100,
    },
    {
      id: "f2",
      source: "account:1",
      target: "account:2",
      transaction_id: 2,
      amount: 70,
    },
    {
      id: "f3",
      source: "account:2",
      target: "account:3",
      transaction_id: 3,
      amount: 20,
    },
  ],
  transactions: [1, 2, 3].map((id) => ({ id, allocation: "allocated" })),
};
for (const dimension of ["account", "group"])
  for (const view of ["all", "internal", "external"]) {
    const flow = new FundFlowData(flowReport, dimension, view);
    everyClick(flow, (selection, selected) => {
      assert.ok(flow.flowRows(selection).length > 0);
      assert.equal(
        flow.flowRows(selection).reduce((sum, row) => sum + row.amount, 0),
        selected.value,
      );
      assert.ok(flow.transactions(selection).length > 0);
      assert.ok(flow.stats(selection).length > 0);
    });
  }

const base = {
  start: "2026-10-01",
  end: "2026-10-18",
  account_id: 2,
  group_id: 2,
  category_id: 11,
  exact_category: true,
  excluded_account_ids: "[9]",
};
for (const selection of [
  { group_id: undefined, category_id: undefined },
  { group_id: 1, direct_group: true, category_id: 10 },
  { group_id: 2, direct_group: true, category_id: 10 },
  { group_id: 2, category_id: 11, exact_category: undefined },
]) {
  const next = AnalysisFlowSelection.narrow(
    base,
    selection,
    groups,
    categories,
  );
  assert.equal(next.category_id, 11);
  assert.equal(next.exact_category, true);
  assert.equal(next.group_id, 2);
  assert.equal(next.account_id, 2);
  assert.equal(next.start, base.start);
  assert.equal(next.end, base.end);
  assert.equal(next.excluded_account_ids, "[9]");
}
assert.deepEqual(
  AnalysisFlowSelection.narrow(
    { group_id: 1, category_id: 20 },
    { group_id: 2, direct_group: true, category_id: 21, exact_category: true },
    groups,
    categories,
  ),
  { group_id: 2, direct_group: true, category_id: 21, exact_category: true },
);
const props = {
  accounts: owners,
  groups,
  categories,
  refreshKey: "test",
  onDetail() {},
};
for (const Type of [IncomeWorkspace, ExpenseWorkspace]) {
  const page = instance(Type, props, {
    filters: base,
    loading: false,
    report: income,
  });
  let loads = 0;
  page.load = () => {
    loads++;
  };
  page.selectFlow({ group_id: undefined, category_id: undefined });
  assert.deepEqual(page.state.filters, base);
  assert.equal(page.state.activeTab, "details");
  assert.equal(
    loads,
    0,
    "Root click reveals current data without changing report scope",
  );
  page.selectFlow({ group_id: 2, direct_group: true, category_id: 10 });
  assert.equal(page.state.filters.category_id, 11);
  assert.equal(page.state.filters.exact_category, true);
  assert.equal(page.state.filters.group_id, 2);
  assert.equal(page.state.filters.direct_group, true);
}
const incomePage = instance(IncomeWorkspace, props, {
  filters: base,
  loading: false,
  report: income,
});
let requested = false;
incomePage.load = () => {
  requested = true;
};
incomePage.selectFlow(
  incomeGraph.nodes.find((node) => node.displayName === "未分类").selection,
);
assert.equal(
  requested,
  false,
  "Uncategorized selection never sends unsupported category_id=0",
);
assert.deepEqual(incomePage.state.filters, base);
assert.deepEqual(
  incomePage.transactionTable(incomeRows).props.dataSource.map((row) => row.id),
  [102],
);
const unknownSelection = incomeGraph.selectionFor(
  incomeGraph.nodes.find((node) => node.displayName === "未分类").name,
);
unknownSelection.income_detail.transaction_ids.push(999);
assert.deepEqual(
  incomeGraph.selectionFor(
    incomeGraph.nodes.find((node) => node.displayName === "未分类").name,
  ).income_detail.transaction_ids,
  [102],
);
incomePage.state.report = {
  ...income,
  transactions: [{ ...incomeRows[1], id: 104 }],
  group_categories: [{ ...income.group_categories[1], transaction_ids: [104] }],
};
assert.deepEqual(
  incomePage
    .transactionTable(incomePage.state.report.transactions)
    .props.dataSource.map((row) => row.id),
  [104],
  "Same-scope refresh resolves the current node IDs rather than stale transaction snapshots",
);
incomePage.detailPeriodBar(true).props.onReset();
assert.equal(incomePage.state.detailIncome, undefined);

const refundPage = instance(ExpenseWorkspace, props, {
  filters: { start: base.start, end: base.end, account_id: 1 },
  loading: false,
  report: {
    ...expense,
    expense: 155,
    paid: 160,
    refunds: 5,
    days: 18,
    count: 3,
    average_daily: 8,
    change: 0,
    large_count: 0,
    large_amount_minor: 100000,
    trend: [],
    parents: [],
    merchants: [],
    large_transactions: [],
    transactions: [],
  },
});
refundPage.load = () => {};
const refundButton = elements(
  refundPage.render(),
  (node) =>
    node.props?.onClick &&
    node.props.children === expenseGraph.adjustments[0].path,
)[0];
assert.ok(
  refundButton,
  "Negative refund adjustments need a usable detail entry",
);
refundButton.props.onClick();
assert.equal(refundPage.state.filters.category_id, -1);
assert.equal(refundPage.state.filters.exact_category, true);
assert.equal(refundPage.state.filters.account_id, 1);
assert.equal(refundPage.state.filters.start, base.start);
assert.equal(refundPage.state.activeTab, "details");
console.log(
  "Every existing Sankey node/edge selects corresponding data; strict date/account/category/group scopes, opening exclusion and exact uncategorized linkage passed.",
);
