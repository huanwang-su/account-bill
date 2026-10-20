import { MetricCard } from "./MetricCard";
import { AccountChoices } from "./AccountChoices";
import { LatestRequest } from "./LatestRequest";
import { ReportPeriodFilter } from "./ReportPeriodFilter";
import React from "react";
import { StatisticTone as Tone } from "./StatisticTone";
import { AmountInput as InputNumber } from "./AmountInput";
import {
  Button,
  Card,
  Empty,
  Select,
  Slider,
  Space,
  Spin,
  Tabs,
  Tag,
  TreeSelect,
  message,
} from "antd";
import dayjs from "dayjs";
import {
  AccountGroupTree,
  CategoryTree,
  LedgerApi,
  DisplayMoneyFormatter as Money,
  Row,
} from "./api";
import { Chart } from "./Chart";
import { DistributionDiagram } from "./DistributionDiagram";
import { AccountDistribution } from "./AccountDistribution";
import { ExpenseDistribution, SpendingScenario } from "./ExpenseDistribution";
import { AnalysisScopeNotice } from "./AnalysisAccountScope";
import { PagedTable } from "./PagedTable";
import { AnalysisFlowSelection } from "./AnalysisFlowSelection";
import { AnalysisDetailFocus } from "./AnalysisDetailFocus";
import {
  AnalysisDrilldownBar,
  ReportDrilldown,
  type DetailPeriod,
} from "./AnalysisDrilldown";
import {
  AnalysisFilterPanel,
  AnalysisFilterSelection,
} from "./AnalysisFilterPanel";

import { ReportMetrics as Readout } from "./ReportMetrics";

interface Props {
  groups: Row[];
  accounts: Row[];
  categories: Row[];
  refreshKey: string;
  onDetail: (row: Row) => void;
  onConfigure?: () => void;
}
interface State {
  filters: Row;
  threshold?: number;
  loading: boolean;
  report?: Row;
  selected: number[];
  percent: number;
  activeTab: string;
  detailPeriod?: DetailPeriod;
}
export class ExpenseWorkspace extends React.Component<Props, State> {
  api = new LedgerApi();
  loader = new LatestRequest(this.api);
  detailFocus = new AnalysisDetailFocus();
  state: State = {
    filters: ReportPeriodFilter.defaults(),
    loading: true,
    selected: [],
    percent: 10,
    activeTab: "categories",
  };
  componentDidMount() {
    this.load();
  }
  componentDidUpdate(previous: Props) {
    if (previous.refreshKey !== this.props.refreshKey) this.load();
  }
  componentWillUnmount() {
    this.loader.dispose();
    this.detailFocus.cancel();
  }
  async load(reveal = false) {
    if (!reveal) this.detailFocus.cancel();
    const version = this.loader.begin();
    this.setState({ loading: true, detailPeriod: undefined });
    try {
      const report = await this.api.request(
        "/reports/expenses?" +
          this.api.query({
            ...this.state.filters,
            large_amount: this.state.threshold,
          }),
      );
      if (this.loader.current(version))
        this.setState({ report, loading: false }, () =>
          this.detailFocus.afterRender(),
        );
    } catch (error) {
      if (this.loader.current(version)) {
        this.detailFocus.cancel();
        this.setState({ loading: false });
        message.error(
          error instanceof Error ? error.message : "支出分析加载失败",
        );
      }
    }
  }
  filter(patch: Row, activeTab = this.state.activeTab, reveal = false) {
    if (reveal) this.detailFocus.request();
    else this.detailFocus.cancel();
    this.setState(
      {
        filters: { ...this.state.filters, ...patch },
        selected: [],
        activeTab,
        detailPeriod: undefined,
      },
      () => this.load(reveal),
    );
  }
  changeTab(activeTab: string) {
    this.detailFocus.cancel();
    this.setState({ activeTab });
  }
  selectPeriod(value: unknown) {
    if (this.state.loading) return;
    const period = ReportDrilldown.period(value, "day", this.state.filters);
    if (
      !period ||
      !this.state.report?.transactions.some((row: Row) =>
        ReportDrilldown.contains(period, row.occurred_at),
      )
    )
      return;
    this.detailFocus.request();
    this.setState({ detailPeriod: period }, () =>
      this.detailFocus.afterRender(),
    );
  }
  clearPeriod() {
    this.detailFocus.cancel();
    this.setState({ detailPeriod: undefined });
  }
  detailPeriodBar() {
    const { detailPeriod } = this.state;
    return (
      <AnalysisDrilldownBar
        elementRef={this.detailFocus.ref}
        label="明细日期"
        items={
          detailPeriod
            ? [
                {
                  key: "period",
                  label: detailPeriod.label,
                  onClear: () => this.clearPeriod(),
                },
              ]
            : []
        }
        onReset={() => this.clearPeriod()}
        resetLabel="返回统计区间"
        emptyText="点击有交易的日支出柱，查看当天开支与退款。"
      />
    );
  }
  periodTransactions(report: Row): Row[] {
    return report.transactions.filter((row: Row) =>
      ReportDrilldown.contains(this.state.detailPeriod, row.occurred_at),
    );
  }
  renderPeriodDetails(report: Row) {
    return (
      <Card title="日支出联动明细" className="mb analysis-linked-details">
        {this.detailPeriodBar()}
        <p className="muted analysis-detail-note">
          仅缩小本表日期，保留当前账户、用途和流向范围；统计金额与图表保持原区间，退款按负额保留。
        </p>
        {this.transactionTable(
          this.periodTransactions(report),
          this.state.detailPeriod,
        )}
      </Card>
    );
  }
  selectFlow(selection: Row) {
    if (this.state.loading) return;
    const filters = AnalysisFlowSelection.narrow(
      this.state.filters,
      selection,
      this.props.groups,
      this.props.categories,
    );
    if (JSON.stringify(filters) === JSON.stringify(this.state.filters)) {
      this.detailFocus.request();
      this.setState({ activeTab: "details", detailPeriod: undefined }, () =>
        this.detailFocus.afterRender(),
      );
    } else this.filter(filters, "details", true);
  }
  clearFlow() {
    this.filter({
      group_id: undefined,
      direct_group: undefined,
      category_id: undefined,
      exact_category: undefined,
    });
  }

  range(mode: string) {
    const end =
      mode === "last" ? dayjs().subtract(1, "month").endOf("month") : dayjs();
    const start =
      mode === "30" ? end.subtract(29, "day") : end.startOf("month");
    this.filter({
      start: start.format("YYYY-MM-DD"),
      end: end.format("YYYY-MM-DD"),
    });
  }
  async detail(id: number) {
    try {
      const row = await this.api.transaction(id);
      if (row) this.props.onDetail(row);
    } catch (error) {
      message.error(error instanceof Error ? error.message : "明细加载失败");
    }
  }
  transactionTable(rows: Row[], detailPeriod?: DetailPeriod) {
    return (
      <PagedTable<Row>
        rowKey="id"
        dataSource={rows}
        pageResetKey={JSON.stringify([
          this.state.filters,
          this.state.report?.excluded_account_ids,
          detailPeriod,
        ])}
        defaultPageSize={10}
        columns={[
          { title: "时间", dataIndex: "occurred_at", width: 170 },
          {
            title: "交易方 / 说明",
            render: (_, r) => (
              <>
                <div>{r.counterparty || "未填写交易方"}</div>
                <small className="muted">{r.note}</small>
              </>
            ),
          },
          { title: "用途", render: (_, r) => r.category_names.join("、") },
          {
            title: "类型",
            width: 80,
            render: (_, r) => (
              <Tag>{r.kind === "REFUND" ? "退款抵减" : "付款"}</Tag>
            ),
          },
          {
            title: "金额（元）",
            dataIndex: "amount",
            align: "right",
            sorter: (a, b) => a.amount - b.amount,
            render: (v) => Money.format(v),
          },
          {
            title: "操作",
            width: 75,
            render: (_, r) => (
              <Button
                type="link"
                size="small"
                onClick={() => this.detail(r.id)}
              >
                查看
              </Button>
            ),
          },
        ]}
      />
    );
  }
  render() {
    const {
      filters,
      report,
      loading,
      selected,
      percent,
      threshold,
      detailPeriod,
    } = this.state;
    const graph = report
      ? new ExpenseDistribution(report, this.props.groups)
      : undefined;
    const plan = SpendingScenario.estimate(
      report?.parents || [],
      selected,
      percent,
    );
    const flowSelected =
      filters.group_id !== undefined || filters.category_id !== undefined;
    return (
      <div className="expense-workspace">
        <div className="analysis-intro">
          <p className="muted">看清钱花在哪里，再决定哪些开支值得调整。</p>
        </div>
        <AnalysisFilterPanel
          id="expense-analysis-filters"
          label="支出分析"
          primary={
            <>
              <span className="analysis-filter-label">统计时间</span>
              <ReportPeriodFilter
                refreshKey={this.props.refreshKey}
                filters={filters}
                label="支出分析日期"
                onChange={(patch) => this.filter(patch)}
              />
            </>
          }
          advanced={
            <>
              <div className="analysis-filter-field">
                <span>账户组</span>
                <Select
                  allowClear
                  aria-label="支出分析账户组"
                  placeholder="全部账户组"
                  style={{ width: 200 }}
                  value={filters.group_id}
                  options={[
                    ...new AccountGroupTree(this.props.groups).options(),
                    { value: 0, label: "未分组" },
                  ]}
                  onChange={(group_id) =>
                    this.filter({
                      group_id,
                      direct_group: group_id === 0 ? true : undefined,
                    })
                  }
                />
              </div>
              <div className="analysis-filter-field">
                <span>资金账户</span>
                <Select
                  allowClear
                  aria-label="支出分析账户"
                  placeholder="全部资金账户"
                  style={{ width: 210 }}
                  value={filters.account_id}
                  options={AccountChoices.rank(this.props.accounts)
                    .filter(
                      (a) =>
                        !a.merged_into_id &&
                        ["ASSET", "LIABILITY"].includes(a.role),
                    )
                    .map((a) => ({ value: a.id, label: a.name }))}
                  onChange={(account_id) => this.filter({ account_id })}
                />
              </div>
              <div className="analysis-filter-field">
                <span>支出用途</span>
                <TreeSelect
                  allowClear
                  aria-label="支出分析分类"
                  placeholder="全部支出用途"
                  style={{ width: 210 }}
                  treeData={[
                    ...new CategoryTree(this.props.categories).options(
                      "EXPENSE",
                    ),
                    { value: 0, title: "未分类" },
                    { value: -1, title: "退款抵减" },
                  ]}
                  value={filters.category_id}
                  onChange={(category_id) =>
                    this.filter({ category_id, exact_category: undefined })
                  }
                />
              </div>
            </>
          }
          summary={new AnalysisFilterSelection(filters, this.props).items()}
          onClear={(patch) => this.filter(patch)}
          reset={
            <Button
              onClick={() =>
                this.setState(
                  {
                    filters: ReportPeriodFilter.defaults(),
                    selected: [],
                    threshold: undefined,
                  },
                  () => this.load(),
                )
              }
            >
              重置条件
            </Button>
          }
        />
        <AnalysisScopeNotice
          accounts={this.props.accounts}
          excludedIds={report?.excluded_account_ids}
          accountId={filters.account_id}
          onConfigure={this.props.onConfigure}
        />
        {!report ? (
          <Card loading={loading} />
        ) : (
          <Spin spinning={loading}>
            <div className="metrics analysis-metrics">
              <MetricCard
                className="metric featured"
                data-tone={Tone.of(report.expense, "expense")}
              >
                <span>家庭净支出</span>
                <strong>¥ {Money.format(report.expense)}</strong>
                <small>
                  付款入账 {Money.format(report.paid)} − 独立退款{" "}
                  {Money.format(report.refunds)}
                </small>
              </MetricCard>
              <MetricCard
                className="metric"
                data-tone={Tone.of(report.average_daily, "expense")}
              >
                <span>日均开支</span>
                <strong>¥ {Money.format(report.average_daily)}</strong>
                <small>
                  {report.days} 天 · {report.count} 笔付款
                </small>
              </MetricCard>
              <MetricCard
                className="metric"
                data-tone={Tone.of(report.change, "expense")}
              >
                <span>与上期等长区间比较</span>
                <strong>
                  {report.change > 0 ? "+" : ""}¥ {Money.format(report.change)}
                </strong>
                <small>
                  {report.previous_start} 至 {report.previous_end}
                </small>
              </MetricCard>
              <MetricCard className="metric">
                <span>大额付款</span>
                <strong>{report.large_count} 笔</strong>
                <small>
                  单笔 ≥ ¥ {Money.format(report.large_amount_minor)}
                </small>
              </MetricCard>
            </div>

            <Card
              className="mb balance-flow-card"
              title="钱经过哪些账户组、花在了哪里？"
              extra={
                <Space>
                  <Button
                    size="small"
                    disabled={!flowSelected}
                    onClick={() => this.clearFlow()}
                  >
                    重置流向
                  </Button>
                  <strong>¥ {Money.format(report.expense)}</strong>
                </Space>
              }
            >
              <p className="balance-flow-hint">
                支出总额 → 账户组 → 一级分类 →
                二级分类。点击节点或连线，联动当前页金额、趋势与交易明细；直接记在一级分类的开支列为“未细分”。
              </p>
              {graph!.nodes.length ? (
                <DistributionDiagram
                  data={graph!}
                  label="家庭支出桑基图"
                  columns={["支出总额", "账户组", "一级分类", "二级分类"]}
                  onSelect={(patch) => this.selectFlow(patch)}
                />
              ) : (
                <Empty description="当前条件下暂无正额开支" />
              )}
              {graph!.adjustments.length > 0 && (
                <div className="balance-flow-adjustments">
                  <strong>退款净抵减</strong>
                  {graph!.adjustments.map((r) => (
                    <div key={r.id}>
                      <span>
                        <Button
                          type="link"
                          size="small"
                          onClick={() => this.selectFlow(r.selection)}
                        >
                          {r.path ||
                            `${AccountDistribution.path(this.props.groups, r.group_id) || "未分组"} / ${r.name}`}
                        </Button>
                      </span>
                      <span>¥ {Money.format(r.amount)}</span>
                    </div>
                  ))}
                  <p>
                    图中正额 ¥ {Money.format(graph!.positiveTotal)} ＋ 抵减 ¥{" "}
                    {Money.format(graph!.total - graph!.positiveTotal)} ＝
                    家庭净支出 ¥ {Money.format(graph!.total)}
                  </p>
                </div>
              )}
            </Card>
            <Card
              className="mb"
              title="哪几天的净支出较多？（元）"
              extra={
                <small className="muted">
                  点击柱状图，在当前页签下方查看当天明细
                </small>
              }
            >
              <Chart
                label="每日家庭开支趋势"
                onClick={(params) => {
                  if (report === this.state.report)
                    this.selectPeriod(params.data?.day);
                }}
                option={{
                  tooltip: { trigger: "axis", renderMode: "richText" },
                  grid: { left: 65, right: 25, top: 15, bottom: 40 },
                  xAxis: {
                    type: "category",
                    data: report.trend.map((r: Row) => r.day.slice(5)),
                  },
                  yAxis: { type: "value" },
                  series: [
                    {
                      type: "bar",
                      barMaxWidth: 24,
                      itemStyle: { color: "#b78863" },
                      data: report.trend.map((r: Row) => ({
                        value: r.expense / 100,
                        day: r.day,
                      })),
                    },
                  ],
                }}
              />
            </Card>
            <Tabs
              activeKey={this.state.activeTab}
              onChange={(activeTab) => this.changeTab(activeTab)}
              items={[
                {
                  key: "categories",
                  label: "用途与调整试算",
                  children: (
                    <div className="spending-plan-layout">
                      <Card title="哪些用途值得进一步核对？">
                        <PagedTable<Row>
                          rowKey="id"
                          dataSource={report.parents}
                          defaultPageSize={10}
                          pageResetKey={JSON.stringify([
                            filters,
                            report?.excluded_account_ids,
                          ])}
                          rowSelection={{
                            selectedRowKeys: selected,
                            onChange: (keys) =>
                              this.setState({ selected: keys as number[] }),
                            getCheckboxProps: (r) => ({
                              disabled: r.amount <= 0,
                            }),
                          }}
                          columns={[
                            { title: "分类", dataIndex: "name" },
                            {
                              title: "净支出",
                              dataIndex: "amount",
                              align: "right",
                              sorter: (a, b) => a.amount - b.amount,
                              render: (v) => Money.format(v),
                            },
                            {
                              title: "上期",
                              dataIndex: "previous_amount",
                              align: "right",
                              render: (v) => Money.format(v),
                            },
                            {
                              title: "变动",
                              dataIndex: "change",
                              align: "right",
                              render: (v) =>
                                `${v > 0 ? "+" : ""}${Money.format(v)}`,
                            },
                            {
                              title: "占比",
                              dataIndex: "share",
                              align: "right",
                              render: (value, row) =>
                                row.amount > 0
                                  ? Readout.percentage(value, 1) || "—"
                                  : "—",
                            },
                            {
                              title: "付款笔数",
                              dataIndex: "count",
                              align: "right",
                            },
                          ]}
                        />
                      </Card>
                      <Card
                        className="spending-plan"
                        title="调整幅度试算（可选）"
                      >
                        <span className="muted">选中分类的参考净支出</span>
                        <h3>¥ {Money.format(plan.base)}</h3>
                        <p>计划压减 {percent}%</p>
                        <Slider
                          min={0}
                          max={50}
                          value={percent}
                          onChange={(percent) => this.setState({ percent })}
                        />
                        <span className="muted">当前区间试算可减少</span>
                        <strong>¥ {Money.format(plan.reduction)}</strong>
                        <p className="muted">
                          先选择你愿意调整的分类。试算基于当前区间，不自动设置预算或改动账目。
                        </p>
                      </Card>
                    </div>
                  ),
                },
                {
                  key: "merchants",
                  label: "交易方与频次",
                  children: (
                    <Card title="向哪些交易方反复付款？">
                      <PagedTable<Row>
                        rowKey="name"
                        dataSource={report.merchants}
                        defaultPageSize={10}
                        pageResetKey={JSON.stringify([
                          filters,
                          report?.excluded_account_ids,
                        ])}
                        columns={[
                          { title: "交易方", dataIndex: "name" },
                          {
                            title: "付款笔数",
                            dataIndex: "count",
                            sorter: (a, b) => a.count - b.count,
                            align: "right",
                          },
                          {
                            title: "付款天数",
                            dataIndex: "active_days",
                            align: "right",
                          },
                          {
                            title: "净支出（元）",
                            dataIndex: "amount",
                            align: "right",
                            sorter: (a, b) => a.amount - b.amount,
                            render: (v) => Money.format(v),
                          },
                          {
                            title: "平均每次（扣退款）",
                            dataIndex: "average",
                            align: "right",
                            render: (v) => Money.format(v),
                          },
                          {
                            title: "退款笔数",
                            dataIndex: "refund_count",
                            align: "right",
                          },
                        ]}
                      />
                    </Card>
                  ),
                },
                {
                  key: "large",
                  label: `大额付款（${report.large_count}）`,
                  children: (
                    <Card
                      title="哪些付款达到大额门槛？"
                      extra={
                        <Space>
                          <span>门槛（元）</span>
                          <InputNumber
                            min={0.01}
                            precision={2}
                            value={threshold ?? report.large_amount_minor / 100}
                            onChange={(v) => {
                              if (v) this.setState({ threshold: Number(v) });
                            }}
                          />
                          <Button onClick={() => this.load()}>应用</Button>
                          <Button
                            onClick={() =>
                              this.setState({ threshold: undefined }, () =>
                                this.load(),
                              )
                            }
                          >
                            恢复默认门槛
                          </Button>
                        </Space>
                      }
                    >
                      <p className="muted">
                        按单笔付款金额筛选；退款单独抵减家庭净支出。
                      </p>
                      {this.transactionTable(report.large_transactions)}
                    </Card>
                  ),
                },
                {
                  key: "details",
                  label: "全部开支与退款",
                  children: (
                    <Card title="这些开支和退款由哪些交易组成？">
                      <AnalysisDrilldownBar
                        elementRef={
                          this.state.activeTab === "details" && !detailPeriod
                            ? this.detailFocus.ref
                            : undefined
                        }
                        label="图表联动范围"
                        items={new AnalysisFilterSelection(filters, this.props)
                          .items()
                          .filter((item) =>
                            [
                              "group",
                              "category",
                              "direct-group",
                              "exact-category",
                            ].includes(item.key),
                          )
                          .map((item) => ({
                            key: item.key,
                            label: item.label,
                            onClear: () => this.filter(item.clear, "details"),
                          }))}
                        onReset={() => this.clearFlow()}
                        resetLabel="清除流向筛选"
                        emptyText="保留当前日期、账户与主筛选范围；点击图中节点或连线查看其开支和退款。"
                      />
                      {detailPeriod &&
                        this.state.activeTab === "details" &&
                        this.detailPeriodBar()}
                      {this.transactionTable(
                        this.periodTransactions(report),
                        detailPeriod,
                      )}
                    </Card>
                  ),
                },
              ].map((item) => ({
                ...item,
                children: (
                  <>
                    {item.children}
                    {detailPeriod &&
                      item.key === this.state.activeTab &&
                      item.key !== "details" &&
                      this.renderPeriodDetails(report)}
                  </>
                ),
              }))}
            />
            <details className="analysis-method">
              <summary>统计口径与读图说明</summary>
              <p className="muted balance-sheet-note">
                仅分析当前账户范围内已入账的开支，不含期初、内部转账和贷款本金转移。默认账户范围与大额门槛读取分析配置；纳入理财账户后，其投资亏损与费用也可纳入。普通账户继续沿用生活开支口径，不纳入投资盈亏分类。退款可唯一归属原用途时按原用途抵减，无法确定的拆分退款单列“退款抵减”；已按净额入账的部分退款不再次扣减。分类占比只以正额净支出分类作分母，退款净抵减不并入占比。上期比较和调整试算均按已有记录计算。
              </p>
            </details>
          </Spin>
        )}
      </div>
    );
  }
}
