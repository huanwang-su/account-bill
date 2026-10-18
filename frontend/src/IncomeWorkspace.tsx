import { ReportPeriodFilter } from "./ReportPeriodFilter";
import React from "react";
import {
  Button,
  Card,
  Empty,
  InputNumber,
  Select,
  Space,
  Spin,
  Tabs,
  TreeSelect,
  message,
} from "antd";
import dayjs from "dayjs";
import {
  AccountGroupTree,
  CategoryTree,
  LedgerApi,
  MoneyFormatter as Money,
  Row,
} from "./api";
import {
  AnalysisScopeNotice,
  AnalysisAccountSelection,
} from "./AnalysisAccountScope";
import { Chart } from "./Chart";
import { DistributionDiagram } from "./DistributionDiagram";
import { IncomeDistribution } from "./GroupedCategoryDistribution";
import { AnalysisFlowSelection } from "./AnalysisFlowSelection";
import { AnalysisDetailFocus } from "./AnalysisDetailFocus";
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

import { HouseholdAnalysisReadout as Readout } from "./HouseholdAnalysisReadout";

interface Props {
  accounts: Row[];
  groups: Row[];
  categories: Row[];
  refreshKey: string;
  onDetail: (row: Row) => void;
  onConfigure?: () => void;
}
interface State {
  filters: Row;
  grain: "day" | "month";
  level: number;
  threshold?: number;
  report?: Row;
  loading: boolean;
  activeTab: string;
  detailPeriod?: DetailPeriod;
  detailSource?: string;
  detailIncome?: { group_id: number };
}
export class IncomeWorkspace extends React.Component<Props, State> {
  api = new LedgerApi();
  requestVersion = 0;
  detailFocus = new AnalysisDetailFocus();
  state: State = {
    filters: this.defaultFilters(),
    grain: "day",
    level: 1,
    loading: true,
    activeTab: "details",
  };
  defaultFilters() {
    return ReportPeriodFilter.defaults();
  }
  componentDidMount() {
    this.load();
  }
  componentDidUpdate(previous: Props) {
    if (previous.refreshKey !== this.props.refreshKey) this.load();
  }
  componentWillUnmount() {
    this.requestVersion++;
    this.detailFocus.cancel();
  }
  async load(reveal = false) {
    if (!reveal) this.detailFocus.cancel();
    const version = ++this.requestVersion;
    this.setState({ loading: true });
    try {
      const report = await this.api.request(
        "/reports/income?" +
          this.api.query({
            ...this.state.filters,
            grain: this.state.grain,
            level: this.state.level,
            large_amount: this.state.threshold,
          }),
      );
      if (version === this.requestVersion)
        this.setState({ report, loading: false }, () =>
          this.detailFocus.afterRender(),
        );
    } catch (error) {
      if (version === this.requestVersion) {
        this.detailFocus.cancel();
        this.setState({ loading: false });
        message.error(
          error instanceof Error ? error.message : "收入分析加载失败",
        );
      }
    }
  }
  filter(patch: Row, showDetails = false) {
    if (showDetails) this.detailFocus.request();
    else this.detailFocus.cancel();
    this.setState(
      {
        filters: { ...this.state.filters, ...patch },
        detailPeriod: undefined,
        detailSource: undefined,
        detailIncome: undefined,
        activeTab: showDetails ? "details" : this.state.activeTab,
      },
      () => this.load(showDetails),
    );
  }
  selectFlow(selection: Row) {
    if (this.state.loading) return;
    if (selection.income_detail) {
      this.detailFocus.request();
      this.setState(
        {
          detailIncome: { group_id: selection.income_detail.group_id },
          detailPeriod: undefined,
          detailSource: undefined,
          activeTab: "details",
        },
        () => this.detailFocus.afterRender(),
      );
      return;
    }
    const filters = AnalysisFlowSelection.narrow(
      this.state.filters,
      selection,
      this.props.groups,
      this.props.categories,
    );
    if (JSON.stringify(filters) === JSON.stringify(this.state.filters)) {
      this.detailFocus.request();
      this.setState(
        {
          activeTab: "details",
          detailPeriod: undefined,
          detailSource: undefined,
          detailIncome: undefined,
        },
        () => this.detailFocus.afterRender(),
      );
    } else this.filter(filters, true);
  }
  clearLocal<K extends keyof State>(patch: Pick<State, K>) {
    this.detailFocus.cancel();
    this.setState(patch);
  }
  resetFlow() {
    this.filter(
      {
        group_id: undefined,
        direct_group: undefined,
        category_id: undefined,
        exact_category: undefined,
      },
      true,
    );
  }
  selectCategory(category_id: number) {
    if (Number.isInteger(category_id) && category_id > 0)
      this.filter(
        {
          category_id,
          exact_category: this.state.level === 2 ? true : undefined,
        },
        true,
      );
  }

  filterSummary() {
    return new AnalysisFilterSelection(this.state.filters, this.props)
      .items()
      .map((item) =>
        item.key === "exact-category"
          ? { ...item, label: "仅此分类（不含子分类）" }
          : item,
      );
  }
  flowItems() {
    return this.filterSummary()
      .filter((item) =>
        ["group", "category", "direct-group", "exact-category"].includes(
          item.key,
        ),
      )
      .map((item) => ({
        key: item.key,
        label: item.label,
        onClear: () => this.filter(item.clear, true),
      }));
  }
  sourceName(value: unknown) {
    const name =
      typeof value === "string"
        ? value.replace(
            /^[\p{White_Space}\u001c-\u001f]+|[\p{White_Space}\u001c-\u001f]+$/gu,
            "",
          )
        : "";
    return name || "未填写交易方";
  }
  sourceKey(value: unknown) {
    // Full case expansions keep source matching aligned with the report's
    // casefold grouping (for example Straße/STRASSE), while dotless i remains
    // distinct as it does in Unicode's default, locale-independent casefold.
    return Array.from(this.sourceName(value), (character) =>
      character === "\u0131"
        ? character
        : character.toUpperCase().toLowerCase().replace(/ß/g, "ss"),
    ).join("");
  }
  selectSource(value: string) {
    this.setState({
      detailSource: this.sourceName(value),
      activeTab: "details",
    });
  }
  selectPeriod(value: unknown) {
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
    )
      this.setState({ detailPeriod: period, activeTab: "details" });
  }
  detailPeriodBar(locate = false) {
    const { detailPeriod, detailSource, detailIncome } = this.state;
    const items = [];
    if (detailPeriod)
      items.push({
        key: "period",
        label: detailPeriod.label,
        onClear: () => this.clearLocal({ detailPeriod: undefined }),
      });
    if (detailSource)
      items.push({
        key: "source",
        label: `交易方：${detailSource}`,
        onClear: () => this.clearLocal({ detailSource: undefined }),
      });
    if (detailIncome)
      items.push({
        key: "uncategorized",
        label: `未分类收入 · ${new AccountGroupTree(this.props.groups).path(detailIncome.group_id) || "未分组"}`,
        onClear: () => this.clearLocal({ detailIncome: undefined }),
      });
    return (
      <AnalysisDrilldownBar
        label="明细范围"
        elementRef={locate ? this.detailFocus.ref : undefined}
        items={items}
        onReset={() =>
          this.clearLocal({
            detailPeriod: undefined,
            detailSource: undefined,
            detailIncome: undefined,
          })
        }
        resetLabel="返回统计区间"
        emptyText="趋势、交易方与未分类节点只定位下方收入明细；汇总保持当前统计范围。"
      />
    );
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
  transactionTable(rows: Row[]) {
    const detail =
      this.state.detailIncome &&
      IncomeDistribution.uncategorized(
        this.state.report || {},
        this.state.detailIncome.group_id,
      );
    const ids = detail ? new Set<number>(detail.transaction_ids) : undefined;
    return (
      <PagedTable<Row>
        rowKey="id"
        dataSource={rows.filter(
          (row) =>
            ReportDrilldown.contains(
              this.state.detailPeriod,
              row.occurred_at,
            ) &&
            (!ids || ids.has(row.id)) &&
            (!this.state.detailSource ||
              this.sourceKey(row.counterparty) ===
                this.sourceKey(this.state.detailSource)),
        )}
        defaultPageSize={10}
        pageResetKey={JSON.stringify([
          this.state.filters,
          this.state.report?.excluded_account_ids,
          this.state.threshold,
          this.state.detailPeriod,
          this.state.detailSource,
          this.state.detailIncome,
        ])}
        scroll={{ x: 800 }}
        columns={[
          {
            title: "时间",
            dataIndex: "occurred_at",
            width: 175,
            sorter: (a, b) => a.occurred_at.localeCompare(b.occurred_at),
          },
          {
            title: "交易方 / 描述",
            render: (_, r) => (
              <>
                <div className="cell-title">
                  {r.counterparty || "未填写交易方"}
                </div>
                <small className="muted">{r.note}</small>
              </>
            ),
          },
          {
            title: "分类 / 收款账户",
            render: (_, r) => (
              <>
                <div>{r.category_names.join("、")}</div>
                <small className="muted">{r.account_names.join("、")}</small>
              </>
            ),
          },
          {
            title: "收入（元）",
            align: "right",
            sorter: (a, b) => a.amount - b.amount,
            render: (_, r) => (
              <strong className="income">+{Money.format(r.amount)}</strong>
            ),
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
    );
  }
  render() {
    const { filters, report, loading, grain, level, threshold } = this.state;
    const graph = report
      ? new IncomeDistribution(report, this.props.groups)
      : undefined;
    return (
      <div className="income-workspace">
        <div className="analysis-intro">
          <p className="muted">查看家庭收入来源、收款账户与变化趋势。</p>
        </div>
        <AnalysisFilterPanel
          id="income-analysis-filters"
          label="收入分析"
          primary={
            <>
              <span className="analysis-filter-label">统计时间</span>
              <ReportPeriodFilter
                refreshKey={this.props.refreshKey}
                filters={filters}
                label="收入分析日期"
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
                  aria-label="收入分析账户组"
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
                <span>收款账户</span>
                <Select
                  allowClear
                  aria-label="收入分析账户"
                  placeholder="全部收款账户"
                  style={{ width: 210 }}
                  value={filters.account_id}
                  options={new AnalysisAccountSelection(this.props.accounts)
                    .choices()
                    .map((a) => ({ value: a.id, label: a.name }))}
                  onChange={(account_id) => this.filter({ account_id })}
                />
              </div>
              <div className="analysis-filter-field">
                <span>收入分类</span>
                <TreeSelect
                  allowClear
                  aria-label="收入分析分类"
                  placeholder="全部收入分类"
                  style={{ width: 210 }}
                  value={filters.category_id}
                  treeData={new CategoryTree(this.props.categories).options(
                    "INCOME",
                  )}
                  onChange={(category_id) =>
                    this.filter({ category_id, exact_category: undefined })
                  }
                />
              </div>
            </>
          }
          summary={this.filterSummary()}
          onClear={(patch) => this.filter(patch)}
          reset={
            <Button
              onClick={() =>
                this.setState(
                  {
                    filters: this.defaultFilters(),
                    threshold: undefined,
                    detailPeriod: undefined,
                    detailSource: undefined,
                    detailIncome: undefined,
                    activeTab: "details",
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
              <div className="metric featured">
                <span>收入总额</span>
                <strong>¥ {Money.format(report.income)}</strong>
                <small>{report.count} 笔已入账收入</small>
              </div>
              <div className="metric">
                <span>较上期</span>
                <strong>
                  {report.change > 0 ? "+" : ""}
                  {Money.format(report.change)}
                </strong>
                <small>
                  {report.change_ratio === null
                    ? "上期无收入，暂不计算涨幅"
                    : `${report.change_ratio > 0 ? "+" : ""}${(report.change_ratio * 100).toFixed(1)}%`}{" "}
                  · {report.previous_start} 至 {report.previous_end}
                </small>
              </div>
              <div className="metric">
                <span>平均每笔收入</span>
                <strong>¥ {Money.format(report.average)}</strong>
                <small>日均 ¥ {Money.format(report.average_daily)}</small>
              </div>
              <div className="metric">
                <span>大额收入</span>
                <strong>
                  {report.large_count} <small>笔</small>
                </strong>
                <small>合计 ¥ {Money.format(report.large_income)}</small>
              </div>
            </div>

            <Card
              title="收入通过哪些账户组、来自哪些分类？"
              className="mb balance-flow-card"
              extra={<strong>¥ {Money.format(report.income)}</strong>}
            >
              <p className="balance-flow-hint">
                收入总额 → 账户组 →
                收入分类。按实际收款账户归组；点击节点或连线只收窄当前筛选并显示明细，未分类收入直接定位对应原交易。
              </p>
              <AnalysisDrilldownBar
                label="流向筛选"
                items={this.flowItems()}
                onReset={() => this.resetFlow()}
                resetLabel="重置组与分类"
                emptyText="点击总额查看当前范围明细；重置按钮可清除组与分类，日期和收款账户条件继续生效。"
              />
              {graph!.nodes.length ? (
                <DistributionDiagram
                  data={graph!}
                  label="家庭收入桑基图"
                  columns={["收入总额", "账户组", "收入来源"]}
                  onSelect={(selection) => this.selectFlow(selection)}
                />
              ) : (
                <Empty description="当前筛选条件下暂无收入" />
              )}
            </Card>
            <Card
              title="收入在什么时候入账？（元）"
              className="mb"
              extra={
                <Select
                  aria-label="收入趋势粒度"
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
              {this.detailPeriodBar()}
              <Chart
                label="收入趋势曲线"
                onClick={(params) => this.selectPeriod(params.data?.period)}
                option={{
                  tooltip: { trigger: "axis", renderMode: "richText" },
                  grid: { left: 65, right: 25, top: 20, bottom: 40 },
                  xAxis: {
                    type: "category",
                    data: report.trend.map((r: Row) => r.period),
                  },
                  yAxis: { type: "value" },
                  series: [
                    {
                      name: "收入",
                      type: "line",
                      showSymbol: report.trend.length <= 31,
                      itemStyle: { color: "#326b53" },
                      areaStyle: { opacity: 0.06 },
                      data: report.trend.map((r: Row) => ({
                        value: r.income / 100,
                        period: r.period,
                      })),
                    },
                  ],
                }}
              />
            </Card>
            <div className="section-top analysis-category-title">
              <h2>收入构成与收款账户</h2>
              <Space>
                <Button
                  disabled={!filters.category_id}
                  onClick={() =>
                    this.filter(
                      { category_id: undefined, exact_category: undefined },
                      true,
                    )
                  }
                >
                  重置分类
                </Button>
                <Select
                  aria-label="收入分类层级"
                  value={level}
                  options={[
                    { value: 1, label: "按一级分类" },
                    { value: 2, label: "按二级分类" },
                  ]}
                  onChange={(level) =>
                    this.setState({ level }, () => this.load())
                  }
                />
              </Space>
            </div>
            <div className="analysis-category-grid mb">
              <Card
                title="哪类收入贡献最多？"
                extra={
                  <small className="muted">点击分类筛选全页及收入明细</small>
                }
              >
                {report.categories.length ? (
                  <Chart
                    label="收入分类占比"
                    option={{
                      tooltip: {
                        trigger: "item",
                        renderMode: "richText",
                        formatter: "{b}: ¥{c}（{d}%）",
                      },
                      legend: { type: "scroll", bottom: 0 },
                      series: [
                        {
                          type: "pie",
                          radius: ["42%", "68%"],
                          center: ["50%", "43%"],
                          label: { show: false },
                          data: report.categories
                            .filter((r: Row) => r.amount > 0)
                            .map((r: Row) => ({
                              id: r.id,
                              name: r.name,
                              value: r.amount / 100,
                            })),
                        },
                      ],
                    }}
                    onClick={(params) => {
                      this.selectCategory(params.data?.id);
                    }}
                  />
                ) : (
                  <Empty description="暂无收入分类" />
                )}
                <PagedTable<Row>
                  rowKey="id"
                  dataSource={report.categories}
                  defaultPageSize={5}
                  pageResetKey={JSON.stringify([
                    filters,
                    level,
                    report?.excluded_account_ids,
                  ])}
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
                      align: "right",
                      render: (value, row) =>
                        row.amount > 0
                          ? Readout.percentage(value, 1) || "—"
                          : "—",
                    },
                    { title: "笔数", dataIndex: "count", align: "right" },
                  ]}
                />
              </Card>
              <Card
                title="收入收到了哪些账户？"
                extra={
                  <Button
                    size="small"
                    disabled={filters.account_id === undefined}
                    onClick={() => this.filter({ account_id: undefined }, true)}
                  >
                    全部收款账户
                  </Button>
                }
              >
                <PagedTable<Row>
                  rowKey="id"
                  dataSource={report.accounts}
                  defaultPageSize={10}
                  pageResetKey={JSON.stringify([
                    filters,
                    report?.excluded_account_ids,
                  ])}
                  columns={[
                    {
                      title: "账户",
                      render: (_, r) => (
                        <Button
                          type="link"
                          size="small"
                          onClick={() =>
                            this.filter({ account_id: r.id }, true)
                          }
                        >
                          {r.name}
                        </Button>
                      ),
                    },
                    {
                      title: "收入（元）",
                      dataIndex: "amount",
                      align: "right",
                      sorter: (a, b) => a.amount - b.amount,
                      render: (value) => Money.format(value),
                    },
                    { title: "笔数", dataIndex: "count", align: "right" },
                  ]}
                />
              </Card>
            </div>
            <Tabs
              activeKey={this.state.activeTab}
              onChange={(activeTab) => this.setState({ activeTab })}
              items={[
                {
                  key: "details",
                  label: "全部收入",
                  children: (
                    <Card title="这些收入由哪些交易组成？">
                      {this.detailPeriodBar(true)}
                      {this.state.detailIncome &&
                        (() => {
                          const scope = IncomeDistribution.uncategorized(
                            report,
                            this.state.detailIncome.group_id,
                          );
                          const ids = new Set<number>(scope.transaction_ids);
                          const local = report.transactions.filter((row: Row) =>
                            ids.has(row.id),
                          );
                          return (
                            <p
                              className="analysis-detail-note"
                              aria-live="polite"
                            >
                              未分类收入明细：{local.length} 笔 · 图中该项 ¥{" "}
                              {Money.format(scope.amount)}；
                              {scope.exact
                                ? `对应交易金额 ¥ ${Money.format(local.reduce((sum: number, row: Row) => sum + row.amount, 0))}。`
                                : "旧报告未提供精确归属，以下保留相关未分类原交易整体，不猜分配金额。"}
                              本页收入汇总保持当前统计范围。
                            </p>
                          );
                        })()}
                      {this.transactionTable(report.transactions)}
                    </Card>
                  ),
                },
                {
                  key: "sources",
                  label: "收入交易方",
                  children: (
                    <Card
                      title="哪些交易方贡献了收入？"
                      extra={
                        <small className="muted">点击交易方筛选收入明细</small>
                      }
                    >
                      <PagedTable<Row>
                        rowKey="name"
                        dataSource={report.sources}
                        defaultPageSize={10}
                        pageResetKey={JSON.stringify([
                          filters,
                          report?.excluded_account_ids,
                        ])}
                        columns={[
                          {
                            title: "交易方",
                            render: (_, row) => (
                              <Button
                                type="link"
                                size="small"
                                onClick={() => this.selectSource(row.name)}
                              >
                                {row.name}
                              </Button>
                            ),
                          },
                          {
                            title: "收入（元）",
                            dataIndex: "amount",
                            align: "right",
                            sorter: (a, b) => a.amount - b.amount,
                            render: (value) => Money.format(value),
                          },
                          { title: "笔数", dataIndex: "count", align: "right" },
                        ]}
                      />
                    </Card>
                  ),
                },
                {
                  key: "large",
                  label: `大额收入（${report.large_count}）`,
                  children: (
                    <Card
                      title="哪些收入达到大额门槛？"
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
                      {this.detailPeriodBar()}
                      {this.transactionTable(report.large_transactions)}
                    </Card>
                  ),
                },
              ]}
            />
            <details className="analysis-method">
              <summary>统计口径与读图说明</summary>
              <p className="muted balance-sheet-note">
                仅统计有效已入账收入，期初余额、内部转账、贷款本金及撤销记录不计入。独立退款属于支出抵减；已按“退款收入”入账的记录计入收入。默认账户范围与大额门槛读取分析配置，纳入理财账户时可计入该账户的收益；转入证券的本金仍不属于收入。趋势日期和交易方联动只缩小交易明细，上方汇总指标使用当前整段统计范围。
              </p>
            </details>
          </Spin>
        )}
      </div>
    );
  }
}
