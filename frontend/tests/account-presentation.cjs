const assert = require("node:assert/strict"),
  path = require("node:path");
const { loadTs } = require("./source-loader.cjs");
const src = (name) => path.resolve(__dirname, "../src", name);
const { PartyMetrics: PartyReadoutData } = loadTs(src("ReportMetrics.ts"));
const { SingleAccountWorkspace } = loadTs(src("SingleAccountWorkspace.tsx"));
const { CounterpartyWorkspace } = loadTs(src("CounterpartyWorkspace.tsx"));
const { Chart } = loadTs(src("Chart.tsx"));
function movement(
  id,
  amount,
  kind = amount > 0 ? "INCOME" : "EXPENSE",
  source = "手工",
) {
  return {
    id,
    kind,
    source,
    account_change: amount,
    occurred_at: "2026-10-01 12:00:00",
    category_names: [],
  };
}
const account = {
  id: 5,
  name: "银行卡",
  analysis_mode: "cashflow",
  opening_balance: -500,
  ending_balance: -500,
  change: 0,
  reconciled: true,
  income: 0,
  expense: 100,
  refunds: 300,
  transfer_in: 0,
  transfer_out: 100,
  valuation_profit: -100,
  adjustments: 0,
  categories: [],
  counterparties: null,
  count: 4,
  trend: [],
  transactions: [
    movement(1, -100),
    movement(2, 300, "REFUND"),
    movement(3, -100, "TRANSFER"),
    movement(4, -100, "EXPENSE", "证券余额更新"),
  ],
};
const zero = {
  ...account,
  change: 0,
  income: 0,
  expense: 0,
  refunds: 0,
  transfer_in: 0,
  transfer_out: 0,
  valuation_profit: 0,
  adjustments: 0,
  count: 0,
  transactions: [],
};
function party(name, transactions) {
  const incoming = transactions.reduce(
    (sum, row) => sum + Math.max(0, row.account_change),
    0,
  );
  const outgoing = transactions.reduce(
    (sum, row) => sum + Math.max(0, -row.account_change),
    0,
  );
  return {
    key: "party:" + name,
    counterparty: name,
    valuation: false,
    transactions,
    incoming,
    outgoing,
    net: incoming - outgoing,
    count: transactions.length,
    first_at: "2026-10-01",
    last_at: "2026-10-01",
  };
}
const dual = party("双向大额", [
  movement(20, 100000),
  movement(21, -100000, "TRANSFER"),
]);
const payer = party(
  "大额付款",
  [-100000, -20000, -20000, -10000].map((amount, i) =>
    movement(30 + i, amount),
  ),
);
const receiver = party("主要收款", [movement(40, 120000)]);
const frequent = party(
  "高频小额",
  Array.from({ length: 99 }, (_, i) => movement(100 + i, i === 98 ? -2 : -1)),
);
const parties = [frequent, receiver, payer, dual];
const facts = {
  incoming: parties.reduce((s, r) => s + r.incoming, 0),
  outgoing: parties.reduce((s, r) => s + r.outgoing, 0),
};
facts.net = facts.incoming - facts.outgoing;
assert.deepEqual(
  PartyReadoutData.rank(parties).map((r) => r.key),
  [dual.key, payer.key, receiver.key, frequent.key],
);
function stateful(component) {
  component.setState = function (patch, callback) {
    Object.assign(
      this.state,
      typeof patch === "function" ? patch(this.state, this.props) : patch,
    );
    callback?.();
  };
  return component;
}
function nodes(element) {
  if (!element || typeof element !== "object") return [];
  if (Array.isArray(element)) return element.flatMap(nodes);
  return [element, ...nodes(element.props?.children)];
}
const single = stateful(
  new SingleAccountWorkspace({
    refreshKey: "1",
    onConfigure() {},
    onDetail() {},
  }),
);
single.state.loading = false;
assert.equal(
  nodes(single.renderAccount(account)).filter(
    (node) => node.props?.className === "analysis-readout",
  ).length,
  0,
  "Single-account details omit the automatic account readout",
);

const report = {
  parties,
  valuations: [],
  account_id: 5,
  account_name: "银行卡",
  incoming: facts.incoming,
  outgoing: facts.outgoing,
  net: facts.net,
  count: 106,
  party_count: 4,
  valuation_gain: 0,
  valuation_loss: 0,
  valuation_net: 0,
};
const counter = stateful(
  new CounterpartyWorkspace({
    accounts: [{ id: 5, name: "银行卡", role: "ASSET", kind: "银行卡" }],
    initialAccountId: 5,
    refreshKey: "1",
    onDetail() {},
    onValuation() {},
  }),
);
counter.state.report = report;
counter.state.loading = false;
let tree = nodes(counter.render());
assert.equal(
  tree.filter((node) => node.props?.className === "analysis-readout").length,
  0,
);
const rank = tree.find(
  (node) => node.type === Chart && node.props.label === "交易方收付规模排行",
);
const dualIndex = rank.props.option.yAxis.data.indexOf(dual.key);
assert.ok(dualIndex >= 0);
assert.equal(rank.props.option.series[0].data[dualIndex], 1000);
assert.equal(rank.props.option.series[1].data[dualIndex], -1000);
rank.props.onClick({ componentType: "yAxis", value: payer.key });
assert.equal(counter.state.selected, payer);
const sameNameFirst = {
  ...dual,
  key: "party:identity-a",
  counterparty: "同名交易方",
};
const sameNameSecond = {
  ...payer,
  key: "party:identity-b",
  counterparty: "同名交易方",
};
counter.state.report = { ...report, parties: [sameNameFirst, sameNameSecond] };
const sameNameRank = nodes(counter.render()).find(
  (node) => node.type === Chart && node.props.label === "交易方收付规模排行",
);
for (const party of [sameNameFirst, sameNameSecond]) {
  const index = sameNameRank.props.option.yAxis.data.indexOf(party.key);
  assert.ok(index >= 0);
  assert.equal(
    sameNameRank.props.option.yAxis.axisLabel.formatter(party.key),
    "同名交易方",
  );
  assert.equal(
    sameNameRank.props.option.yAxis.axisPointer.label.formatter({
      value: party.key,
    }),
    "同名交易方",
  );
  sameNameRank.props.onClick({ componentType: "yAxis", value: party.key });
  assert.equal(
    counter.state.selected,
    party,
    "Same-name axis labels retain their distinct stable identities",
  );
  sameNameRank.props.onClick({
    componentType: "series",
    dataIndex: index,
    seriesIndex: 1,
  });
  assert.equal(
    counter.state.selected,
    party,
    "Bars resolve to their exact original ranked row",
  );
  const tooltip = sameNameRank.props.option.tooltip.formatter([
    {
      axisValue: party.key,
      seriesName: "收款",
      value: party.incoming / 100,
      dataIndex: index,
    },
    {
      axisValue: party.key,
      seriesName: "付款",
      value: -party.outgoing / 100,
      dataIndex: index,
    },
  ]);
  assert.ok(tooltip.startsWith("同名交易方\n"));
  assert.ok(
    !tooltip.includes(party.key),
    "Stable internal keys must not appear in business tooltips",
  );
}
counter.state.report = report;
const server = require("react-dom/server");
const html = server.renderToStaticMarkup(single.renderAccount(zero));
assert.ok(!html.includes("NaN") && !html.includes("Infinity"));
assert.ok(!html.includes("本账户看点"));
assert.ok(html.includes("期末账面余额") && html.includes("收支分析"));
console.log(
  "Account presentation: gross ranking, stable same-name identities, linkage, privacy and SSR passed.",
);
