const assert = require("node:assert/strict");
const path = require("node:path");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { loadTs } = require("./source-loader.cjs");
const source = (name) => loadTs(path.resolve(__dirname, "../src", name));
const { BillAttention, BillReviewModel } = source("BillReviewModel.ts");
const { BillReviewForm } = source("BillReviewForm.tsx");
const { BillWorkspace } = source("BillWorkspace.tsx");
const { SidebarNavigation } = source("SidebarNavigation.tsx");
const { AccountExclusionHint } = source("AccountExclusionHint.tsx");
const { ReportAccountFilters } = source("ReportAccountFilters.tsx");
const { ReportPeriodFilter } = source("ReportPeriodFilter.tsx");
const accounts = [
  { id: 1, name: "王焕 · 银行", role: "ASSET", kind: "银行卡", active: true },
  { id: 2, name: "赵丹 · 微信", role: "ASSET", kind: "微信", active: true },
  { id: 3, name: "王焕 · 证券", role: "ASSET", kind: "证券", active: true },
  {
    id: 4,
    name: "旧微信",
    role: "ASSET",
    kind: "微信",
    active: false,
    merged_into_id: 2,
  },
  { id: 5, name: "系统支出", role: "SYSTEM", kind: "系统", active: true },
];
const row = (id, date, status = "PENDING") => ({
  id,
  ledger_status: status,
  ledger_reason: "账户待核对",
  classification_status: "CLASSIFIED",
  account_id: 1,
  classification: { category_path: ["支出", "餐饮"], tags: [] },
  facts: {
    occurred_at: `${date} 12:00:00`,
    amount_minor: 30000,
    flow: "OUT",
    settlement: "COMPLETED",
    counterparty: "测试商户",
    description: "测试账单",
    payment_hint: "银行卡",
  },
});
function instance(Component, props) {
  const value = new Component(props);
  value.setState = (patch, done) => {
    Object.assign(
      value.state,
      typeof patch === "function" ? patch(value.state) : patch,
    );
    done?.();
  };
  return value;
}
function elements(node) {
  if (!node || typeof node !== "object") return [];
  if (Array.isArray(node)) return node.flatMap(elements);
  if (React.isValidElement(node))
    return [node, ...elements(node.props.children)];
  return [];
}
const bill = row("bill:a", "2026-09-10");
const model = new BillReviewModel(bill, accounts);
assert.equal(model.kind, "EXPENSE");
assert.deepEqual(
  model.choices().map((choice) => choice.value),
  [1, 2, 3],
);
assert.equal(model.initialValues().amount, "300.00");
const incoming = {
  ...bill,
  facts: { ...bill.facts, flow: "IN" },
  classification: { category_path: ["内部转账"] },
};
assert.deepEqual(new BillReviewModel(incoming, accounts).initialValues(), {
  kind: "TRANSFER",
  account_id: undefined,
  to_account_id: 1,
  amount: "300.00",
});
for (const kind of ["EXPENSE", "INCOME", "REFUND", "TRANSFER"]) {
  const form = instance(BillReviewForm, {
    bill,
    accounts,
    categories: [],
    busy: false,
    onSubmit() {},
  });
  form.state.kind = kind;
  const fields = form.renderAccounts((key) => (key === "account_id" ? 1 : 2))
    .props.children;
  const [payer, payee] = fields;
  if (kind === "TRANSFER") {
    assert.equal(payer.props.name, "account_id");
    assert.equal(payee.props.name, "to_account_id");
    assert.equal(
      payer.props.children.props.options.find((option) => option.value === 2)
        .disabled,
      true,
    );
  } else {
    const [external, funding] =
      kind === "EXPENSE" ? [payee, payer] : [payer, payee];
    assert.equal(external.props.name, undefined);
    assert.equal(external.props.children.props.disabled, true);
    assert.match(external.props.children.props.value, /测试商户/);
    assert.equal(funding.props.name, "account_id");
  }
  const html = renderToStaticMarkup(form.render());
  assert.ok(html.includes("付款账户") && html.includes("收款账户"));
  assert.ok(!html.includes("本账户看点"));
}
assert.deepEqual(
  BillReviewModel.changeKind("INCOME", "TRANSFER", { account_id: 2 }),
  {
    account_id: undefined,
    to_account_id: 2,
    category_id: undefined,
    related_id: undefined,
  },
);
assert.equal(
  BillReviewModel.changeKind("TRANSFER", "INCOME", {
    account_id: 1,
    to_account_id: 2,
  }).account_id,
  2,
);
assert.equal(
  BillReviewModel.changeKind("EXPENSE", "TRANSFER", { account_id: 1 }, "IN")
    .to_account_id,
  1,
  "A bank receipt remains the destination even if its tentative category was expense",
);
const transfer = BillReviewModel.payload({
  kind: "TRANSFER",
  account_id: 1,
  to_account_id: 2,
  amount: "300.00",
  category_id: 9,
  related_id: 8,
});
assert.deepEqual(transfer, {
  kind: "TRANSFER",
  account_id: 1,
  to_account_id: 2,
  amount: "300.00",
});
assert.ok(
  !Object.hasOwn(
    BillReviewModel.payload({
      kind: "INCOME",
      account_id: 2,
      to_account_id: 1,
      amount: "2",
    }),
    "to_account_id",
  ),
);

let pending = 0,
  stopped = 0;
const nav = new SidebarNavigation({
  page: "bills",
  reportTab: "balance-sheet",
  pendingBillCount: 2,
  onNavigate() {
    assert.fail("Badge must use the attention shortcut");
  },
  onPending() {
    pending++;
  },
});
const label = nav.label("bills", "交易明细");
const button = label.props.count;
button.props.onClick({
  stopPropagation() {
    stopped++;
  },
});
assert.equal(pending, 1);
assert.equal(stopped, 1);
assert.equal(button.props["aria-label"], "处理 2 条待核对交易");
assert.equal(
  new SidebarNavigation({
    page: "bills",
    reportTab: "",
    pendingBillCount: 0,
    onNavigate() {},
  }).label("bills", "交易明细"),
  "交易明细",
);
assert.ok(renderToStaticMarkup(label).includes("navigation-pending-count"));

const hints = new ReportAccountFilters({
  accounts,
  filters: {},
  defaults: {
    exclude_investment_accounts: true,
    exclude_single_accounts: false,
    investment_account_ids: [3],
    single_excluded_account_ids: [4],
  },
  onChange() {},
});
const hintNodes = elements(hints.render()).filter(
  (node) => node.type === AccountExclusionHint,
);
assert.equal(hintNodes.length, 2);
const contents = hintNodes.map((node) =>
  renderToStaticMarkup(
    new AccountExclusionHint(node.props).render().props.content,
  ),
);
assert.ok(
  contents[0].includes("王焕 · 证券") && !contents[0].includes("赵丹 · 微信"),
);
assert.ok(
  contents[1].includes("赵丹 · 微信") && !contents[1].includes("旧微信"),
);
assert.ok(contents[1].includes("当前未启用"));

async function verify() {
  const form = instance(BillReviewForm, {
    bill,
    accounts,
    categories: [],
    busy: false,
    onSubmit() {},
  });
  form.state.kind = "TRANSFER";
  const field = form.renderAccounts(() => 1).props.children[1];
  await assert.rejects(field.props.rules[1].validator({}, 1), /不能相同/);
  await field.props.rules[1].validator({}, 2);
  const page = instance(BillWorkspace, {
    mode: "list",
    initialFilters: { start: "2026-10-01", end: "2026-10-31", q: "无匹配" },
    onChanged: async () => {},
  });
  page.state.rows = [
    bill,
    row("bill:b", "2026-10-18"),
    row("bill:c", "2026-10-18", "POSTED"),
  ];
  page.state.loading = false;
  assert.equal(page.filtered.length, 0);
  page.showPending();
  assert.deepEqual(page.state.filters, BillAttention.filters());
  assert.deepEqual(
    page.filtered.map((item) => item.id),
    ["bill:a", "bill:b"],
  );
  const html = renderToStaticMarkup(page.render());
  assert.ok(html.includes("核对下一条") && html.includes("待处理异常"));
  let applied = 0;
  const period = instance(ReportPeriodFilter, {
    filters: BillAttention.filters(),
    allowAll: true,
    onChange() {
      applied++;
    },
  });
  period.api.request = async () =>
    assert.fail(
      "An all-date queue must not resolve itself to the latest month",
    );
  await period.resolve();
  assert.equal(applied, 0);
  assert.equal(period.state.loading, false);
  assert.ok(renderToStaticMarkup(period.render()).includes("全部日期"));
  console.log(
    "Attention badge/shortcut, all-date queue, canonical hover lists, both review sides, immutable counterparties, transfer validation and clean posting payloads passed.",
  );
}
verify().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
