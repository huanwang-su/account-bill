import React from "react";
import {
  Alert,
  Button,
  Card,
  DatePicker,
  Descriptions,
  Empty,
  Select,
  Space,
  Spin,
  Tabs,
  Tag,
  message,
} from "antd";
import dayjs from "dayjs";
import { LedgerApi, MoneyFormatter as Money, Row } from "./api";
import { Chart } from "./Chart";
import { PagedTable } from "./PagedTable";

interface Props {
  accounts: Row[];
  refreshKey: string;
  onDetail: (row: Row) => void;
  onUpdate: (account: Row) => void;
  onAccounts: () => void;
}
interface State {
  filters: Row;
  grain: "day" | "month";
  report?: Row;
  loading: boolean;
}

export class InvestmentWorkspace extends React.Component<Props, State> {
  api = new LedgerApi();
  requestVersion = 0;
  state: State = { filters: {}, grain: "month", loading: true };
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
        "/reports/investments?" +
          this.api.query({ ...this.state.filters, grain: this.state.grain }),
      );
      if (version === this.requestVersion)
        this.setState({ report, loading: false });
    } catch (error) {
      if (version === this.requestVersion) {
        this.setState({ loading: false });
        message.error(
          error instanceof Error ? error.message : "理财收益分析加载失败",
        );
      }
    }
  }
  filter(patch: Row) {
    this.setState({ filters: { ...this.state.filters, ...patch } }, () =>
      this.load(),
    );
  }
  async detail(id: number) {
    try {
      const row = await this.api.transaction(id);
      if (row) this.props.onDetail(row);
    } catch (error) {
      message.error(error instanceof Error ? error.message : "无法查看原交易");
    }
  }
  amount(title: string, dataIndex: string, width = 125): any {
    return {
      title,
      dataIndex,
      width,
      align: "right",
      sorter: (a: Row, b: Row) => a[dataIndex] - b[dataIndex],
      render: (value: number, row: Row) =>
        row.analysis_mode === "INCOME_ONLY" &&
        ["beginning", "ending", "capital_net", "internal_net"].includes(
          dataIndex,
        )
          ? "—"
          : Money.format(value),
    };
  }
  render() {
    const { report, filters, grain, loading } = this.state;
    const securities = this.props.accounts.filter(
      (a) =>
        !a.merged_into_id &&
        a.role === "ASSET" &&
        ["证券", "理财"].includes(a.kind),
    );
    const choices: Row[] = report?.available_accounts || securities;
    const selected = choices.find((a) => a.id === filters.account_id);
    const resetKey = JSON.stringify(filters);
    const comparison: Row[] = [...(report?.accounts || [])].sort(
      (a: Row, b: Row) => a.profit - b.profit,
    );
    return (
      <div className="investment-workspace">
        <div className="section-top">
          <div>
            <h2>理财</h2>
            <p className="muted">
              汇总整体理财收益，查看各账户的收益、亏损与资金情况。
            </p>
          </div>
          {selected?.active && selected.kind === "证券" && (
            <Button
              onClick={() => {
                const account = this.props.accounts.find(
                  (a) => a.id === selected.id,
                );
                if (account) this.props.onUpdate(account);
              }}
            >
              更新证券余额
            </Button>
          )}
        </div>
        <div className="filters">
          <Select
            aria-label="理财分析账户"
            style={{ width: 260 }}
            value={filters.account_id ?? "all"}
            options={[
              { value: "all", label: "全部理财收益" },
              ...choices.map((a) => ({
                value: a.id,
                label: a.name + (a.active ? "" : "（停用）"),
              })),
            ]}
            onChange={(value) =>
              this.filter({ account_id: value === "all" ? undefined : value })
            }
          />
          <DatePicker.RangePicker
            aria-label="理财分析日期"
            value={
              filters.start && filters.end
                ? [dayjs(filters.start), dayjs(filters.end)]
                : null
            }
            onChange={(dates) =>
              this.filter({
                start: dates?.[0]?.format("YYYY-MM-DD"),
                end: dates?.[1]?.format("YYYY-MM-DD"),
              })
            }
          />
          <Select
            aria-label="理财趋势粒度"
            value={grain}
            style={{ width: 115 }}
            options={[
              { value: "month", label: "按月" },
              { value: "day", label: "按日" },
            ]}
            onChange={(grain) => this.setState({ grain }, () => this.load())}
          />
          <Button
            onClick={() => this.setState({ filters: {} }, () => this.load())}
          >
            重置条件
          </Button>
        </div>
        {loading && !report ? (
          <Card loading />
        ) : (
          report && (
            <Spin spinning={loading}>
              {!report.account_count ? (
                <Card>
                  <Empty description="暂无理财账户或理财收益记录，可添加证券/理财账户，或将相关收入分类为“理财收益”" />
                  <Button onClick={this.props.onAccounts}>账户管理</Button>
                </Card>
              ) : (
                <>
                  <p className="muted">
                    分析区间：{report.start} 至 {report.end}
                    ，期末资产截至结束日期日末。
                  </p>
                  <div className="section-top">
                    <h3>
                      {selected ? `${selected.name} · 收益情况` : "整体收益"}
                    </h3>
                    {selected && (
                      <Button
                        onClick={() => this.filter({ account_id: undefined })}
                      >
                        查看全部账户
                      </Button>
                    )}
                  </div>
                  {!!report.income_only_count && (
                    <Alert
                      className="mb"
                      type="info"
                      showIcon
                      message="普通账户仅统计已归类的理财收益/投资亏损，账户全部余额不计入理财资产。"
                      description={`此类收益净额 ¥ ${Money.format(report.income_only_profit)}，已计入整体净收益。`}
                    />
                  )}
                  {!!report.missing_opening_ids.length && (
                    <Alert
                      className="mb"
                      type="warning"
                      showIcon
                      message="部分账户缺少所选日期前的期初基准"
                      description="资产按已记录的余额变动显示。补全期初或首次证券余额后，再核对完整盈亏。"
                      action={
                        <Button size="small" onClick={this.props.onAccounts}>
                          账户管理
                        </Button>
                      }
                    />
                  )}
                  <div className="metrics analysis-metrics">
                    <div className="metric">
                      <span>理财资产</span>
                      <strong data-testid="investment-assets">
                        {report.asset_account_count
                          ? `¥ ${Money.format(report.ending)}`
                          : "—"}
                      </strong>
                      <small>
                        {report.asset_account_count} 个理财资产账户 ·{" "}
                        {report.income_only_count} 个收益来源账户
                      </small>
                    </div>
                    <div className="metric featured">
                      <span>净收益</span>
                      <strong data-testid="investment-profit">
                        ¥ {Money.format(report.profit)}
                      </strong>
                      <small>
                        收益 ¥ {Money.format(report.gain)} · 亏损/费用 ¥{" "}
                        {Money.format(report.loss)}
                      </small>
                    </div>
                    <div className="metric">
                      <span>估值盈亏</span>
                      <strong data-testid="investment-valuation">
                        ¥ {Money.format(report.valuation_profit)}
                      </strong>
                      <small>
                        其他收益/费用净额 ¥ {Money.format(report.other_profit)}
                      </small>
                    </div>
                    <div className="metric">
                      <span>本金净转入</span>
                      <strong data-testid="investment-capital">
                        ¥ {Money.format(report.capital_net)}
                      </strong>
                      <small>
                        银行等转入 ¥ {Money.format(report.capital_in)} · 转出 ¥{" "}
                        {Money.format(report.capital_out)}
                      </small>
                    </div>
                  </div>
                  <Card className="mb" title="各账户净收益对比（元）">
                    <Chart
                      label="各账户理财净收益对比"
                      onClick={(params) => {
                        if (params.data?.id)
                          this.filter({ account_id: params.data.id });
                      }}
                      option={{
                        tooltip: { trigger: "axis", renderMode: "richText" },
                        grid: { left: 150, right: 35, top: 20, bottom: 35 },
                        xAxis: { type: "value" },
                        yAxis: {
                          type: "category",
                          data: comparison.map((a: Row) => a.name),
                          axisLabel: { width: 130, overflow: "truncate" },
                        },
                        dataZoom:
                          comparison.length > 10
                            ? [
                                {
                                  type: "slider",
                                  yAxisIndex: 0,
                                  orient: "vertical",
                                  width: 12,
                                  right: 0,
                                  startValue: 0,
                                  endValue: 9,
                                  showDataShadow: false,
                                },
                              ]
                            : [],
                        series: [
                          {
                            type: "bar",
                            barMaxWidth: 26,
                            data: comparison.map((a: Row) => ({
                              id: a.id,
                              value: a.profit / 100,
                              itemStyle: {
                                color: a.profit >= 0 ? "#73a58f" : "#b78863",
                              },
                            })),
                          },
                        ],
                      }}
                    />
                  </Card>
                  <div className="investment-charts mb">
                    <Card title="盈亏趋势（元）">
                      <Chart
                        label="理财收益趋势"
                        option={{
                          tooltip: { trigger: "axis", renderMode: "richText" },
                          legend: { bottom: 0 },
                          grid: { left: 65, right: 25, top: 20, bottom: 60 },
                          xAxis: {
                            type: "category",
                            data: report.trend.map((r: Row) => r.period),
                          },
                          yAxis: { type: "value" },
                          series: [
                            {
                              name: "期间盈亏",
                              type: "bar",
                              barMaxWidth: 30,
                              data: report.trend.map((r: Row) => ({
                                value: r.profit / 100,
                                itemStyle: {
                                  color: r.profit >= 0 ? "#73a58f" : "#b78863",
                                },
                              })),
                            },
                            {
                              name: "区间累计盈亏",
                              type: "line",
                              showSymbol: report.trend.length <= 31,
                              itemStyle: { color: "#275f49" },
                              data: report.trend.map(
                                (r: Row) => r.cumulative_profit / 100,
                              ),
                            },
                          ],
                        }}
                      />
                    </Card>
                    <Card title="理财资产趋势（元）">
                      {report.asset_account_count ? (
                        <Chart
                          label="理财资产趋势"
                          option={{
                            tooltip: {
                              trigger: "axis",
                              renderMode: "richText",
                            },
                            grid: { left: 75, right: 25, top: 20, bottom: 60 },
                            xAxis: {
                              type: "category",
                              data: report.trend.map((r: Row) => r.period),
                            },
                            yAxis: { type: "value" },
                            series: [
                              {
                                name: "期末资产",
                                type: "line",
                                showSymbol: report.trend.length <= 31,
                                itemStyle: { color: "#73a58f" },
                                areaStyle: { opacity: 0.08 },
                                data: report.trend.map(
                                  (r: Row) => r.assets / 100,
                                ),
                              },
                            ],
                          }}
                        />
                      ) : (
                        <Empty description="该账户仅统计理财收益，不统计资产余额" />
                      )}
                    </Card>
                  </div>
                  <Card
                    className="mb"
                    title="各账户情况（元）"
                    extra={
                      <small className="muted">
                        合并来源只统计一次，停用账户保留历史
                      </small>
                    }
                  >
                    <PagedTable<Row>
                      className="investment-accounts-table"
                      rowKey="id"
                      dataSource={report.accounts}
                      defaultPageSize={10}
                      pageResetKey={resetKey}
                      scroll={{ x: 1300 }}
                      columns={[
                        {
                          title: "账户",
                          dataIndex: "name",
                          width: 160,
                          fixed: "left",
                          render: (text, row) => (
                            <>
                              <Button
                                type="link"
                                size="small"
                                onClick={() =>
                                  this.filter({ account_id: row.id })
                                }
                              >
                                {text}
                              </Button>{" "}
                              {!row.active && <Tag>停用</Tag>}
                            </>
                          ),
                        },
                        {
                          title: "统计范围",
                          width: 110,
                          render: (_, row) => (
                            <Tag>
                              {row.analysis_mode === "INCOME_ONLY"
                                ? "仅理财收益"
                                : row.kind}
                            </Tag>
                          ),
                        },
                        this.amount("净收益", "profit"),
                        this.amount("累计盈利", "gain"),
                        this.amount("累计亏损/费用", "loss", 140),
                        this.amount("期末资产", "ending"),
                        this.amount("本金净转入", "capital_net"),
                        this.amount("区间初资产", "beginning"),
                        this.amount("证券内转净额", "internal_net"),
                        this.amount("估值盈亏", "valuation_profit"),
                        this.amount("其他收益/费用", "other_profit"),
                        {
                          title: "最近余额更新",
                          dataIndex: "last_valuation",
                          width: 150,
                          render: (v, row) =>
                            row.kind === "证券" ? v || "尚未更新" : "—",
                        },
                        {
                          title: "操作",
                          width: 100,
                          fixed: "right",
                          render: (_, row) =>
                            row.active && row.kind === "证券" ? (
                              <Button
                                type="link"
                                size="small"
                                onClick={() => {
                                  const account = securities.find(
                                    (a) => a.id === row.id,
                                  );
                                  if (account) this.props.onUpdate(account);
                                }}
                              >
                                更新余额
                              </Button>
                            ) : (
                              "—"
                            ),
                        },
                      ]}
                    />
                  </Card>
                  {!!report.asset_account_count && (
                    <Card
                      className="mb"
                      title="资产变动核对"
                      extra={
                        <Tag color={report.reconciled ? "green" : "red"}>
                          {report.reconciled ? "金额一致" : "需要核对"}
                        </Tag>
                      }
                    >
                      <Descriptions size="small" column={3}>
                        {[
                          ["区间初资产", "beginning"],
                          ["本期新设期初", "opening_added"],
                          ["本金净转入（银行等）", "capital_net"],
                          ["理财账户内转净额", "internal_net"],
                          ["理财账户净收益", "asset_profit"],
                          ["其他余额变动", "other_changes"],
                          ["期末理财资产", "ending"],
                        ].map(([title, key]) => (
                          <Descriptions.Item key={key} label={title}>
                            ¥ {Money.format(report[key])}
                          </Descriptions.Item>
                        ))}
                      </Descriptions>
                      <p className="muted investment-note">
                        区间初资产 + 本期新设期初 + 本金净转入 + 证券内转净额 +
                        理财账户净收益 + 其他余额变动 =
                        期末资产。全部理财账户汇总时，理财账户之间的互转净额为零；普通账户的理财收益仅计入收益统计，不参与理财资产核对。
                      </p>
                    </Card>
                  )}
                  <Card className="mb" title="盈亏与资金明细">
                    <Tabs
                      items={[
                        {
                          key: "profit",
                          label: `投资盈亏（${report.profits.length}）`,
                          children: (
                            <PagedTable<Row>
                              className="investment-profit-table"
                              rowKey="id"
                              dataSource={report.profits}
                              defaultPageSize={10}
                              pageResetKey={resetKey}
                              columns={[
                                { title: "时间", dataIndex: "occurred_at" },
                                {
                                  title: "账户",
                                  render: (_, r) => r.account_names.join("、"),
                                },
                                {
                                  title: "类型",
                                  render: (_, r) => (
                                    <Tag>
                                      {r.valuation
                                        ? "估值盈亏"
                                        : "其他收益/费用"}
                                    </Tag>
                                  ),
                                },
                                {
                                  title: "交易方 / 说明",
                                  render: (_, r) => (
                                    <>
                                      {r.counterparty || "—"}
                                      <small className="investment-row-note">
                                        {r.note}
                                      </small>
                                    </>
                                  ),
                                },
                                this.amount("盈亏（元）", "amount"),
                                {
                                  title: "操作",
                                  width: 70,
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
                          ),
                        },
                        {
                          key: "capital",
                          label: `资金转账（${report.transfers.length}）`,
                          children: (
                            <PagedTable<Row>
                              className="investment-transfer-table"
                              rowKey="id"
                              dataSource={report.transfers}
                              defaultPageSize={10}
                              pageResetKey={resetKey}
                              columns={[
                                { title: "时间", dataIndex: "occurred_at" },
                                {
                                  title: "转出账户",
                                  render: (_, r) => r.from_accounts.join("、"),
                                },
                                {
                                  title: "转入账户",
                                  render: (_, r) => r.to_accounts.join("、"),
                                },
                                {
                                  title: "类型",
                                  render: (_, r) => (
                                    <Tag>
                                      {r.internal
                                        ? "理财账户互转"
                                        : "银行等资金转账"}
                                    </Tag>
                                  ),
                                },
                                this.amount("转账金额（元）", "amount"),
                                this.amount(
                                  "所选理财资产变动",
                                  "scope_change",
                                  150,
                                ),
                                {
                                  title: "操作",
                                  width: 70,
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
                          ),
                        },
                      ]}
                    />
                  </Card>
                  <p className="muted investment-note">
                    理财资产包含证券及“理财”类型账户；其入金、出金按内部转账记录，不计投资收益。普通账户仅纳入已归类为理财收益/投资亏损的交易；拆分交易只计算匹配部分。资产按已记录的估值和流水累计，未更新的市场波动不会自动反映。
                  </p>
                </>
              )}
            </Spin>
          )
        )}
      </div>
    );
  }
}
