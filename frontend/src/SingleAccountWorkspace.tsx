import { ReportPeriodFilter } from "./ReportPeriodFilter";
import React from "react";
import {
  Button,
  Card,
  Collapse,
  Empty,
  Input,
  Spin,
  Tabs,
  Tag,
  message,
} from "antd";
import dayjs from "dayjs";
import { LedgerApi, MoneyFormatter as Money, Row } from "./api";
import { SingleAccountPresentation as Presentation } from "./SingleAccountPresentation";
import { Chart } from "./Chart";
import { PagedTable } from "./PagedTable";
import { AnalysisDrilldownBar } from "./AnalysisDrilldown";
import { AnalysisDetailFocus } from "./AnalysisDetailFocus";
import { SingleAccountFlow } from "./SingleAccountFlow";
import { PartyReadoutData } from "./AccountReadoutData";
import {
  AccountFlow,
  PartyMovement,
  SingleAccountDrilldown,
  SingleAccountSelection,
} from "./SingleAccountDrilldown";

interface Props {
  refreshKey: string;
  initialAccountId?: number;
  initialFilters?: Row;
  onConfigure: () => void;
  onDetail: (row: Row) => void;
}
type DetailTab = "cashflow" | "parties" | "balance";
interface State {
  filters: Row;
  report?: Row;
  loading: boolean;
  selected?: string;
  search: string;
  analysisTab?: string;
  drilldowns: Partial<Record<DetailTab, SingleAccountSelection>>;
}
export class SingleAccountWorkspace extends React.Component<Props, State> {
  api = new LedgerApi();
  detailFocus = new AnalysisDetailFocus();
  requestVersion = 0;
  state: State = {
    filters: this.props.initialFilters || ReportPeriodFilter.defaults(),
    selected: this.props.initialAccountId
      ? String(this.props.initialAccountId)
      : undefined,
    loading: true,
    search: "",
    drilldowns: {},
  };
  componentDidMount() {
    this.load();
  }
  componentDidUpdate(previous: Props) {
    if (
      previous.initialAccountId !== this.props.initialAccountId ||
      previous.initialFilters !== this.props.initialFilters
    ) {
      this.setState(
        {
          filters: this.props.initialFilters || ReportPeriodFilter.defaults(),
          selected: this.props.initialAccountId
            ? String(this.props.initialAccountId)
            : undefined,
          drilldowns: {},
        },
        () => this.load(),
      );
    } else if (previous.refreshKey !== this.props.refreshKey) this.load();
  }
  componentWillUnmount() {
    this.requestVersion++;
    this.detailFocus.cancel();
  }
  async load() {
    this.detailFocus.cancel();
    const version = ++this.requestVersion;
    this.setState({ loading: true });
    try {
      const report = await this.api.request(
        "/reports/single-accounts?" + this.api.query(this.state.filters),
      );
      if (version === this.requestVersion)
        this.setState((state) => {
          const account =
            report.accounts.find((a: Row) => String(a.id) === state.selected) ||
            report.accounts[0];
          const selected = account ? String(account.id) : undefined;
          const previousAccount = state.report?.accounts.find(
            (item: Row) => String(item.id) === state.selected,
          );
          return {
            report,
            loading: false,
            selected,
            drilldowns:
              selected === state.selected &&
              account &&
              (!previousAccount ||
                Presentation.mode(previousAccount) ===
                  Presentation.mode(account))
                ? Object.fromEntries(
                    Object.entries(state.drilldowns).map(([tab, selection]) => [
                      tab,
                      SingleAccountDrilldown.sanitize(account, selection),
                    ]),
                  )
                : {},
          };
        });
    } catch (e) {
      if (version === this.requestVersion) {
        this.setState({ loading: false });
        message.error(e instanceof Error ? e.message : "单账户分析加载失败");
      }
    }
  }
  filter(patch: Row) {
    this.detailFocus.cancel();
    this.setState(
      { filters: { ...this.state.filters, ...patch }, drilldowns: {} },
      () => this.load(),
    );
  }
  selectAccount(id: number) {
    this.detailFocus.cancel();
    if (String(id) !== this.state.selected)
      this.setState({ selected: String(id), drilldowns: {} });
  }
  detailScope(tab: DetailTab) {
    return this.state.drilldowns[tab] || {};
  }
  activeTab(account: Row) {
    const tabs = [
      ...(Presentation.cashflow(account) ? ["cashflow"] : []),
      ...(Presentation.counterparties(account) ? ["parties"] : []),
      "balance",
      "transactions",
    ];
    return this.state.analysisTab && tabs.includes(this.state.analysisTab)
      ? this.state.analysisTab
      : tabs[0];
  }
  selectDetails(
    drilldown: SingleAccountSelection,
    reveal = true,
    tab?: DetailTab,
  ) {
    if (!this.state.loading) {
      let target: DetailTab =
        tab ||
        (drilldown.party || drilldown.movement?.mode === "counterparties"
          ? "parties"
          : drilldown.category ||
              drilldown.flow ||
              drilldown.movement?.mode === "cashflow"
            ? "cashflow"
            : "balance");
      const account = this.state.report?.accounts.find(
        (row: Row) => String(row.id) === this.state.selected,
      );
      if (
        account &&
        ((target === "cashflow" && !Presentation.cashflow(account)) ||
          (target === "parties" && !Presentation.counterparties(account)))
      )
        target = "balance";
      if (reveal) this.detailFocus.request();
      else this.detailFocus.cancel();
      this.setState(
        (state) => ({
          drilldowns: { ...state.drilldowns, [target]: drilldown },
          analysisTab: target,
        }),
        () => {
          if (reveal) this.detailFocus.afterRender();
        },
      );
    }
  }
  clearDetail(key?: keyof SingleAccountSelection, tab: DetailTab = "cashflow") {
    this.detailFocus.cancel();
    this.setState((state) => {
      const drilldown = { ...state.drilldowns[tab] };
      if (key) delete drilldown[key];
      return {
        drilldowns: { ...state.drilldowns, [tab]: key ? drilldown : {} },
      };
    });
  }
  renderDetailScope(account: Row, tab: DetailTab) {
    const scope = SingleAccountDrilldown.sanitize(
      account,
      this.detailScope(tab),
    );
    const items = [];
    if (scope.day)
      items.push({
        key: "day",
        label: `日期：${scope.day}`,
        onClear: () => this.clearDetail("day", tab),
      });
    if (scope.flow)
      items.push({
        key: "flow",
        label: SingleAccountDrilldown.flowLabels[scope.flow],
        onClear: () => this.clearDetail("flow", tab),
      });
    if (scope.category)
      items.push({
        key: "category",
        label: `${scope.category.kind === "INCOME" ? "收入" : "付款"}分类：${scope.category.name}`,
        onClear: () => this.clearDetail("category", tab),
      });
    if (scope.party)
      items.push({
        key: "party",
        label: `交易方：${scope.party.name}`,
        onClear: () => this.clearDetail("party", tab),
      });
    if (scope.movement)
      items.push({
        key: "movement",
        label: scope.movement.label,
        onClear: () => this.clearDetail("movement", tab),
      });
    return (
      <AnalysisDrilldownBar
        elementRef={
          this.activeTab(account) === tab ? this.detailFocus.ref : undefined
        }
        label="本页明细筛选"
        items={items}
        onReset={() => this.clearDetail(undefined, tab)}
        resetLabel="重置本页筛选"
        emptyText={
          tab === "cashflow"
            ? "点击上方流向、分类或收支趋势，在此查看对应明细。"
            : tab === "parties"
              ? "点击上方流向或交易方，在此查看往来明细；不含期初与证券估值。"
              : "点击上方余额曲线的日期，在此查看当天账户变动。"
        }
      />
    );
  }
  renderBalance(
    account: Row,
    reset = JSON.stringify([this.state.filters, account.id]),
  ) {
    return (
      <>
        <Card title="账户余额趋势（元）">
          <Chart
            label={account.name + "余额趋势"}
            option={{
              tooltip: { trigger: "axis", renderMode: "richText" },
              grid: { left: 75, right: 25, top: 20, bottom: 40 },
              xAxis: {
                type: "category",
                data: account.trend.map((r: Row) => r.day),
                triggerEvent: true,
              },
              yAxis: { type: "value" },
              series: [
                {
                  name: "余额",
                  type: "line",
                  showSymbol: account.trend.length <= 31,
                  itemStyle: { color: "#326b53" },
                  data: account.trend.map((r: Row) => r.balance / 100),
                },
              ],
            }}
            onClick={(params) => {
              const day = SingleAccountDrilldown.day(params, account.trend);
              if (day) this.selectDetails({ day }, true, "balance");
            }}
          />
          <p className="muted single-account-caption">
            余额曲线包含所选区间的全部账户变动；点击日期查看当天明细。
          </p>
        </Card>
        {this.renderTransactions(account, reset, "balance")}
      </>
    );
  }
  renderCashflow(account: Row, reset: string) {
    const columns = [
      {
        title: "分类",
        dataIndex: "name",
        render: (name: string, row: Row) => (
          <Button
            type="link"
            size="small"
            disabled={this.state.loading || !Array.isArray(row.transaction_ids)}
            onClick={() =>
              this.selectDetails(
                {
                  category: { id: row.id, kind: row.kind, name: row.name },
                },
                true,
                "cashflow",
              )
            }
          >
            {name}
          </Button>
        ),
      },
      {
        title: "金额（元）",
        dataIndex: "amount",
        align: "right" as const,
        sorter: (a: Row, b: Row) => a.amount - b.amount,
        render: (v: number) => Money.format(v),
      },
      { title: "笔数", dataIndex: "count", align: "right" as const },
    ];
    return (
      <>
        <SingleAccountFlow
          account={account}
          mode="cashflow"
          loading={this.state.loading}
          onSelect={(scope) => this.selectDetails(scope, true, "cashflow")}
        />
        <div className="analysis-category-grid single-account-cashflow-grid mb">
          <Card title="期间资金构成">
            <div className="single-account-movements">
              {(
                [
                  ["收入", account.income, "income"],
                  ["付款原额", account.expense, "payments"],
                  ["退款抵减", account.refunds, "refunds"],
                  ["内部转入", account.transfer_in, "transfer-in"],
                  ["内部转出", account.transfer_out, "transfer-out"],
                  ["期初录入等调整", account.adjustments, "adjustments"],
                ] as [string, number, AccountFlow][]
              ).map(([label, value, flow]) => (
                <button
                  type="button"
                  className="single-account-movement"
                  key={label}
                  disabled={this.state.loading}
                  onClick={() => this.selectDetails({ flow }, true, "cashflow")}
                >
                  <span>{label}</span>
                  <strong>¥ {Money.format(Number(value))}</strong>
                </button>
              ))}
            </div>
            <p className="muted single-account-caption">
              期初余额 ＋ 收入 − 支出 ＋ 退款 ＋ 内部转账净额 ＋ 估值盈亏 ＋
              调整 ＝ 期末余额。负债账户的欠款按负数展示。
            </p>
          </Card>
          <Card title="收支趋势（元）">
            <Chart
              label={account.name + "收支趋势"}
              option={{
                tooltip: { trigger: "axis", renderMode: "richText" },
                legend: { bottom: 0 },
                grid: { left: 70, right: 25, top: 20, bottom: 65 },
                xAxis: {
                  type: "category",
                  data: account.trend.map((r: Row) => r.day),
                  triggerEvent: true,
                },
                yAxis: { type: "value" },
                series: [
                  {
                    name: "收入",
                    type: "line",
                    showSymbol: account.trend.length <= 31,
                    data: account.trend.map((r: Row) => (r.income || 0) / 100),
                    itemStyle: { color: "#6d9e8a" },
                  },
                  {
                    name: "净支出",
                    type: "line",
                    showSymbol: account.trend.length <= 31,
                    data: account.trend.map((r: Row) => (r.expense || 0) / 100),
                    itemStyle: { color: "#b78863" },
                  },
                ],
              }}
              onClick={(params) => {
                const day = SingleAccountDrilldown.day(params, account.trend);
                if (day)
                  this.selectDetails(
                    {
                      day,
                      flow:
                        params.componentType === "xAxis"
                          ? undefined
                          : params.seriesIndex === 0
                            ? "income"
                            : "expense",
                    },
                    true,
                    "cashflow",
                  );
              }}
            />
            <p className="muted single-account-caption">
              点击收入或净支出数据点查看当天记录；净支出包含付款和退款。
            </p>
          </Card>
        </div>
        <p className="muted single-account-caption">
          分类表统计收入与付款原额，不含退款；点击分类查看参与该分类的整笔账户变动。
          {account.categories.some(
            (row: Row) => !Array.isArray(row.transaction_ids),
          ) && " 分类交易归属尚未加载，请点击上方“刷新分析”后再使用分类联动。"}
        </p>
        <div className="analysis-category-grid">
          {[
            ["INCOME", "收入分类"],
            ["EXPENSE", "支出分类"],
          ].map(([kind, title]) => (
            <Card key={kind} title={title}>
              <PagedTable<Row>
                rowKey="id"
                dataSource={account.categories.filter(
                  (r: Row) => r.kind === kind,
                )}
                pageResetKey={reset}
                defaultPageSize={5}
                columns={columns}
              />
            </Card>
          ))}
        </div>
        {this.renderTransactions(account, reset, "cashflow")}
      </>
    );
  }
  renderCounterparties(account: Row, reset: string) {
    return (
      <>
        <SingleAccountFlow
          account={account}
          mode="counterparties"
          loading={this.state.loading}
          onSelect={(scope) => this.selectDetails(scope, true, "parties")}
        />
        <Card title="交易方往来">
          <p className="muted">
            默认按收款＋付款合计排序，点击名称查看明细；净额为收款减付款，含退款和内部转账，证券估值另列。
          </p>
          <PagedTable<Row>
            rowKey="key"
            dataSource={PartyReadoutData.rank(account.counterparties.parties)}
            pageResetKey={reset}
            defaultPageSize={10}
            scroll={{ x: 650 }}
            columns={[
              {
                title: "交易方",
                dataIndex: "counterparty",
                render: (name, party) => (
                  <Button
                    type="link"
                    size="small"
                    disabled={this.state.loading}
                    onClick={() =>
                      this.selectDetails(
                        { party: { key: party.key, name } },
                        true,
                        "parties",
                      )
                    }
                  >
                    {name}
                  </Button>
                ),
              },
              {
                title: "收款（元）",
                dataIndex: "incoming",
                align: "right",
                render: (v: number) => Money.format(v),
                sorter: (a: Row, b: Row) => a.incoming - b.incoming,
              },
              {
                title: "付款（元）",
                dataIndex: "outgoing",
                align: "right",
                render: (v: number) => Money.format(v),
                sorter: (a: Row, b: Row) => a.outgoing - b.outgoing,
              },
              {
                title: "累计净额（元）",
                dataIndex: "net",
                align: "right",
                render: (v: number) => Money.format(v),
                sorter: (a: Row, b: Row) => a.net - b.net,
              },
              {
                title: "收付合计（元）",
                key: "gross",
                align: "right",
                render: (_, party) =>
                  Money.format(PartyReadoutData.gross(party)),
                sorter: (a, b) =>
                  PartyReadoutData.gross(a) - PartyReadoutData.gross(b),
              },
              {
                title: "交易数",
                dataIndex: "count",
                align: "right",
                sorter: (a: Row, b: Row) => a.count - b.count,
              },
            ]}
          />
        </Card>
        {this.renderTransactions(account, reset, "parties")}
      </>
    );
  }
  renderTransactions(
    account: Row,
    reset: string,
    tab: DetailTab | "transactions" = "transactions",
  ) {
    const scope = tab === "transactions" ? {} : this.detailScope(tab);
    let rows = SingleAccountDrilldown.rows(account, scope);
    let total = account.transactions.length;
    if (tab === "parties") {
      const partyIds = new Set<number>(
        (account.counterparties?.parties || []).flatMap((party: Row) =>
          (party.transactions || []).map((row: Row) => row.id),
        ),
      );
      rows = rows.filter((row) => partyIds.has(row.id));
      total = account.transactions.filter((row: Row) =>
        partyIds.has(row.id),
      ).length;
    }
    const summary = PartyMovement.summary(rows);
    const title = {
      cashflow: "收支联动明细",
      parties: "交易方联动明细",
      balance: "日期联动明细",
      transactions: "全部账户变动",
    }[tab];
    return (
      <Card title={title} className="single-account-linked-detail">
        {tab !== "transactions" && this.renderDetailScope(account, tab)}
        <p className="muted single-account-local-summary">
          当前显示 {rows.length} / {total} 笔
          {tab === "parties" ? "交易方往来" : "账户变动"}，正向余额变动 ¥{" "}
          {Money.format(summary.incoming)}
          ，负向余额变动 ¥ {Money.format(summary.outgoing)}， 余额变化 ¥{" "}
          {Money.format(summary.net)}
          。拆分交易显示整笔账户变化，不代表所点分类的分摊金额；分类表统计收入与付款原额，退款单列。
        </p>
        <PagedTable<Row>
          rowKey="id"
          dataSource={rows}
          pageResetKey={JSON.stringify([reset, tab, scope])}
          defaultPageSize={10}
          scroll={{ x: 850 }}
          columns={[
            {
              title: "时间",
              dataIndex: "occurred_at",
              width: 180,
              sorter: (a, b) => a.occurred_at.localeCompare(b.occurred_at),
            },
            {
              title: "交易方 / 说明",
              render: (_, r) => (
                <>
                  <div>{r.counterparty || "—"}</div>
                  <small className="muted">{r.note}</small>
                </>
              ),
            },
            {
              title: "类型 / 分类",
              render: (_, r) => (
                <>
                  <Tag>
                    {r.source === "证券余额更新" && r.kind !== "OPENING"
                      ? "证券估值"
                      : (
                          {
                            INCOME: "收入",
                            EXPENSE: "支出",
                            REFUND: "退款",
                            TRANSFER: "内部转账",
                            OPENING: "期初录入",
                          } as Row
                        )[r.kind] || r.kind}
                  </Tag>
                  <small>{r.category_names.join("、")}</small>
                </>
              ),
            },
            {
              title: "余额变化（元）",
              align: "right",
              render: (_, r) => (
                <strong>
                  {r.account_change > 0 ? "+" : ""}
                  {Money.format(r.account_change)}
                </strong>
              ),
              sorter: (a, b) => a.account_change - b.account_change,
            },
            {
              title: "操作",
              width: 70,
              render: (_, r) => (
                <Button
                  type="link"
                  size="small"
                  onClick={() => this.props.onDetail(r)}
                >
                  查看
                </Button>
              ),
            },
          ]}
        />
      </Card>
    );
  }
  renderAccount(account: Row) {
    const reset = JSON.stringify([this.state.filters, account.id]);
    const items = [
      ...(Presentation.cashflow(account)
        ? [
            {
              key: "cashflow",
              label: "收支分析",
              children: this.renderCashflow(account, reset),
            },
          ]
        : []),
      ...(Presentation.counterparties(account)
        ? [
            {
              key: "parties",
              label: `交易方分析（${account.counterparties.party_count}）`,
              children: this.renderCounterparties(account, reset),
            },
          ]
        : []),
      {
        key: "balance",
        label: "余额趋势",
        children: this.renderBalance(account, reset),
      },
      {
        key: "transactions",
        label: "全部账户变动",
        children: this.renderTransactions(account, reset),
      },
    ];
    const activeKey = this.activeTab(account);
    return (
      <div className="single-account-detail">
        <div className="metrics analysis-metrics">
          <div className="metric">
            <span>期初账面余额</span>
            <strong>¥ {Money.format(account.opening_balance)}</strong>
            <small>开始日期之前的累计余额</small>
          </div>
          <div className="metric featured">
            <span>期末账面余额</span>
            <strong>¥ {Money.format(account.ending_balance)}</strong>
            <small>
              {account.reconciled ? "已与账户流水核对" : "请核对账户流水"}
            </small>
          </div>
          <div className="metric">
            <span>期间余额变化</span>
            <strong>¥ {Money.format(account.change)}</strong>
            <small>{account.count} 笔有效变动</small>
          </div>
          <div className="metric">
            <span>证券估值盈亏</span>
            <strong>¥ {Money.format(account.valuation_profit)}</strong>
            <small>本金转入、转出不计为盈亏</small>
          </div>
        </div>
        <p className="muted single-account-caption">
          以上概览为完整账户在所选日期的余额与变动，不随局部明细筛选改变。
        </p>
        <Tabs
          className="single-account-analysis-tabs"
          activeKey={activeKey}
          onChange={(analysisTab) => {
            this.detailFocus.cancel();
            this.setState({ analysisTab });
          }}
          items={items}
        />
      </div>
    );
  }
  renderComparison(accounts: Row[]) {
    return (
      <Collapse
        className="single-account-comparison"
        items={[
          {
            key: "comparison",
            label: `账户比较 · ${accounts.length} 个账户`,
            children: (
              <PagedTable<Row>
                rowKey="id"
                dataSource={accounts}
                pageResetKey={JSON.stringify(this.state.filters)}
                defaultPageSize={10}
                scroll={{ x: 720 }}
                columns={[
                  {
                    title: "账户",
                    render: (_, account) => (
                      <Button
                        type="link"
                        size="small"
                        onClick={() => this.selectAccount(account.id)}
                      >
                        {account.name}
                      </Button>
                    ),
                  },
                  {
                    title: "分析内容",
                    render: (_, account) => (
                      <Tag>{Presentation.label(account)}</Tag>
                    ),
                  },
                  {
                    title: "期初余额（元）",
                    dataIndex: "opening_balance",
                    align: "right",
                    render: (v) => Money.format(v),
                  },
                  {
                    title: "期末余额（元）",
                    dataIndex: "ending_balance",
                    align: "right",
                    render: (v) => Money.format(v),
                  },
                  {
                    title: "期间变化（元）",
                    dataIndex: "change",
                    align: "right",
                    render: (v) => Money.format(v),
                    sorter: (a, b) => a.change - b.change,
                  },
                  { title: "交易数", dataIndex: "count", align: "right" },
                ]}
              />
            ),
          },
        ]}
      />
    );
  }
  render() {
    const { report, loading, filters, search } = this.state;
    const accounts: Row[] = report?.accounts || [];
    const account =
      accounts.find((item) => String(item.id) === this.state.selected) ||
      accounts[0];
    const query = search.trim().toLocaleLowerCase();
    const visibleAccounts = accounts.filter((item) =>
      item.name.toLocaleLowerCase().includes(query),
    );
    return (
      <div className="single-account-workspace">
        <div className="analysis-intro">
          <p className="muted">选择账户，查看余额、收支和交易方往来。</p>
        </div>
        <div className="filters">
          <ReportPeriodFilter
            refreshKey={this.props.refreshKey}
            filters={filters}
            label="单账户分析日期"
            onChange={(patch) => this.filter(patch)}
          />
          <Button onClick={this.props.onConfigure}>配置分析账户</Button>
          <Button loading={loading} onClick={() => this.load()}>
            刷新分析
          </Button>
        </div>
        {!report ? (
          <Card loading={loading} />
        ) : (
          <Spin spinning={loading}>
            {!accounts.length ? (
              <Card>
                <Empty description="尚未配置关注或屏蔽账户">
                  <Button type="primary" onClick={this.props.onConfigure}>
                    去配置账户
                  </Button>
                </Empty>
              </Card>
            ) : (
              <div className="single-account-layout single-account-layout-top">
                <section
                  className="single-account-selector single-account-list"
                  aria-label="选择分析账户"
                >
                  <div className="single-account-selector-heading">
                    <div className="single-account-list-heading">
                      <strong>分析账户</strong>
                      <span className="muted">
                        {query
                          ? `${visibleAccounts.length} / ${accounts.length} 个`
                          : `${accounts.length} 个`}
                      </span>
                    </div>
                    <Input.Search
                      className="single-account-selector-search"
                      aria-label="搜索全部分析账户"
                      placeholder="搜索分析账户"
                      allowClear
                      value={search}
                      onChange={(event) =>
                        this.setState({ search: event.target.value })
                      }
                    />
                  </div>
                  <div
                    className="single-account-options single-account-picker-options"
                    role="group"
                    aria-label="选择分析账户"
                  >
                    {visibleAccounts.length ? (
                      visibleAccounts.map((item) => {
                        const selected = String(item.id) === String(account.id);
                        return (
                          <button
                            key={item.id}
                            type="button"
                            className={`single-account-option${selected ? " single-account-option-selected" : ""}`}
                            aria-pressed={selected}
                            aria-controls="single-account-main"
                            aria-label={`${item.name}，期末余额 ${Money.format(item.ending_balance)} 元，${Presentation.label(item)}`}
                            onClick={() => this.selectAccount(item.id)}
                          >
                            <span className="single-account-option-primary">
                              <span
                                className="single-account-option-name"
                                title={item.name}
                              >
                                {item.name}
                              </span>
                              <span className="single-account-option-balance">
                                ¥ {Money.format(item.ending_balance)}
                              </span>
                            </span>
                            <span className="single-account-option-secondary">
                              <Tag>{Presentation.label(item)}</Tag>
                              <span className="single-account-option-change">
                                <span>期间变化</span>
                                <strong>
                                  {item.change > 0 ? "+" : ""}
                                  {Money.format(item.change)}
                                </strong>
                              </span>
                            </span>
                          </button>
                        );
                      })
                    ) : (
                      <Empty
                        image={Empty.PRESENTED_IMAGE_SIMPLE}
                        description="没有匹配的账户"
                      />
                    )}
                  </div>
                </section>
                {this.renderComparison(accounts)}
                <section
                  className="single-account-main"
                  id="single-account-main"
                  aria-label={`${account.name}账户分析`}
                >
                  <div className="single-account-heading">
                    <div>
                      <h2>{account.name}</h2>
                      <p className="single-account-caption muted">
                        {dayjs(report.start || filters.start).format(
                          "YYYY.MM.DD",
                        )}{" "}
                        —{" "}
                        {dayjs(report.end || filters.end).format("YYYY.MM.DD")}
                        <span> · {account.count} 笔有效变动</span>
                      </p>
                    </div>
                    <Tag>{Presentation.label(account)}</Tag>
                  </div>
                  {this.renderAccount(account)}
                </section>
              </div>
            )}
          </Spin>
        )}
      </div>
    );
  }
}
