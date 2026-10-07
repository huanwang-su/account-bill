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
      render: (value: number) => Money.format(value),
    };
  }
  render() {
    const { report, filters, grain, loading } = this.state;
    const securities = this.props.accounts.filter(
      (a) => !a.merged_into_id && a.role === "ASSET" && a.kind === "证券",
    );
    const selected = securities.find((a) => a.id === filters.account_id);
    const resetKey = JSON.stringify(filters);
    return (
      <div className="investment-workspace">
        <div className="section-top">
          <div>
            <h2>理财收益分析</h2>
            <p className="muted">
              查看证券账户盈亏，区分投资收益与银行等账户的本金流动。
            </p>
          </div>
          {selected?.active && (
            <Button onClick={() => this.props.onUpdate(selected)}>
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
              { value: "all", label: "全部证券账户" },
              ...securities.map((a) => ({
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
                  <Empty description="暂无证券账户，在账户管理中将账户类型设为“证券”" />
                  <Button onClick={this.props.onAccounts}>账户管理</Button>
                </Card>
              ) : (
                <>
                  <p className="muted">
                    分析区间：{report.start} 至 {report.end}
                    ，期末资产截至结束日期日末。
                  </p>
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
                      <span>期末证券资产</span>
                      <strong data-testid="investment-assets">
                        ¥ {Money.format(report.ending)}
                      </strong>
                      <small>
                        {report.account_count} 个账户，按已记录的估值与流水
                      </small>
                    </div>
                    <div className="metric featured">
                      <span>区间净盈亏</span>
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
                  <div className="investment-charts mb">
                    <Card title="盈亏趋势（元）">
                      <Chart
                        label="证券盈亏趋势"
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
                    <Card title="证券资产趋势（元）">
                      <Chart
                        label="证券资产趋势"
                        option={{
                          tooltip: { trigger: "axis", renderMode: "richText" },
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
                    </Card>
                  </div>
                  <Card
                    className="mb"
                    title="账户盈亏对比（元）"
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
                          title: "证券账户",
                          dataIndex: "name",
                          width: 160,
                          fixed: "left",
                          render: (text, row) => (
                            <>
                              {text} {!row.active && <Tag>停用</Tag>}
                            </>
                          ),
                        },
                        this.amount("区间初资产", "beginning"),
                        this.amount("期末资产", "ending"),
                        this.amount("本金净转入", "capital_net"),
                        this.amount("证券内转净额", "internal_net"),
                        this.amount("估值盈亏", "valuation_profit"),
                        this.amount("其他收益/费用", "other_profit"),
                        this.amount("区间净盈亏", "profit"),
                        {
                          title: "最近余额更新",
                          dataIndex: "last_valuation",
                          width: 150,
                          render: (v) => v || "尚未更新",
                        },
                        {
                          title: "操作",
                          width: 100,
                          fixed: "right",
                          render: (_, row) =>
                            row.active ? (
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
                        ["证券账户内转净额", "internal_net"],
                        ["区间净盈亏", "profit"],
                        ["其他余额变动", "other_changes"],
                        ["期末证券资产", "ending"],
                      ].map(([title, key]) => (
                        <Descriptions.Item key={key} label={title}>
                          ¥ {Money.format(report[key])}
                        </Descriptions.Item>
                      ))}
                    </Descriptions>
                    <p className="muted investment-note">
                      区间初资产 + 本期新设期初 + 本金净转入 + 证券内转净额 +
                      净盈亏 + 其他余额变动 =
                      期末资产。全部证券账户汇总时，证券账户之间的互转净额为零。
                    </p>
                  </Card>
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
                                  title: "证券账户",
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
                                        ? "证券账户互转"
                                        : "银行等资金转账"}
                                    </Tag>
                                  ),
                                },
                                this.amount("转账金额（元）", "amount"),
                                this.amount(
                                  "所选证券资产变动",
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
                    银行与证券之间的入金、出金请记为内部转账，不计投资收益。盈亏包括证券余额更新产生的估值差额及证券账户已记录的收入、支出和退款。资产按最近估值及后续流水累计，未更新的市场波动不会自动反映。
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
