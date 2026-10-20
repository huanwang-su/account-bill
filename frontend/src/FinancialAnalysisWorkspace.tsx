import { TransactionSemantics } from "./TransactionSemantics";
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
  Space,
  Spin,
  Tabs,
  Tag,
  TreeSelect,
  message,
} from "antd";
import {
  LedgerApi,
  DisplayMoneyFormatter as Money,
  Row,
  CategoryTree,
  AccountGroupTree,
  TagTree,
} from "./api";
import { Chart } from "./Chart";
import { PagedTable } from "./PagedTable";
import {
  AnalysisFilterPanel,
  AnalysisFilterSelection,
} from "./AnalysisFilterPanel";
import {
  AnalysisDrilldownBar,
  ReportDrilldown,
  type DetailPeriod,
} from "./AnalysisDrilldown";

import { AccountMovementSection } from "./AccountMovementSection";
import { ScopeFundFlowSection } from "./ScopeFundFlowSection";
import { ReportAccountFilters } from "./ReportAccountFilters";
import { AnalysisDetailFocus } from "./AnalysisDetailFocus";
import { ReportMetrics as Readout } from "./ReportMetrics";

interface Props {
  accounts: Row[];
  groups: Row[];
  categories: Row[];
  tags: Row[];
  refreshKey: string;
  onDetail: (row: Row) => void;
}
type FinancialAnalysisTab =
  "overview" | "funds" | "movements" | "categories" | "large" | "details";
interface State {
  filters: Row;
  grain: "day" | "month";
  level: number;
  threshold?: number;
  expenseThreshold?: number;
  largeKind?: string;
  report?: Row;
  loading: boolean;
  detailPeriod?: DetailPeriod;
  activeTab: FinancialAnalysisTab;
}

export class FinancialAnalysisWorkspace extends React.Component<Props, State> {
  api = new LedgerApi();
  detailFocus = new AnalysisDetailFocus();
  fundFlowRef = React.createRef<ScopeFundFlowSection>();
  movementRef = React.createRef<AccountMovementSection>();
  loader = new LatestRequest(this.api);
  state: State = {
    filters: ReportPeriodFilter.defaults(),
    grain: "day",
    level: 1,
    loading: true,
    activeTab: "overview",
  };
  componentDidMount() {
    this.load();
  }
  componentDidUpdate(previous: Props) {
    if (previous.refreshKey !== this.props.refreshKey) this.load();
  }
  componentWillUnmount() {
    this.loader.dispose();
    this.cancelDetailReveal();
  }
  cancelDetailReveal() {
    this.detailFocus.cancel();
    this.fundFlowRef.current?.detailFocus.cancel();
    this.movementRef.current?.detailFocus.cancel();
  }
  changeTab(activeTab: FinancialAnalysisTab) {
    this.cancelDetailReveal();
    this.setState({ activeTab });
  }
  async load(reveal = false) {
    if (!reveal) this.cancelDetailReveal();
    const version = this.loader.begin();
    this.setState({ loading: true });
    try {
      const report = await this.api.request(
        "/reports/analysis?" +
          this.api.query({
            ...ReportAccountFilters.query(this.state.filters),
            grain: this.state.grain,
            level: this.state.level,
            large_income_amount: this.state.threshold,
            large_expense_amount: this.state.expenseThreshold,
          }),
      );
      if (this.loader.current(version))
        this.setState({ report, loading: false }, () => {
          if (reveal) this.detailFocus.afterRender();
        });
    } catch (error) {
      if (this.loader.current(version)) {
        this.detailFocus.cancel();
        this.setState({ loading: false });
        message.error(
          error instanceof Error ? error.message : "收支分析加载失败",
        );
      }
    }
  }
  setFilter(patch: Row) {
    this.cancelDetailReveal();
    this.setState(
      { filters: { ...this.state.filters, ...patch }, detailPeriod: undefined },
      () => this.load(),
    );
  }
  selectCategory(category_id: number) {
    if (
      this.state.loading ||
      !Number.isInteger(category_id) ||
      category_id <= 0
    )
      return;
    this.cancelDetailReveal();
    this.detailFocus.request();
    this.setState(
      {
        activeTab: "categories",
        filters: {
          ...this.state.filters,
          category_id,
          exact_category: this.state.level === 2 ? true : undefined,
        },
        detailPeriod: undefined,
      },
      () => this.load(true),
    );
  }
  resetFilters() {
    this.cancelDetailReveal();
    this.setState(
      {
        filters: ReportPeriodFilter.defaults(),
        detailPeriod: undefined,
        threshold: undefined,
        expenseThreshold: undefined,
      },
      () => this.load(),
    );
  }
  resetCategory() {
    this.setFilter({ category_id: undefined, exact_category: undefined });
  }

  selectPeriod(value: unknown) {
    if (this.state.loading) return;
    const period = ReportDrilldown.period(
      value,
      this.state.grain,
      this.state.filters,
    );
    if (
      period &&
      this.state.report?.transactions.some((row: Row) =>
        ReportDrilldown.contains(period, row.occurred_at),
      )
    ) {
      this.cancelDetailReveal();
      this.detailFocus.request();
      this.setState({ activeTab: "overview", detailPeriod: period }, () =>
        this.detailFocus.afterRender(),
      );
    }
  }
  clearPeriod() {
    this.detailFocus.cancel();
    this.setState({ detailPeriod: undefined });
  }
  selectLargeTransaction(id: unknown) {
    if (this.state.loading || !Number.isInteger(id) || Number(id) <= 0) return;
    const row = (this.state.report?.large_transactions || [])
      .filter(
        (item: Row) => item.direction === (this.state.largeKind || "EXPENSE"),
      )
      .slice(0, 10)
      .find((item: Row) => item.id === id);
    if (row) this.props.onDetail(row);
  }
  detailPeriodBar() {
    const { detailPeriod } = this.state;
    return (
      <AnalysisDrilldownBar
        elementRef={
          this.state.activeTab === "overview" ? this.detailFocus.ref : undefined
        }
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
        emptyText="点击有交易的趋势点缩小下方明细日期，统计图保持原区间。"
      />
    );
  }
  categoryDetailBar() {
    const { filters } = this.state;
    return (
      <AnalysisDrilldownBar
        elementRef={
          this.state.activeTab === "categories"
            ? this.detailFocus.ref
            : undefined
        }
        label="分类联动范围"
        items={
          filters.category_id
            ? [
                {
                  key: "category",
                  label:
                    new CategoryTree(this.props.categories).path(
                      filters.category_id,
                    ) || `分类 #${filters.category_id}`,
                  onClear: () => this.resetCategory(),
                },
              ]
            : []
        }
        onReset={() => this.resetCategory()}
        resetLabel="返回全部分类"
        emptyText="显示当前账户范围内的收支交易。"
      />
    );
  }
  fundingAccounts(row: Row): Row[] {
    const funding: Row[] = (row.entries || []).filter((entry: Row) =>
      ["ASSET", "LIABILITY"].includes(entry.role),
    );
    const accounts = new Map<string, Row>();
    if (funding.length) {
      const sign = row.kind === "EXPENSE" ? -1 : 1;
      for (const entry of funding) {
        if (!(entry.amount * sign > 0) || !entry.account) continue;
        accounts.set(String(entry.account_id ?? entry.account), {
          id: entry.account_id,
          name: entry.account,
        });
      }
    } else if (!row.entries?.length) {
      for (const name of row.account_names || []) accounts.set(name, { name });
    }
    return [...accounts.values()];
  }
  transactionTable(rows: Row[], pageResetKey: string) {
    return (
      <PagedTable<Row>
        rowKey="id"
        dataSource={rows}
        defaultPageSize={10}
        pageResetKey={pageResetKey}
        scroll={{ x: 850 }}
        size="middle"
        columns={[
          {
            title: "时间 / 对方",
            width: 180,
            render: (_, r) => (
              <>
                <div className="cell-title">
                  {r.counterparty || r.category_names.join(" / ")}
                </div>
                <small className="muted">{r.occurred_at}</small>
              </>
            ),
          },
          {
            title: "付款账户 / 收款账户",
            width: 220,
            render: (_, r) => {
              const accounts = this.fundingAccounts(r);
              return (
                <div className="analysis-account-cell">
                  {accounts.length ? (
                    accounts.map((account) => (
                      <div
                        className="cell-title"
                        key={account.id ?? account.name}
                      >
                        {account.name}
                      </div>
                    ))
                  ) : (
                    <span className="muted">未记录账户</span>
                  )}
                  <small className="muted">
                    {TransactionSemantics.isValuation(r)
                      ? "估值记账账户"
                      : r.kind === "REFUND"
                        ? "退款到账"
                        : r.kind === "INCOME"
                          ? "收入到账"
                          : "实际付款"}
                  </small>
                </div>
              );
            },
          },
          {
            title: "分类",
            width: 150,
            render: (_, r) => <div>{r.category_names.join("、")}</div>,
          },
          {
            title: "金额（元）",
            width: 130,
            align: "right",
            sorter: (a, b) => a.amount - b.amount,
            render: (_, r) => (
              <>
                <strong>
                  {r.kind === "EXPENSE" ? "−" : "+"}
                  {Money.format(r.amount)}
                </strong>
                <div>
                  <Tag>
                    {r.kind === "INCOME"
                      ? "收入"
                      : r.kind === "REFUND"
                        ? "退款冲减"
                        : "支出"}
                  </Tag>
                </div>
              </>
            ),
          },
          {
            title: "操作",
            width: 75,
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
    );
  }
  renderCategories(side: "income" | "expense") {
    const rows: Row[] = this.state.report!.categories[side];
    const title = side === "income" ? "收入分类" : "支出分类";
    return (
      <Card
        title={
          side === "income" ? "收入主要来自哪类？" : "正额支出主要花在哪类？"
        }
        extra={<small className="muted">点击分类筛选收支统计及交易明细</small>}
      >
        {rows.some((r) => r.amount > 0) ? (
          <Chart
            label={title + "占比饼图"}
            onClick={(params) => {
              this.selectCategory(params.data?.id);
            }}
            option={{
              color:
                side === "income"
                  ? [
                      "#2d6452",
                      "#73a58f",
                      "#a3c4ad",
                      "#a8b0cc",
                      "#d1bf94",
                      "#c4947f",
                    ]
                  : [
                      "#b78863",
                      "#d4b48c",
                      "#7d9c8d",
                      "#a8b0cc",
                      "#c9cc95",
                      "#b8837a",
                    ],
              tooltip: {
                trigger: "item",
                renderMode: "richText",
                formatter: "{b}: ¥{c}（{d}%）",
              },
              legend: { type: "scroll", bottom: 0 },
              series: [
                {
                  name: title,
                  type: "pie",
                  radius: ["45%", "68%"],
                  center: ["50%", "43%"],
                  label: { show: false },
                  emphasis: { label: { show: true, formatter: "{b}\n{d}%" } },
                  data: rows
                    .filter((r) => r.amount > 0)
                    .map((r) => ({
                      id: r.id,
                      name: r.name,
                      value: r.amount / 100,
                    })),
                },
              ],
            }}
          />
        ) : (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={`当前条件没有正向${side === "income" ? "收入" : "支出"}`}
          />
        )}
        {rows.some((r) => r.amount < 0) && (
          <p className="muted">
            负额分类属于退款等冲减，金额在下表列出，不计入饼图占比。
          </p>
        )}
        <PagedTable<Row>
          rowKey="id"
          dataSource={rows}
          defaultPageSize={5}
          pageResetKey={JSON.stringify([this.state.filters, this.state.level])}
          size="small"
          columns={[
            {
              title: "分类",
              render: (_, r) =>
                r.id > 0 ? (
                  <Button
                    type="link"
                    size="small"
                    onClick={() => this.selectCategory(r.id)}
                  >
                    {r.name}
                  </Button>
                ) : (
                  r.name
                ),
            },
            {
              title: "金额（元）",
              dataIndex: "amount",
              align: "right",
              sorter: (a, b) => a.amount - b.amount,
              render: (value) => Money.format(value),
            },
            {
              title: "占比",
              dataIndex: "share",
              width: 70,
              align: "right",
              render: (value, r) =>
                r.amount > 0 ? Readout.percentage(value, 1) || "—" : "—",
            },
            { title: "笔数", dataIndex: "count", width: 60, align: "right" },
          ]}
        />
      </Card>
    );
  }
  renderMetrics(report: Row) {
    return (
      <div className="metrics analysis-metrics">
        <MetricCard
          className="metric"
          data-tone={Tone.of(report.income, "income")}
        >
          <span>收入</span>
          <strong className="income" data-testid="analysis-income">
            ¥ {Money.format(report.income)}
          </strong>
          <small>{report.income_count} 笔收入</small>
        </MetricCard>
        <MetricCard
          className="metric"
          data-tone={Tone.of(report.expense, "expense")}
        >
          <span>支出</span>
          <strong data-testid="analysis-expense">
            ¥ {Money.format(report.expense)}
          </strong>
          <small>{report.expense_count} 笔支出 · 已扣除退款冲减</small>
        </MetricCard>
        <MetricCard
          className="metric featured"
          data-tone={Tone.of(report.net, "net")}
        >
          <span>净收支</span>
          <strong data-testid="analysis-net">
            ¥ {Money.format(report.net)}
          </strong>
          <small>收入 − 支出</small>
        </MetricCard>
        <MetricCard className="metric">
          <span>大额交易</span>
          <strong data-testid="analysis-large-count">
            {report.large_count} <small>笔</small>
          </strong>
          <small>
            占收支及退款笔数{" "}
            {Readout.percentage(report.large_count, report.count) || "—"}
          </small>
        </MetricCard>
      </div>
    );
  }
  renderOverview(report: Row) {
    const { grain } = this.state;
    return (
      <>
        <Card
          className="mb analysis-trend"
          title="收入与支出在何时发生？"
          extra={
            <Select
              aria-label="收支趋势粒度"
              value={grain}
              style={{ width: 120 }}
              options={[
                { value: "day", label: "按日" },
                { value: "month", label: "按月" },
              ]}
              onChange={(grain) =>
                this.setState({ grain, detailPeriod: undefined }, () =>
                  this.load(),
                )
              }
            />
          }
        >
          {report.count ? (
            <Chart
              label="收入支出净收支趋势曲线"
              onClick={(params) => this.selectPeriod(params.data?.period)}
              option={{
                tooltip: { trigger: "axis", renderMode: "richText" },
                legend: { bottom: 0 },
                grid: { left: 65, right: 25, top: 25, bottom: 65 },
                xAxis: {
                  type: "category",
                  boundaryGap: false,
                  data: report.trend.map((r: Row) => r.period),
                },
                yAxis: {
                  type: "value",
                  name: "元",
                  splitLine: { lineStyle: { color: "#edf0ee" } },
                },
                series: [
                  {
                    name: "收入",
                    type: "line",
                    showSymbol: report.trend.length <= 31,
                    symbolSize: 7,
                    itemStyle: { color: "#73a58f" },
                    areaStyle: { opacity: 0.06 },
                    data: report.trend.map((r: Row) => ({
                      value: r.income / 100,
                      period: r.period,
                    })),
                  },
                  {
                    name: "支出",
                    type: "line",
                    showSymbol: report.trend.length <= 31,
                    symbolSize: 7,
                    itemStyle: { color: "#b78863" },
                    areaStyle: { opacity: 0.06 },
                    data: report.trend.map((r: Row) => ({
                      value: r.expense / 100,
                      period: r.period,
                    })),
                  },
                  {
                    name: "净收支",
                    type: "line",
                    showSymbol: report.trend.length <= 31,
                    symbolSize: 7,
                    lineStyle: { type: "dashed" },
                    itemStyle: { color: "#275f49" },
                    data: report.trend.map((r: Row) => ({
                      value: r.net / 100,
                      period: r.period,
                    })),
                  },
                ],
              }}
            />
          ) : (
            <Empty description="当前条件没有已入账的收支记录" />
          )}
        </Card>
        {this.state.detailPeriod && this.renderDetails(report, "overview")}
      </>
    );
  }
  renderCategoryAnalysis(report: Row) {
    const { filters, level } = this.state;
    const tree = new CategoryTree(this.props.categories);
    return (
      <>
        <div className="section-top analysis-category-title">
          <h2>收入来源与支出去向</h2>
          <Space>
            <Select
              aria-label="分析分类层级"
              value={level}
              style={{ width: 160 }}
              options={[
                { value: 1, label: "按一级分类" },
                { value: 2, label: "按二级分类" },
              ]}
              onChange={(level) => this.setState({ level }, () => this.load())}
            />
          </Space>
        </div>
        <AnalysisDrilldownBar
          label="收支分类筛选"
          items={
            filters.category_id
              ? [
                  {
                    key: "category",
                    label:
                      (tree.path(filters.category_id) ||
                        `分类 #${filters.category_id}`) +
                      (filters.exact_category ? "（仅此分类）" : ""),
                    onClear: () => this.resetCategory(),
                  },
                ]
              : []
          }
          onReset={() => this.resetCategory()}
          resetLabel="返回全部分类"
          emptyText="点击饼图或分类名称筛选收支统计及交易明细，账户余额变动保持完整区间。"
        />
        <div className="analysis-category-grid mb">
          {this.renderCategories("expense")}
          {this.renderCategories("income")}
        </div>
        {filters.category_id && this.renderDetails(report, "categories")}
      </>
    );
  }
  renderLargeAnalysis(report: Row) {
    const kind = this.state.largeKind || "EXPENSE";
    const income = kind === "INCOME";
    const label = income ? "大额收入" : "大额支出";
    const threshold = income
      ? this.state.threshold
      : this.state.expenseThreshold;
    const applied = income
      ? report.large_income_amount_minor
      : report.large_expense_amount_minor;
    const largeRows: Row[] = (report.large_transactions || []).filter(
      (row: Row) => row.direction === kind,
    );
    const total = largeRows.reduce(
      (sum, row) => sum + row.amount * (row.kind === "REFUND" ? -1 : 1),
      0,
    );
    return (
      <>
        <Tabs
          aria-label="大额分析收支方向"
          activeKey={kind}
          items={[
            { key: "INCOME", label: "大额收入" },
            { key: "EXPENSE", label: "大额支出" },
          ]}
          onChange={(largeKind) => this.setState({ largeKind })}
        />
        <Card
          className="mb"
          title={`${label} · ${income ? "收款" : "付款与退款"}单独分析`}
        >
          <Space className="analysis-threshold-controls mb" wrap>
            <span>{label}门槛</span>
            <InputNumber
              aria-label="大额交易门槛"
              prefix="¥"
              min={0.01}
              max={1000000000000}
              precision={2}
              value={threshold ?? (applied ?? report.large_amount_minor) / 100}
              style={{ width: 150 }}
              onChange={(value) =>
                value !== null &&
                this.setState(
                  income
                    ? { threshold: Number(value) }
                    : { expenseThreshold: Number(value) },
                )
              }
              onKeyDown={(event) => {
                if (event.key === "Enter") this.load();
              }}
            />
            <Button
              aria-label="应用大额门槛"
              loading={this.state.loading}
              onClick={() => this.load()}
            >
              应用门槛
            </Button>
            <Button
              onClick={() =>
                this.setState(
                  income
                    ? { threshold: undefined }
                    : { expenseThreshold: undefined },
                  () => this.load(),
                )
              }
            >
              恢复默认门槛
            </Button>
            <small className="muted">
              默认值在“设置 → 分析配置”统一管理；此处仅临时修改
              {income ? "收入" : "支出"}门槛。
            </small>
          </Space>
          <div className="analysis-large-summary">
            <span>
              共 <b>{largeRows.length}</b> 笔
            </span>
            <span>
              {income ? "大额收入" : "大额净支出"} ¥ {Money.format(total)}
            </span>
            {!income && (
              <span>
                含退款 {largeRows.filter((row) => row.kind === "REFUND").length}{" "}
                笔，按负额抵减
              </span>
            )}
          </div>
          <div className="analysis-large-grid">
            <div className="analysis-large-table">
              {this.transactionTable(
                largeRows,
                JSON.stringify([this.state.filters, applied, kind]),
              )}
            </div>
            <div className="analysis-large-rank">
              <h3>金额排名 · 前 10 笔</h3>
              <p className="muted">
                点击条形查看对应单笔交易。{!income && "退款以负值展示。"}
              </p>
              {largeRows.length ? (
                <Chart
                  label="大额交易金额排名"
                  onClick={(params) => {
                    if (
                      report === this.state.report &&
                      kind === (this.state.largeKind || "EXPENSE")
                    )
                      this.selectLargeTransaction(params.data?.id);
                  }}
                  option={{
                    tooltip: { trigger: "axis", renderMode: "richText" },
                    grid: { left: 110, right: 20, top: 15, bottom: 35 },
                    xAxis: { type: "value", name: "元" },
                    yAxis: {
                      type: "category",
                      inverse: true,
                      axisLabel: { width: 100, overflow: "truncate" },
                      data: largeRows
                        .slice(0, 10)
                        .map(
                          (row, index) =>
                            `${index + 1}. ${row.counterparty || row.category_names[0]}`,
                        ),
                    },
                    series: [
                      {
                        type: "bar",
                        barMaxWidth: 18,
                        itemStyle: {
                          color: income ? "#73a58f" : "#b78863",
                          borderRadius: [0, 4, 4, 0],
                        },
                        data: largeRows.slice(0, 10).map((row) => ({
                          id: row.id,
                          value:
                            (row.amount * (row.kind === "REFUND" ? -1 : 1)) /
                            100,
                        })),
                      },
                    ],
                  }}
                />
              ) : (
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description="没有达到门槛的交易"
                />
              )}
            </div>
          </div>
        </Card>
      </>
    );
  }
  renderDetails(
    report: Row,
    context: "overview" | "categories" | "details" = "details",
  ) {
    const period = context === "overview" ? this.state.detailPeriod : undefined;
    const rows = report.transactions.filter((row: Row) =>
      ReportDrilldown.contains(period, row.occurred_at),
    );
    const title =
      context === "overview"
        ? "趋势联动明细"
        : context === "categories"
          ? "分类联动明细"
          : "收支明细";
    return (
      <Card title={title} className="mb analysis-linked-details">
        {context === "overview"
          ? this.detailPeriodBar()
          : context === "categories"
            ? this.categoryDetailBar()
            : null}
        <p className="muted analysis-detail-note">
          {context === "overview"
            ? "仅缩小本表日期，统计总额与趋势保持原区间。"
            : context === "categories"
              ? "显示当前分类及账户范围内的交易，可在本页重置分类。"
              : "显示顶部日期、账户、分类与标签条件下的完整收支，不受趋势点选影响。"}
          付款／收款账户按整笔交易的实际资金账户展示。
        </p>
        {this.transactionTable(
          rows,
          JSON.stringify([this.state.filters, context, period]),
        )}
      </Card>
    );
  }
  renderMethod() {
    return (
      <details className="analysis-method">
        <summary>统计口径与读图说明</summary>
        <p className="muted analysis-note">
          仅统计有效的已入账收支，内部转账、期初余额及已撤销交易不计入；部分退款按净支出金额分析。选择父分类包含全部子分类，拆分交易按匹配部分统计。大额门槛仅影响大额分析。分类图只显示正额，负额退款抵减在表格中保留；大额金额占比按收款、付款与退款的单笔金额相加计算。趋势日期点选只缩小明细范围，上方汇总指标使用当前整段统计范围。
        </p>
      </details>
    );
  }
  render() {
    const { filters, report } = this.state;
    const tree = new CategoryTree(this.props.categories);
    return (
      <div className="financial-analysis-workspace">
        <div className="analysis-intro">
          <p className="muted">
            按问题切换分析视图，日期与账户条件在各页签间共用。
          </p>
        </div>
        <AnalysisFilterPanel
          id="financial-analysis-filters"
          label="收支分析"
          primary={
            <>
              <span className="analysis-filter-label">统计时间</span>
              <ReportPeriodFilter
                refreshKey={this.props.refreshKey}
                filters={filters}
                label="收支分析日期"
                onChange={(patch) => this.setFilter(patch)}
              />
            </>
          }
          advanced={
            <>
              <div className="analysis-filter-field">
                <span>账户组</span>
                <Select
                  aria-label="收支分析账户组"
                  allowClear
                  placeholder="全部账户组"
                  style={{ width: 210 }}
                  value={filters.group_id}
                  options={new AccountGroupTree(this.props.groups).options()}
                  onChange={(group_id) => this.setFilter({ group_id })}
                />
              </div>
              <div className="analysis-filter-field">
                <span>资金账户</span>
                <Select
                  aria-label="收支分析账户"
                  allowClear
                  placeholder="全部资金账户"
                  style={{ width: 190 }}
                  value={filters.account_id}
                  options={AccountChoices.rank(this.props.accounts)
                    .filter(
                      (a) =>
                        !a.merged_into_id &&
                        ["ASSET", "LIABILITY"].includes(a.role),
                    )
                    .map((a) => ({ value: a.id, label: a.name }))}
                  onChange={(account_id) => this.setFilter({ account_id })}
                />
              </div>
              <div className="analysis-filter-field">
                <span>分类</span>
                <TreeSelect
                  aria-label="收支分析分类"
                  allowClear
                  placeholder="全部分类（含子分类）"
                  style={{ width: 220 }}
                  value={filters.category_id}
                  treeDefaultExpandAll
                  treeData={[
                    {
                      title: "支出",
                      value: "expense-heading",
                      selectable: false,
                      children: tree.options("EXPENSE"),
                    },
                    {
                      title: "收入",
                      value: "income-heading",
                      selectable: false,
                      children: tree.options("INCOME"),
                    },
                  ]}
                  onChange={(category_id) =>
                    this.setFilter({ category_id, exact_category: undefined })
                  }
                />
              </div>
              <div className="analysis-filter-field">
                <span>标签</span>
                <TreeSelect
                  aria-label="收支分析标签"
                  allowClear
                  placeholder="全部标签"
                  style={{ width: 180 }}
                  value={filters.tag}
                  treeData={new TagTree(this.props.tags).options("TRANSACTION")}
                  onChange={(tag) => this.setFilter({ tag })}
                />
              </div>
            </>
          }
          summary={new AnalysisFilterSelection(filters, this.props)
            .items()
            .map((item) =>
              item.key === "exact-category"
                ? { ...item, label: "仅此分类（不含子分类）" }
                : item,
            )}
          onClear={(patch) => this.setFilter(patch)}
          reset={<Button onClick={() => this.resetFilters()}>重置条件</Button>}
        />
        <ReportAccountFilters
          accounts={this.props.accounts}
          filters={filters}
          defaults={report?.account_scope}
          disabled={this.state.loading}
          onChange={(patch) => this.setFilter(patch)}
        />
        {this.state.loading && !report ? (
          <Card loading />
        ) : (
          report && (
            <Spin spinning={this.state.loading} tip="正在更新分析…">
              {this.renderMetrics(report)}
              <Tabs
                className="report-tabs financial-analysis-tabs"
                activeKey={this.state.activeTab}
                onChange={(key) => this.changeTab(key as FinancialAnalysisTab)}
                items={[
                  {
                    key: "overview",
                    label: "收支概览",
                    children: this.renderOverview(report),
                  },
                  {
                    key: "funds",
                    label: "资金进出",
                    children: (
                      <ScopeFundFlowSection
                        ref={this.fundFlowRef}
                        filters={filters}
                        refreshKey={this.props.refreshKey}
                        onDetail={this.props.onDetail}
                      />
                    ),
                  },
                  {
                    key: "movements",
                    label: "账户变动",
                    children: report.account_movements ? (
                      <AccountMovementSection
                        ref={this.movementRef}
                        report={report.account_movements}
                        groups={this.props.groups}
                      />
                    ) : (
                      <Empty description="当前没有账户期间变动数据" />
                    ),
                  },
                  {
                    key: "categories",
                    label: "分类分析",
                    children: this.renderCategoryAnalysis(report),
                  },
                  {
                    key: "large",
                    label: "大额分析",
                    children: this.renderLargeAnalysis(report),
                  },
                  {
                    key: "details",
                    label: "收支明细",
                    children: this.renderDetails(report),
                  },
                ]}
              />
              {this.renderMethod()}
            </Spin>
          )
        )}
      </div>
    );
  }
}
