import React from "react";
import {
  Button,
  Card,
  DatePicker,
  Empty,
  InputNumber,
  Select,
  Space,
  Tag,
  TreeSelect,
  message,
} from "antd";
import dayjs from "dayjs";
import {
  LedgerApi,
  MoneyFormatter as Money,
  Row,
  CategoryTree,
  AccountGroupTree,
  TagTree,
} from "./api";
import { Chart } from "./Chart";
import { PagedTable } from "./PagedTable";

interface Props {
  accounts: Row[];
  groups: Row[];
  categories: Row[];
  tags: Row[];
  refreshKey: string;
  onDetail: (row: Row) => void;
}
interface State {
  filters: Row;
  grain: "day" | "month";
  level: number;
  threshold: number;
  largeKind?: string;
  report?: Row;
  loading: boolean;
}

export class FinancialAnalysisWorkspace extends React.Component<Props, State> {
  api = new LedgerApi();
  requestVersion = 0;
  state: State = {
    filters: {},
    grain: "day",
    level: 1,
    threshold: 1000,
    loading: true,
  };
  componentDidMount() {
    this.load();
  }
  componentDidUpdate(previous: Props) {
    if (previous.refreshKey !== this.props.refreshKey) this.load();
  }
  componentWillUnmount() {
    this.requestVersion++;
  }
  async load() {
    const version = ++this.requestVersion;
    this.setState({ loading: true });
    try {
      const report = await this.api.request(
        "/reports/analysis?" +
          this.api.query({
            ...this.state.filters,
            grain: this.state.grain,
            level: this.state.level,
            large_amount: this.state.threshold,
          }),
      );
      if (version === this.requestVersion)
        this.setState({ report, loading: false });
    } catch (error) {
      if (version === this.requestVersion) {
        this.setState({ loading: false, report: undefined });
        message.error(
          error instanceof Error ? error.message : "收支分析加载失败",
        );
      }
    }
  }
  setFilter(patch: Row) {
    this.setState({ filters: { ...this.state.filters, ...patch } }, () =>
      this.load(),
    );
  }
  renderCategories(side: "income" | "expense") {
    const rows: Row[] = this.state.report!.categories[side];
    const title = side === "income" ? "收入分类" : "支出分类";
    return (
      <Card
        title={title}
        extra={<small className="muted">点击分类查看明细分布</small>}
      >
        {rows.some((r) => r.amount > 0) ? (
          <Chart
            label={title + "占比饼图"}
            onClick={(params) => {
              if (params.data?.id)
                this.setFilter({ category_id: params.data.id });
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
                r.id ? (
                  <Button
                    type="link"
                    size="small"
                    onClick={() => this.setFilter({ category_id: r.id })}
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
                r.amount < 0 ? "—" : `${(value * 100).toFixed(1)}%`,
            },
            { title: "笔数", dataIndex: "count", width: 60, align: "right" },
          ]}
        />
      </Card>
    );
  }
  render() {
    const { filters, report, grain, level, threshold, largeKind } = this.state;
    const tree = new CategoryTree(this.props.categories);
    const largeRows: Row[] = (report?.large_transactions || []).filter(
      (r: Row) => !largeKind || r.direction === largeKind,
    );
    return (
      <div className="financial-analysis-workspace">
        <div className="analysis-intro">
          <h2>收支分析</h2>
          <p className="muted">
            观察收支趋势、分类占比和大额交易，找到主要的收入来源与支出去向。
          </p>
        </div>
        <div className="filters">
          <DatePicker.RangePicker
            aria-label="收支分析日期"
            value={
              filters.start && filters.end
                ? [dayjs(filters.start), dayjs(filters.end)]
                : null
            }
            onChange={(values) =>
              this.setFilter({
                start: values?.[0]?.format("YYYY-MM-DD"),
                end: values?.[1]?.format("YYYY-MM-DD"),
              })
            }
          />
          <Select
            aria-label="收支分析账户组"
            allowClear
            placeholder="全部账户组"
            style={{ width: 210 }}
            value={filters.group_id}
            options={new AccountGroupTree(this.props.groups).options()}
            onChange={(group_id) => this.setFilter({ group_id })}
          />
          <Select
            aria-label="收支分析账户"
            allowClear
            placeholder="全部资金账户"
            style={{ width: 190 }}
            value={filters.account_id}
            options={this.props.accounts
              .filter(
                (a) =>
                  !a.merged_into_id && ["ASSET", "LIABILITY"].includes(a.role),
              )
              .map((a) => ({ value: a.id, label: a.name }))}
            onChange={(account_id) => this.setFilter({ account_id })}
          />
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
            onChange={(category_id) => this.setFilter({ category_id })}
          />
          <TreeSelect
            aria-label="收支分析标签"
            allowClear
            placeholder="全部标签"
            style={{ width: 180 }}
            value={filters.tag}
            treeData={new TagTree(this.props.tags).options("TRANSACTION")}
            onChange={(tag) => this.setFilter({ tag })}
          />
          <Button
            onClick={() => this.setState({ filters: {} }, () => this.load())}
          >
            重置条件
          </Button>
        </div>
        <Space className="analysis-threshold-controls mb" wrap>
          <span>大额门槛</span>
          <InputNumber
            aria-label="大额交易门槛"
            prefix="¥"
            min={0}
            max={1000000000000}
            precision={2}
            value={threshold}
            style={{ width: 150 }}
            onChange={(value) => {
              if (value !== null) this.setState({ threshold: Number(value) });
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") this.load();
            }}
          />
          <Button
            aria-label="应用大额门槛"
            onClick={() => this.load()}
            loading={this.state.loading}
          >
            应用门槛
          </Button>
          <small className="muted">
            仅影响大额分析，当前门槛 ¥{" "}
            {Money.format(report?.large_amount_minor ?? 100000)}
          </small>
        </Space>
        {this.state.loading ? (
          <Card loading />
        ) : (
          report && (
            <>
              <div className="metrics analysis-metrics">
                <div className="metric">
                  <span>收入</span>
                  <strong className="income" data-testid="analysis-income">
                    ¥ {Money.format(report.income)}
                  </strong>
                  <small>{report.income_count} 笔收入</small>
                </div>
                <div className="metric">
                  <span>支出</span>
                  <strong data-testid="analysis-expense">
                    ¥ {Money.format(report.expense)}
                  </strong>
                  <small>{report.expense_count} 笔支出 · 已扣除退款冲减</small>
                </div>
                <div className="metric featured">
                  <span>净收支</span>
                  <strong data-testid="analysis-net">
                    ¥ {Money.format(report.net)}
                  </strong>
                  <small>收入 − 支出</small>
                </div>
                <div className="metric">
                  <span>大额交易</span>
                  <strong data-testid="analysis-large-count">
                    {report.large_count} <small>笔</small>
                  </strong>
                  <small>
                    占收支笔数 {(report.large_share * 100).toFixed(1)}%
                  </small>
                </div>
              </div>
              <Card
                className="mb analysis-trend"
                title="收支趋势"
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
                      this.setState({ grain }, () => this.load())
                    }
                  />
                }
              >
                {report.count ? (
                  <Chart
                    label="收入支出净收支趋势曲线"
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
                          data: report.trend.map((r: Row) => r.income / 100),
                        },
                        {
                          name: "支出",
                          type: "line",
                          showSymbol: report.trend.length <= 31,
                          symbolSize: 7,
                          itemStyle: { color: "#b78863" },
                          areaStyle: { opacity: 0.06 },
                          data: report.trend.map((r: Row) => r.expense / 100),
                        },
                        {
                          name: "净收支",
                          type: "line",
                          showSymbol: report.trend.length <= 31,
                          symbolSize: 7,
                          lineStyle: { type: "dashed" },
                          itemStyle: { color: "#275f49" },
                          data: report.trend.map((r: Row) => r.net / 100),
                        },
                      ],
                    }}
                  />
                ) : (
                  <Empty description="当前条件没有已入账的收支记录" />
                )}
              </Card>
              <div className="section-top analysis-category-title">
                <h2>分类分析</h2>
                <Select
                  aria-label="分析分类层级"
                  value={level}
                  style={{ width: 160 }}
                  options={[
                    { value: 1, label: "按一级分类" },
                    { value: 2, label: "按二级分类" },
                  ]}
                  onChange={(level) =>
                    this.setState({ level }, () => this.load())
                  }
                />
              </div>
              <div className="analysis-category-grid mb">
                {this.renderCategories("expense")}
                {this.renderCategories("income")}
              </div>
              <Card
                className="mb"
                title="大额分析"
                extra={
                  <Space wrap>
                    <Select
                      aria-label="大额交易类型"
                      allowClear
                      placeholder="全部收支"
                      value={largeKind}
                      style={{ width: 130 }}
                      options={[
                        { value: "EXPENSE", label: "支出" },
                        { value: "INCOME", label: "收入" },
                      ]}
                      onChange={(largeKind) => this.setState({ largeKind })}
                    />
                  </Space>
                }
              >
                <div className="analysis-large-summary">
                  <span>
                    共 <b>{largeRows.length}</b> 笔
                  </span>
                  <span>
                    大额收入 ¥{" "}
                    {Money.format(
                      largeRows
                        .filter((r) => r.kind === "INCOME")
                        .reduce((s, r) => s + r.amount, 0),
                    )}
                  </span>
                  <span>
                    大额支出 ¥{" "}
                    {Money.format(
                      largeRows
                        .filter((r) => r.kind !== "INCOME")
                        .reduce(
                          (s, r) =>
                            s + r.amount * (r.kind === "REFUND" ? -1 : 1),
                          0,
                        ),
                    )}
                  </span>
                </div>
                <div className="analysis-large-grid">
                  <div className="analysis-large-table">
                    <PagedTable<Row>
                      rowKey="id"
                      dataSource={largeRows}
                      defaultPageSize={10}
                      pageResetKey={JSON.stringify([
                        filters,
                        threshold,
                        largeKind,
                      ])}
                      scroll={{ x: 650 }}
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
                          title: "分类 / 账户",
                          width: 180,
                          render: (_, r) => (
                            <>
                              <div>{r.category_names.join("、")}</div>
                              <small className="muted">
                                {r.account_names.join(" → ")}
                              </small>
                            </>
                          ),
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
                  </div>
                  <div className="analysis-large-rank">
                    <h3>金额排名 · 前 10 笔</h3>
                    {largeRows.length ? (
                      <Chart
                        label="大额交易金额排名"
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
                                (r, i) =>
                                  `${i + 1}. ${r.counterparty || r.category_names[0]}`,
                              ),
                          },
                          series: [
                            {
                              type: "bar",
                              barMaxWidth: 18,
                              itemStyle: {
                                color: "#73a58f",
                                borderRadius: [0, 4, 4, 0],
                              },
                              data: largeRows
                                .slice(0, 10)
                                .map((r) => r.amount / 100),
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
              <p className="muted analysis-note">
                仅统计有效的已入账收支，内部转账、期初余额及已撤销交易不计入；部分退款按净支出金额分析。选择父分类包含全部子分类，拆分交易按匹配部分统计。大额门槛仅影响大额分析。
              </p>
            </>
          )
        )}
      </div>
    );
  }
}
