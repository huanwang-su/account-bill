const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const ts = require("typescript");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const echarts = require("echarts");
const { loadTs } = require("./source-loader.cjs");
const src = path.resolve(__dirname, "../src");
const source = (name) => loadTs(path.join(src, name));
const { Chart } = source("Chart.tsx");
const storage = new Map();
const events = new Map();
global.localStorage = {
  getItem: (key) => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, value),
};
global.window = {
  addEventListener: (name, callback) => events.set(name, callback),
  removeEventListener: (name, callback) => {
    if (events.get(name) === callback) events.delete(name);
  },
};
global.fetch = () =>
  assert.fail("Display toggles must not request or write ledger data");
const { AmountPrivacy } = source("AmountPrivacy.ts");
const { DisplayMoneyFormatter: Money, MoneyFormatter: RawMoney } =
  source("api.ts");
const { AmountVisibilityToggle } = source("AmountVisibilityToggle.tsx");
const { AmountInput } = source("AmountInput.tsx");
const { ChartAmountPrivacy } = source("ChartAmountPrivacy.ts");
// Load the real root component without its browser bootstrap or style imports.
function appClass() {
  const filename = path.join(src, "main.tsx");
  const input = fs.readFileSync(filename, "utf8");
  const code = input
    .slice(0, input.lastIndexOf("\nAppearance.apply("))
    .replace(/^import "[^"]+";\n/gm, "")
    .replace("class LedgerApp extends", "export class LedgerApp extends");
  const compiled = ts.transpileModule(code, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText;
  const mod = new Module(filename, module);
  mod.paths = Module._nodeModulePaths(src);
  mod.require = (name) =>
    name.startsWith(".")
      ? source(
          name.slice(2) +
            (fs.existsSync(path.join(src, name + ".ts")) ? ".ts" : ".tsx"),
        )
      : Module.createRequire(filename)(name);
  mod._compile(compiled, filename + ".cjs");
  return mod.exports.LedgerApp;
}
function instance(Component, props = {}) {
  const page = new Component(props);
  page.setState = (update, done) => {
    Object.assign(
      page.state,
      typeof update === "function" ? update(page.state) : update,
    );
    done?.();
  };
  return page;
}

async function run() {
  assert.equal(Money.format(1234567), "12,345.67");
  const toggle = instance(AmountVisibilityToggle);
  toggle.componentDidMount();
  let button = toggle.render().props.children;
  assert.equal(button.props["aria-pressed"], false);
  button.props.onClick();
  assert.equal(AmountPrivacy.hidden(), true);
  assert.equal(storage.get(AmountPrivacy.key), "true");
  assert.equal(Money.format(-1234567), "****");
  assert.equal(Money.format(0), "****");
  assert.equal(
    Money.input(1234567),
    "12345.67",
    "Form/API numeric input stays exact",
  );
  button = toggle.render().props.children;
  assert.equal(button.props.children, "显示金额");
  assert.equal(button.props["aria-pressed"], true);
  const toggleMarkup = renderToStaticMarkup(toggle.render());
  assert(toggleMarkup.includes('aria-label="隐藏金额"'));
  const formMarkup = renderToStaticMarkup(
    React.createElement(AmountInput, { stringMode: true, value: "12345.67" }),
  );
  assert(formMarkup.includes('type="password"'));
  assert(
    formMarkup.includes('value="12345.67"'),
    "Masking must never replace form state",
  );

  // Refresh and cross-tab synchronization, including cleared and unavailable storage.
  AmountPrivacy.value = undefined;
  assert.equal(AmountPrivacy.hidden(), true);
  events.get("storage")({ key: AmountPrivacy.key, newValue: "false" });
  assert.equal(toggle.state.hidden, false);
  const normalInput = renderToStaticMarkup(
    React.createElement(AmountInput, { value: 123.45 }),
  );
  assert(!normalInput.includes('type="password"'));
  const originalStorage = global.localStorage;
  global.localStorage = {
    getItem() {
      throw new Error("Storage unavailable");
    },
    setItem() {
      throw new Error("Storage unavailable");
    },
  };
  AmountPrivacy.set(true);
  assert.equal(Money.format(300), "****");
  assert.equal(toggle.state.hidden, true);
  global.localStorage = originalStorage;
  const original = {
    original: {
      "交易金额(元)": "12345.67",
      余额: "246.80",
      交易时间: "2026-10-19",
      交易号: "123456789",
      笔数: 12,
    },
    related: [{ amount_minor: 1234567, account_id: 7 }],
  };
  const redacted = AmountPrivacy.fields(original);
  assert.equal(redacted.original["交易金额(元)"], "****");
  assert.equal(redacted.original["余额"], "****");
  assert.equal(redacted.original["交易时间"], "2026-10-19");
  assert.equal(redacted.original["交易号"], "123456789");
  assert.equal(redacted.original["笔数"], 12);
  assert.equal(redacted.related[0].amount_minor, "****");
  assert.equal(redacted.related[0].account_id, 7);
  assert.equal(original.related[0].amount_minor, 1234567);

  // Value axes, labels, hover states, default/template/custom tooltips all mask amounts.
  const input = {
    animation: false,
    tooltip: { trigger: "axis", formatter: "{b}: ¥{c}" },
    xAxis: { type: "category", data: ["2026-10-19"] },
    yAxis: { type: "value", max: 40000 },
    series: [
      {
        name: "收入",
        type: "bar",
        data: [{ value: 12345.67, id: 18 }],
        label: { show: true, formatter: "{c}" },
        emphasis: { label: { show: true, formatter: (p) => String(p.value) } },
        markLine: { data: [{ yAxis: 20000, label: { formatter: "{c}" } }] },
      },
    ],
  };
  const hidden = ChartAmountPrivacy.option(input, true);
  const params = {
    name: "2026-10-19",
    value: 12345.67,
    seriesName: "收入",
    data: input.series[0].data[0],
  };
  assert.equal(hidden.yAxis.axisLabel.formatter(30000), "****");
  assert.equal(
    hidden.yAxis.axisPointer.label.formatter({ value: 12345.67 }),
    "****",
  );
  assert.equal(hidden.xAxis.axisLabel, undefined, "Dates stay visible");
  for (const text of [
    hidden.tooltip.formatter([params]),
    hidden.series[0].label.formatter(params),
    hidden.series[0].emphasis.label.formatter(params),
    hidden.series[0].markLine.data[0].label.formatter(params),
  ]) {
    assert(text.includes("****"));
    assert(!text.includes("12345.67"));
  }
  assert.equal(hidden.series[0].data[0].id, 18);
  assert.equal(hidden.series[0].data[0].value, 12345.67);
  assert.equal(input.tooltip.formatter, "{b}: ¥{c}");
  assert.equal(ChartAmountPrivacy.option(input, false), input);
  const svgChart = echarts.init(null, null, {
    renderer: "svg",
    ssr: true,
    width: 700,
    height: 320,
  });
  svgChart.setOption(hidden);
  const svg = svgChart.renderToSVGString();
  assert(svg.includes("2026-10-19"));
  assert(svg.includes("****"));
  assert(!svg.includes(">12345.67<") && !svg.includes(">30,000<"));
  svgChart.dispose();

  const sankey = ChartAmountPrivacy.option(
    {
      tooltip: { formatter: (p) => String(p.value) },
      series: [
        {
          type: "sankey",
          data: [
            { name: "root", displayName: "总资产" },
            { name: "account:7", displayName: "测试银行" },
          ],
          links: [{ source: "root", target: "account:7", value: 1234567 }],
        },
      ],
    },
    true,
  );
  const edge = sankey.series[0].links[0];
  const edgeTip = sankey.tooltip.formatter({ dataType: "edge", data: edge });
  assert.equal(edgeTip, "总资产 → 测试银行 · ****");
  assert.equal(edge.value, 1234567);
  const pie = ChartAmountPrivacy.option(
    {
      series: [
        {
          type: "pie",
          data: [{ name: "餐饮", value: 12345.67 }],
          label: { show: true, formatter: "{b}: {c}" },
        },
      ],
    },
    true,
  );
  assert.equal(
    pie.series[0].label.formatter({ name: "餐饮", value: 12345.67 }),
    "餐饮\n****",
  );

  // An already mounted chart clears open tooltips and redraws without losing its data.
  let draws = 0,
    cleared = 0,
    disposed = 0,
    disconnects = 0;
  global.ResizeObserver = class {
    observe() {}
    disconnect() {
      disconnects++;
    }
  };
  const chart = instance(Chart, { option: input });
  chart.context = { resolved: "forest", reducedMotion: false };
  chart.chart = {
    dispatchAction(action) {
      assert.equal(action.type, "hideTip");
      cleared++;
    },
    setOption(option) {
      draws++;
      chart.output = option;
    },
    dispose() {
      disposed++;
    },
  };
  chart.componentDidMount();
  assert.equal(chart.output.yAxis.axisLabel.formatter(30000), "****");
  AmountPrivacy.set(false);
  assert.equal(chart.output.yAxis.axisLabel.formatter, undefined);
  assert.equal(chart.output.tooltip.formatter, "{b}: ¥{c}");
  assert.equal(draws, 2);
  assert.equal(cleared, 2);
  chart.draw();
  assert.equal(draws, 2, "Unchanged charts do not redraw");
  chart.componentWillUnmount();
  assert.equal(disposed, 1);
  assert.equal(disconnects, 1);

  // Visible content boundaries rerender the account page and preserves filters/state.
  const App = appClass();
  const app = instance(App);
  app.state = {
    ...app.state,
    page: "accounts",
    loading: false,
    accounts: [
      {
        id: 7,
        name: "测试银行",
        role: "ASSET",
        kind: "银行卡",
        balance: 1234567,
        group_id: null,
        active: true,
        tags: [],
        account_number: "尾号 1534",
      },
    ],
  };
  let refreshes = 0,
    renders = 0;
  app.refresh = async () => {
    refreshes++;
  };
  const filters = app.state.filters;
  const accounts = app.state.accounts;
  app.forceUpdate = () => {
    renders++;
  };
  await app.componentDidMount();
  assert.equal(RawMoney.format(1234567), "12,345.67");
  AmountPrivacy.set(true);
  assert.equal(renders, 0, "Privacy does not force an application-root update");
  const accountMarkup = renderToStaticMarkup(app.render());
  assert(!accountMarkup.includes("12,345.67"));
  assert.equal(
    RawMoney.format(1234567),
    "12,345.67",
    "Domain formatter stays pure while display is hidden",
  );
  assert.equal(app.state.filters, filters);
  assert.equal(app.state.accounts, accounts);
  assert.equal(refreshes, 1, "Hide/show does not reload reports");
  AmountPrivacy.set(false);
  assert.equal(Money.format(-1234567), "-12,345.67");
  assert.equal(RawMoney.format(1234567), "12,345.67");
  app.componentWillUnmount();
  toggle.componentWillUnmount();
  assert.equal(events.has("storage"), false);
  console.log(
    "PASS amount privacy: persistence, toggle, form values, raw fields, chart/Sankey masking and mounted-page state preservation",
  );
}
run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
