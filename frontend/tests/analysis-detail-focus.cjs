const assert = require("node:assert/strict");
const path = require("node:path");
const React = require("react");
const { loadTs } = require("./source-loader.cjs");
const source = (name) => loadTs(path.resolve(__dirname, "../src", name));
const { AnalysisDetailFocus } = source("AnalysisDetailFocus.ts");
const { AnalysisDrilldownBar } = source("AnalysisDrilldown.tsx");
const { SingleAccountWorkspace } = source("SingleAccountWorkspace.tsx");
const { SingleAccountFlow } = source("SingleAccountFlow.tsx");
const { AccountMovementSection } = source("AccountMovementSection.tsx");
const { FundFlowWorkspace } = source("FundFlowWorkspace.tsx");
const { DistributionDiagram } = source("DistributionDiagram.tsx");

function instance(Component, props, state = {}) {
  const value = new Component(props);
  value.state = { ...value.state, ...state };
  value.setState = (patch, done) => {
    value.state = {
      ...value.state,
      ...(typeof patch === "function"
        ? patch(value.state, value.props)
        : patch),
    };
    done?.();
  };
  return value;
}
function elements(tree) {
  if (Array.isArray(tree)) return tree.flatMap(elements);
  return React.isValidElement(tree)
    ? [tree, ...elements(tree.props.children)]
    : [];
}
const find = (tree, type) => elements(tree).find((node) => node.type === type);

async function verify() {
  const globals = ["window", "requestAnimationFrame", "cancelAnimationFrame"];
  const originals = globals.map((key) =>
    Object.getOwnPropertyDescriptor(global, key),
  );
  const frames = new Map();
  const scrolls = [];
  let sequence = 0;
  let systemReduced = false;
  const windowStub = {
    innerHeight: 800,
    matchMedia: () => ({ matches: systemReduced }),
  };
  global.window = windowStub;
  global.requestAnimationFrame = (callback) => {
    frames.set(++sequence, callback);
    return sequence;
  };
  global.cancelAnimationFrame = (id) => frames.delete(id);
  const frame = () => {
    for (const [id, callback] of [...frames]) {
      frames.delete(id);
      callback();
    }
  };
  const flush = () => {
    for (let count = 0; count < 4 && frames.size; count++) frame();
    assert.equal(
      frames.size,
      0,
      "Hidden results must not leave a polling loop",
    );
  };
  const target = (top = 1000, patch = {}) => ({
    isConnected: true,
    dataset: {},
    closest: () => null,
    getBoundingClientRect: () => ({ top, height: 60 }),
    scrollIntoView: (options) => scrolls.push(options),
    focus: () =>
      assert.fail("Revealing a result must not steal keyboard focus"),
    ...patch,
  });
  const expect = (behavior, action) => {
    action();
    flush();
    assert.deepEqual(
      scrolls.splice(0),
      behavior ? [{ block: "start", inline: "nearest", behavior }] : [],
    );
  };
  const reveal = (focus, reduced = false) => {
    focus.request(reduced);
    focus.afterRender();
  };

  try {
    const focus = new AnalysisDetailFocus();
    focus.ref.current = target();
    expect(undefined, () => focus.afterRender());
    focus.request();
    focus.afterRender();
    assert.equal(scrolls.length, 0, "Wait until the selected result commits");
    expect("smooth", () => {});
    focus.ref.current = target(100);
    expect(undefined, () => reveal(focus));
    focus.ref.current = target(650);
    expect("smooth", () => reveal(focus)); // Header visible, table below the fold.

    windowStub.getComputedStyle = () => ({ scrollMarginTop: "88px" });
    focus.ref.current = target(50);
    expect("smooth", () => reveal(focus)); // Sticky report tabs cover this position.
    focus.ref.current = target(100);
    expect(undefined, () => reveal(focus));
    delete windowStub.getComputedStyle;

    systemReduced = true;
    focus.ref.current = target();
    expect("instant", () => reveal(focus));
    systemReduced = false;
    const bar = new AnalysisDrilldownBar({
      items: [{ key: "account", label: "所选账户" }],
      onReset: () => {},
      elementRef: focus.ref,
    });
    bar.context = { reducedMotion: true };
    const section = bar.render();
    assert.equal(section.props.ref, focus.ref);
    assert.equal(section.props["data-detail-selected"], "true");
    assert.equal(section.props["data-reduced-motion"], "true");
    focus.ref.current = target(1000, {
      dataset: { reducedMotion: section.props["data-reduced-motion"] },
    });
    expect("instant", () => reveal(focus));
    focus.ref.current = target();
    expect("instant", () => reveal(focus, true));
    expect(undefined, () => {
      reveal(focus);
      focus.cancel();
    });
    expect("instant", () => {
      reveal(focus);
      reveal(focus, true);
    });

    focus.ref.current = null;
    reveal(focus);
    frame();
    assert.equal(scrolls.length, 0);
    focus.ref.current = target();
    expect("smooth", () => {});
    for (const patch of [
      { closest: () => ({ hidden: true }) },
      { isConnected: false },
      { getBoundingClientRect: () => ({ top: 1000, height: 0 }) },
    ]) {
      focus.ref.current = target(1000, patch);
      expect(undefined, () => reveal(focus));
      focus.ref.current = target();
      expect(undefined, () => focus.afterRender());
    }
    global.window = undefined;
    expect(undefined, () => reveal(focus));
    global.window = windowStub;
    expect(undefined, () => focus.afterRender()); // No deferred SSR replay.

    const account = {
      id: 1,
      name: "分析账户",
      analysis_mode: "both",
      categories: [],
      trend: [],
      transactions: [],
      counterparties: { parties: [], valuations: [], party_count: 0 },
    };
    const single = instance(
      SingleAccountWorkspace,
      {
        refreshKey: "test",
        onConfigure: () => {},
        onDetail: () => {},
      },
      { loading: false, report: { accounts: [account] }, selected: "1" },
    );
    single.detailFocus.ref.current = target();
    const originalFilters = JSON.stringify(single.state.filters);
    for (const [tree, mode, tab] of [
      [single.renderCashflow(account, "test"), "cashflow", "cashflow"],
      [single.renderCounterparties(account, "test"), "counterparties", "parties"],
    ]) {
      const scope = {
        movement: { key: mode, label: "图中范围", mode, transaction_ids: [] },
      };
      expect("smooth", () =>
        find(tree, SingleAccountFlow).props.onSelect(scope),
      );
      assert.equal(single.state.analysisTab, tab);
      assert.deepEqual(single.detailScope(tab), scope);
      for (const detailTab of ["cashflow", "parties", "balance"])
        assert.equal(
          single.renderDetailScope(account, detailTab).props.elementRef,
          detailTab === tab ? single.detailFocus.ref : undefined,
          "Only the active tab can own the reveal target",
        );
    }
    assert.equal(JSON.stringify(single.state.filters), originalFilters);
    for (const active of ["cashflow", "parties", "balance", "transactions"]) {
      single.state.analysisTab = active;
      const tabs = elements(single.renderAccount(account)).find((node) => Array.isArray(node.props.items) && node.props.items.some((item) => item.key === "cashflow"));
      const bars = tabs.props.items.flatMap((item) => elements(item.children)).filter((node) => node.type === AnalysisDrilldownBar);
      assert.equal(bars.filter((node) => node.props.elementRef === single.detailFocus.ref).length, active === "transactions" ? 0 : 1);
    }
    expect("smooth", () => single.selectDetails({ flow: "expense" }));
    expect(undefined, () => single.selectDetails({ flow: "income" }, false));
    assert.equal(single.state.analysisTab, "cashflow");
    expect("smooth", () => single.selectDetails({ day: "2026-10-01" }));
    assert.equal(single.state.analysisTab, "balance");
    expect("smooth", () => single.selectDetails({ party: { key: "party:test", name: "测试交易方" } }));
    assert.equal(single.state.analysisTab, "parties");
    single.api.request = async () => ({ accounts: [account] });
    single.selectDetails({ flow: "income" }, true);
    await single.load();
    expect(undefined, () => single.detailFocus.afterRender());
    expect(undefined, () => {
      single.selectDetails({ flow: "income" }, true);
      single.selectAccount(2);
    });
    expect(undefined, () => {
      single.selectDetails({ flow: "income" }, true);
      single.componentWillUnmount();
    });

    const movementReport = {
      start: "2026-10-01",
      end: "2026-10-18",
      accounts: [
        {
          id: 1,
          name: "资金账户",
          role: "ASSET",
          kind: "银行卡",
          active: true,
          opening_balance: 0,
          ending_balance: 100,
          net_change: 100,
          inflow: 100,
          outflow: 0,
          transaction_count: 1,
          breakdown: [],
        },
      ],
      totals: {},
    };
    const movement = instance(AccountMovementSection, {
      report: movementReport,
      groups: [],
    });
    movement.detailFocus.ref.current = target();
    const movementSelection = {
      namespace: "movement:increase",
      level: "root",
      label: "净值增加",
    };
    assert.equal(
      find(movement.render(), AnalysisDrilldownBar).props.elementRef,
      movement.detailFocus.ref,
    );
    expect("smooth", () =>
      find(movement.render(), DistributionDiagram).props.onSelect(
        movementSelection,
      ),
    );
    assert.deepEqual(movement.state.selection, movementSelection);
    expect(undefined, () => movement.componentDidUpdate(movement.props));
    expect(undefined, () => {
      movement.select(movementSelection);
      movement.clearSelection();
    });
    expect(undefined, () => {
      movement.select(movementSelection);
      const previous = movement.props;
      movement.props = {
        ...previous,
        report: { ...movementReport, end: "2026-10-19" },
      };
      movement.componentDidUpdate(previous);
    });
    assert.equal(movement.state.selection, undefined);
    expect(undefined, () => {
      movement.select(movementSelection);
      movement.componentWillUnmount();
    });

    const report = {
      start: "2026-10-01",
      end: "2026-10-18",
      scope_account_ids: [1],
      groups: [],
      endpoints: [
        { key: "external", name: "外部收入", external: true },
        {
          key: "account:1",
          account_id: 1,
          name: "资金账户",
          in_scope: true,
          external: false,
        },
      ],
      flows: [
        {
          id: "flow:1",
          source: "external",
          target: "account:1",
          kind: "INCOME",
          transaction_id: 1,
          amount: 100,
        },
      ],
      transactions: [
        {
          id: 1,
          kind: "INCOME",
          amount: 100,
          allocation: "allocated",
          entries: [],
        },
      ],
      unallocated: [],
      excluded: [],
    };
    const fund = instance(
      FundFlowWorkspace,
      {
        accounts: [],
        groups: [],
        refreshKey: "test",
        onDetail: () => {},
      },
      { loading: false, report },
    );
    fund.detailFocus.ref.current = target();
    const diagram = find(fund.renderReport(report), DistributionDiagram);
    assert.equal(
      find(fund.renderReport(report), AnalysisDrilldownBar).props.elementRef,
      fund.detailFocus.ref,
    );
    const selection = diagram.props.data.selectionFor(
      diagram.props.data.nodes[0].name,
    );
    expect("smooth", () => diagram.props.onSelect(selection));
    assert.equal(fund.state.activeTab, "transactions");
    assert.deepEqual(fund.state.selection, selection);
    assert.deepEqual(fund.state.filters, {period:"latest_month"});
    expect(undefined, () => {
      fund.select(selection);
      fund.display({ view: "external" });
    });
    assert.equal(fund.state.selection, undefined);
    expect(undefined, () => fund.display({ dimension: "group" }));
    fund.api.request = async () => report;
    fund.select(selection);
    await fund.load();
    expect(undefined, () => fund.detailFocus.afterRender());
    expect(undefined, () => {
      fund.select(selection);
      fund.componentWillUnmount();
    });
    console.log(
      "Explicit chart-to-detail positioning, visible/hidden/disconnected results, reduced motion, cancellation, SSR and three workspace integrations passed.",
    );
  } finally {
    frames.clear();
    globals.forEach((key, index) => {
      if (originals[index])
        Object.defineProperty(global, key, originals[index]);
      else delete global[key];
    });
  }
}

verify().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
