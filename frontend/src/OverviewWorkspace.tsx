import { ReportPeriodFilter } from "./ReportPeriodFilter";
import React from "react";
import {
  Button,
  Card,
  Empty,
  Drawer,
  Segmented,
  Space,
  Spin,
  Table,
  message,
} from "antd";
import { ArrowRightOutlined, ReloadOutlined } from "@ant-design/icons";
import { LedgerApi, MoneyFormatter as Money, Row } from "./api";
import { Chart } from "./Chart";

import { OverviewReading } from "./OverviewReading";
import { PagedTable } from "./PagedTable";
import { ReportAccountFilters } from "./ReportAccountFilters";
import {
  OverviewBalanceFlow,
  OverviewBalanceDistribution,
} from "./OverviewBalanceFlow";

interface Props {
  refreshKey: string;
  onReport: (tab: string) => void;
  onAccounts: () => void;
  onPending: () => void;
  onImport: () => void;
  onDetail: (row: Row) => void;
  onConfigure?: () => void;
  onSingleAccount?: (accountId: number, filters: Row) => void;
}
interface State {
  data?: Row;
  loading: boolean;
  trendView: "daily" | "cumulative";
  chartSelection?: Row;
  chartDetail?: Row;
  chartLoading: boolean;
  chartError?: string;
  filters: Row;
}
export class OverviewWorkspace extends React.Component<Props, State> {
  api = new LedgerApi();
  requestVersion = 0;
  chartVersion = 0;
  detailVersion = 0;
  state: State = {
    loading: true,
    trendView: "daily",
    chartLoading: false,
    filters: { period: "latest_month" },
  };
  componentDidMount() {
    this.load();
  }
  componentDidUpdate(previous: Props) {
    if (previous.refreshKey !== this.props.refreshKey) this.load();
  }
  componentWillUnmount() {
    this.requestVersion++;
    this.chartVersion++;
    this.detailVersion++;
  }
  async load() {
    this.closeChart();
    const version = ++this.requestVersion;
    this.setState({ loading: true });
    try {
      const data = await this.api.request(
        "/reports/overview?" +
          this.api.query(ReportAccountFilters.query(this.state.filters)),
      );
      if (version === this.requestVersion)
        this.setState({ data, loading: false });
    } catch (error) {
      if (version === this.requestVersion) {
        this.setState({ data: undefined, loading: false });
        message.error(error instanceof Error ? error.message : "总览加载失败");
      }
    }
  }
  filter(patch: Row) {
    this.closeChart();
    this.setState({ filters: { ...this.state.filters, ...patch } }, () =>
      this.load(),
    );
  }
  openCore(
    section: "income" | "investment",
    day: string,
    expected = this.state.data,
  ) {
    const data = this.state.data;
    if (!data || this.state.loading || data !== expected) return;
    const rows =
      section === "income"
        ? data.income_report?.trend
        : data.investment_report?.trend;
    if (!rows?.some((row: Row) => row.period === day)) return;
    this.openChart({
      section,
      day,
      label: `${day} · ${section === "income" ? "收入" : "理财收益"}`,
    });
  }
  openSingle(
    account: Row,
    flow?: "income" | "expense" | "transfer-in" | "transfer-out",
    day?: string,
    expected = this.state.data,
  ) {
    if (
      this.state.loading ||
      expected !== this.state.data ||
      !this.state.data?.single_accounts?.accounts.some(
        (row: Row) => row === account,
      )
    )
      return;
    if (
      flow &&
      !["income", "expense", "transfer-in", "transfer-out"].includes(flow)
    )
      return;
    if (day && !(account.trend || []).some((row: Row) => row.day === day))
      return;
    const rows = account.transactions.filter(
      (row: Row) =>
        (!day || row.occurred_at.slice(0, 10) === day) &&
        (!flow ||
          (row.source !== "证券余额更新" &&
            (flow === "income"
              ? row.kind === "INCOME"
              : flow === "expense"
                ? ["EXPENSE", "REFUND"].includes(row.kind)
                : row.kind === "TRANSFER" &&
                  row.account_change * (flow === "transfer-in" ? 1 : -1) > 0))),
    );
    this.chartVersion++;
    this.detailVersion++;
    this.setState({
      chartSelection: {
        section: "single",
        label: `${account.name} · ${day ? day + " · " : ""}${flow === "income" ? "收入" : flow === "expense" ? "净支出" : flow === "transfer-in" ? "内部转入" : flow === "transfer-out" ? "内部转出" : "期间账户变动"}`,
        flow,
      },
      chartLoading: false,
      chartError: undefined,
      chartDetail: {
        amount:
          rows.reduce((sum: number, row: Row) => sum + row.account_change, 0) *
            (flow === "expense" || flow === "transfer-out" ? -1 : 1) || 0,
        count: rows.length,
        transactions: rows.map((row: Row) => ({
          ...row,
          amount:
            row.account_change *
            (flow === "expense" || flow === "transfer-out" ? -1 : 1),
        })),
        accounts: [],
      },
    });
  }
  openPosition(
    model: OverviewBalanceDistribution,
    selection: Row,
    expected: Row,
  ) {
    if (this.state.loading || expected !== this.state.data) return;
    const accounts = model.matching(selection);
    this.chartVersion++;
    this.detailVersion++;
    this.setState({
      chartSelection: {
        ...selection,
        section: model.role === "ASSET" ? "assets" : "liabilities",
        label: `${model.role === "ASSET" ? "资产" : "负债"} · ${selection.label}`,
      },
      chartLoading: false,
      chartError: undefined,
      chartDetail: {
        as_of: expected.as_of,
        accounts,
        transactions: [],
        count: accounts.length,
        amount: accounts.reduce(
          (sum: number, row: Row) => sum + row.analysis_amount,
          0,
        ),
      },
    });
  }
  openExpense(
    params: any,
    expected = this.state.data,
    expectedView = this.state.trendView,
  ) {
    if (
      this.state.loading ||
      !this.state.data ||
      expected !== this.state.data ||
      expectedView !== this.state.trendView
    )
      return;
    const data = this.state.data;
    const day = params.data?.day;
    if (!data.household.trend.some((row: Row) => row.day === day)) return;
    const cumulative = this.state.trendView === "cumulative";
    this.openChart({
      section: "expense",
      day,
      cumulative,
      label: cumulative
        ? `${data.month_start} 至 ${day} 累计净开支`
        : `${day} 净开支`,
    });
  }
  async openChart(selection: Row) {
    if (this.state.loading || !this.state.data) return;
    const version = ++this.chartVersion;
    this.detailVersion++;
    this.setState({
      chartSelection: selection,
      chartDetail: undefined,
      chartLoading: true,
      chartError: undefined,
    });
    try {
      const detail = await this.api.request(
        "/reports/overview/details?" +
          this.api.query({
            ...ReportAccountFilters.query(this.state.filters),
            period: "custom",
            start: this.state.data.period?.start || this.state.data.month_start,
            end: this.state.data.period?.end || this.state.data.as_of,
            as_of: this.state.data.as_of,
            section: selection.section,
            day: selection.day,
            cumulative: selection.cumulative,
            group_id: selection.group_id,
          }),
      );
      if (version === this.chartVersion)
        this.setState({ chartDetail: detail, chartLoading: false });
    } catch (error) {
      if (version === this.chartVersion)
        this.setState({
          chartLoading: false,
          chartError:
            error instanceof Error ? error.message : "图表明细加载失败",
        });
    }
  }
  closeChart() {
    this.chartVersion++;
    this.detailVersion++;
    this.setState({
      chartSelection: undefined,
      chartDetail: undefined,
      chartLoading: false,
      chartError: undefined,
    });
  }
  async openTransaction(id: number) {
    const version = ++this.detailVersion;
    const chartVersion = this.chartVersion;
    try {
      const row = await this.api.transaction(id);
      if (
        row &&
        version === this.detailVersion &&
        chartVersion === this.chartVersion &&
        this.state.chartSelection
      )
        this.props.onDetail(row);
    } catch (error) {
      if (version === this.detailVersion && chartVersion === this.chartVersion)
        message.error(
          error instanceof Error ? error.message : "交易明细加载失败",
        );
    }
  }
  renderChartDetails() {
    const {
      chartSelection: selection,
      chartDetail: detail,
      chartLoading,
      chartError,
    } = this.state;
    return (
      <Drawer
        title={selection?.label || "图表明细"}
        open={Boolean(selection)}
        onClose={() => this.closeChart()}
        width={960}
      >
        <Spin spinning={chartLoading}>
          {chartError ? (
            <Empty description={chartError}>
              <Button onClick={() => selection && this.openChart(selection)}>
                重新加载
              </Button>
            </Empty>
          ) : detail ? (
            <>
              <p className="muted">
                {!["assets", "liabilities"].includes(selection?.section)
                  ? selection?.section === "investment"
                    ? "仅列证券理财账户的已记录收益，本金转入转出不计收益。"
                    : selection?.section === "single"
                      ? selection?.flow
                        ? selection.flow === "transfer-in" ||
                          selection.flow === "transfer-out"
                          ? "仅列该账户所选方向的内部转账，本金转入、转出不计入收入或支出。"
                          : "仅列该账户所选方向的收支；退款抵减支出，内部转账、估值及期初调整不计入收支。"
                        : "按该账户完整流水核对期间余额变化，收入、付款、退款、内部转账、估值及调整分别保留。"
                      : "沿用总览当前日期与账户屏蔽条件，付款和退款共同计入净开支，不修改保存的分析配置。"
                  : `截至 ${detail.as_of}，按所选账户组及标签查看账户；父子组与合并来源不重复计入。`}
              </p>
              <p className="analysis-large-summary">
                对应金额 ¥ {Money.format(detail.amount)} · {detail.count}{" "}
                {!["assets", "liabilities"].includes(selection?.section)
                  ? "笔记录"
                  : "个账户"}
              </p>
              {!["assets", "liabilities"].includes(selection?.section) ? (
                <PagedTable<Row>
                  rowKey="id"
                  dataSource={detail.transactions}
                  defaultPageSize={10}
                  pageResetKey={JSON.stringify(selection)}
                  scroll={{ x: 800 }}
                  columns={[
                    {
                      title: "时间 / 对方",
                      render: (_, row) => (
                        <>
                          <div>{row.counterparty || "未填写交易方"}</div>
                          <small className="muted">{row.occurred_at}</small>
                        </>
                      ),
                    },
                    {
                      title: "资金账户",
                      render: (_, row) =>
                        Array.from(
                          new Set(
                            (row.entries || [])
                              .filter((entry: Row) =>
                                ["ASSET", "LIABILITY"].includes(entry.role),
                              )
                              .map((entry: Row) => entry.account),
                          ),
                        ).join("、") || (row.account_names || []).join("、"),
                    },
                    {
                      title: "分类",
                      render: (_, row) => (row.category_names || []).join("、"),
                    },
                    {
                      title:
                        selection?.section === "income"
                          ? "收入（元）"
                          : selection?.section === "investment"
                            ? "收益（元）"
                            : selection?.section === "single"
                              ? selection?.flow === "income"
                                ? "收入（元）"
                                : selection?.flow === "expense"
                                  ? "净支出（元）"
                                  : selection?.flow === "transfer-in"
                                    ? "内部转入（元）"
                                    : selection?.flow === "transfer-out"
                                      ? "内部转出（元）"
                                      : "余额变化（元）"
                              : "净开支（元）",
                      align: "right",
                      dataIndex: "amount",
                      sorter: (a, b) => a.amount - b.amount,
                      render: (value, row) => (
                        <>
                          <strong>{Money.format(value)}</strong>
                          <div className="muted">
                            {row.source === "证券余额更新"
                              ? "证券估值"
                              : (
                                  {
                                    INCOME: "收入",
                                    EXPENSE: "付款",
                                    REFUND: "退款抵减",
                                    TRANSFER: "内部转账",
                                    OPENING: "期初录入",
                                  } as Row
                                )[row.kind] || "账面调整"}
                          </div>
                        </>
                      ),
                    },
                    {
                      title: "操作",
                      render: (_, row) => (
                        <Button
                          type="link"
                          size="small"
                          onClick={() => this.openTransaction(row.id)}
                        >
                          查看原交易
                        </Button>
                      ),
                    },
                  ]}
                />
              ) : (
                <PagedTable<Row>
                  rowKey="id"
                  dataSource={detail.accounts}
                  defaultPageSize={10}
                  pageResetKey={JSON.stringify(selection)}
                  columns={[
                    { title: "账户", dataIndex: "name" },
                    { title: "账户类型", dataIndex: "kind" },
                    {
                      title: `${selection?.section === "assets" ? "资产" : "负债"}金额（元）`,
                      align: "right",
                      dataIndex: "analysis_amount",
                      sorter: (a, b) => a.analysis_amount - b.analysis_amount,
                      render: (value) => Money.format(value),
                    },
                  ]}
                />
              )}
            </>
          ) : !chartLoading ? (
            <Empty description="请选择图中项目查看对应数据" />
          ) : null}
        </Spin>
      </Drawer>
    );
  }
  renderBalanceHero(d: Row) {
    const investment = d.investments,
      reading = new OverviewReading(d);
    return (
      <section className="overview-hero">
        <div className="overview-networth">
          <span>账面净资产</span>
          <strong data-testid="overview-net-assets">
            ¥ {Money.format(d.net_assets)}
          </strong>
          <p>家庭资产 − 家庭负债，按已记录余额与流水计算</p>
          <Button
            type="link"
            onClick={() => this.props.onReport("balance-sheet")}
          >
            查看资产负债表 <ArrowRightOutlined />
          </Button>
        </div>
        <div className="overview-positions">
          <div>
            <span>家庭资产</span>
            <strong>¥ {Money.format(d.assets)}</strong>
          </div>
          <div>
            <span>家庭负债</span>
            <strong>¥ {Money.format(d.liabilities)}</strong>
            {reading.liabilityRatio && (
              <small>负债 / 资产 {reading.liabilityRatio}</small>
            )}
          </div>
          <div>
            <span>其中：理财资产</span>
            <strong>¥ {Money.format(investment.assets)}</strong>
          </div>
          <div>
            <span>资金账户</span>
            <strong>
              {d.account_count}
              <small> 个</small>
            </strong>
          </div>
        </div>
      </section>
    );
  }
  renderSpending(d: Row) {
    const household = d.household,
      trendView = this.state.trendView,
      trend = new OverviewReading(d).trend;
    return (
      <Card
        title={d.income_report ? "支出 · 开支节奏" : "本月开支节奏"}
        extra={
          <Segmented
            size="small"
            aria-label="总览开支趋势展示方式"
            value={trendView || "daily"}
            options={[
              { value: "daily", label: "每日" },
              { value: "cumulative", label: "累计" },
            ]}
            onChange={(value) =>
              this.setState({
                trendView: value as "daily" | "cumulative",
              })
            }
          />
        }
      >
        {household.trend.some((r: Row) => r.expense !== 0) ? (
          <Chart
            label={
              trendView === "cumulative"
                ? d.income_report
                  ? "总览区间累计净开支"
                  : "总览本月累计净开支"
                : d.income_report
                  ? "总览区间每日净开支"
                  : "总览本月每日净开支"
            }
            style={{ height: 240 }}
            onClick={(params) => this.openExpense(params, d, trendView)}
            option={{
              tooltip: { trigger: "axis", renderMode: "richText" },
              grid: { left: 65, right: 15, top: 30, bottom: 30 },
              xAxis: {
                type: "category",
                data: trend.map((r: Row) =>
                  d.income_report ? r.day : r.day.slice(5),
                ),
              },
              yAxis: { type: "value", name: "元" },
              series: [
                {
                  name:
                    trendView === "cumulative"
                      ? "区间累计净开支（元）"
                      : "当日净开支（元）",
                  type: "line",
                  itemStyle: { color: "#b78863" },
                  showSymbol: trend.length <= 31,
                  symbolSize: 5,
                  data: trend.map((r: Row) => ({
                    day: r.day,
                    value:
                      (trendView === "cumulative" ? r.cumulative : r.expense) /
                      100,
                  })),
                },
              ],
            }}
          />
        ) : (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={
              d.income_report ? "当前区间暂无开支记录" : "本月暂无家庭开支记录"
            }
          />
        )}
        <div className="overview-trend-summary">
          <span>日均 ¥ {Money.format(household.average_daily)}</span>
          <span>
            {trendView === "cumulative"
              ? "累计线下降表示当天退款多于付款"
              : "曲线低于零表示当天退款多于付款"}
            ；点击图中数据查看对应明细
          </span>
        </div>
      </Card>
    );
  }
  renderGroupBalance(d: Row) {
    return (
      <Card
        title="家庭资产归属"
        extra={
          <Button type="link" onClick={this.props.onAccounts}>
            账户管理 <ArrowRightOutlined />
          </Button>
        }
      >
        <p className="overview-card-guide">
          资产与负债分别展示“总额 → 账户组 →
          账户标签”，点击节点或连线核对对应账户。
        </p>
        <div className="overview-position-grid">
          {["ASSET", "LIABILITY"].map((role) => (
            <OverviewBalanceFlow
              key={role}
              snapshot={d.balance_sheet || { accounts: [], groups: [] }}
              role={role}
              onSelect={(model, selection) =>
                this.openPosition(model, selection, d)
              }
            />
          ))}
        </div>
        <details className="overview-group-details">
          <summary>查看各组金额（元）</summary>
          <Table<Row>
            size="small"
            rowKey={(r) => String(r.id ?? "ungrouped")}
            dataSource={d.groups}
            pagination={false}
            columns={[
              { title: "账户组", dataIndex: "name" },
              {
                title: "资产",
                dataIndex: "assets",
                align: "right",
                render: (v) => Money.format(v),
              },
              {
                title: "负债",
                dataIndex: "liabilities",
                align: "right",
                render: (v) => Money.format(v),
              },
              {
                title: "净额",
                dataIndex: "net_assets",
                align: "right",
                render: (v) => (
                  <strong className={v < 0 ? "balance-negative" : ""}>
                    {Money.format(v)}
                  </strong>
                ),
              },
            ]}
          />
        </details>
        <p className="overview-card-footnote">
          按直属归属拆分，父组与子组不重复累计；金额单位：元。
        </p>
      </Card>
    );
  }
  viewSingleAccount(account: Row, data: Row) {
    if (this.state.loading || data !== this.state.data) return;
    this.props.onSingleAccount?.(account.id, {
      period: "custom",
      start: data.period.start,
      end: data.period.end,
    });
  }
  renderAttentionAccounts(d: Row) {
    const accounts: Row[] = d.single_accounts?.accounts || [];
    return (
      <section
        className="overview-attention-section"
        aria-label="关注账户独立收支"
      >
        <div className="overview-section-heading">
          <div>
            <h3>关注账户 · 独立核对</h3>
            <p>
              每个账户独立展示，名单来自“分析配置 →
              关注账户”，不受上方账户屏蔽条件影响。
            </p>
          </div>
          <Button onClick={() => this.props.onConfigure?.()}>
            配置关注账户
          </Button>
        </div>
        {accounts.length ? (
          <div className="overview-accounts-grid">
            {accounts.map((account) => (
              <Card
                key={account.id}
                title={
                  <Button
                    type="link"
                    onClick={() => this.viewSingleAccount(account, d)}
                  >
                    {account.name}
                  </Button>
                }
                extra={
                  <Button
                    type="link"
                    onClick={() => this.viewSingleAccount(account, d)}
                  >
                    单账户分析 <ArrowRightOutlined />
                  </Button>
                }
              >
                <div className="overview-core-stats overview-account-balance">
                  <div>
                    <span>期末余额</span>
                    <strong>¥ {Money.format(account.ending_balance)}</strong>
                  </div>
                  <div>
                    <span>期间余额变化</span>
                    <strong>¥ {Money.format(account.change)}</strong>
                  </div>
                </div>
                <div className="overview-account-cash">
                  <button onClick={() => this.openSingle(account, "income")}>
                    <span>期间收入</span>
                    <strong className="income">
                      ¥ {Money.format(account.income)}
                    </strong>
                  </button>
                  <button onClick={() => this.openSingle(account, "expense")}>
                    <span>期间净支出</span>
                    <strong>
                      ¥ {Money.format(account.expense - account.refunds)}
                    </strong>
                  </button>
                  <div>
                    <span>收支结余</span>
                    <strong>
                      ¥{" "}
                      {Money.format(
                        account.income - account.expense + account.refunds,
                      )}
                    </strong>
                  </div>
                </div>
                <div className="overview-account-transfers">
                  <button
                    onClick={() => this.openSingle(account, "transfer-in")}
                  >
                    <span>内部转入</span>
                    <strong>¥ {Money.format(account.transfer_in || 0)}</strong>
                  </button>
                  <button
                    onClick={() => this.openSingle(account, "transfer-out")}
                  >
                    <span>内部转出</span>
                    <strong>¥ {Money.format(account.transfer_out || 0)}</strong>
                  </button>
                  <small>
                    内部净转入 ¥ {Money.format(account.transfer_net)}
                    ，账户间移动本金，不计入收入或支出。
                  </small>
                </div>
                {account.transactions.length ? (
                  <Chart
                    label={`${account.name} · 独立收支趋势`}
                    style={{ height: 240 }}
                    onClick={(params) => {
                      const { day, flow } = params.data || {};
                      if (
                        day &&
                        [
                          "income",
                          "expense",
                          "transfer-in",
                          "transfer-out",
                        ].includes(flow)
                      )
                        this.openSingle(account, flow, day, d);
                    }}
                    option={{
                      tooltip: { trigger: "axis", renderMode: "richText" },
                      legend: {
                        bottom: 0,
                        data: ["收入", "净支出", "内部转入", "内部转出"],
                      },
                      grid: { left: 65, right: 20, top: 20, bottom: 55 },
                      xAxis: {
                        type: "category",
                        data: (account.trend || []).map((row: Row) => row.day),
                      },
                      yAxis: { type: "value", name: "元" },
                      series: (
                        [
                          "income",
                          "expense",
                          "transfer-in",
                          "transfer-out",
                        ] as const
                      ).map((flow) => ({
                        name: {
                          income: "收入",
                          expense: "净支出",
                          "transfer-in": "内部转入",
                          "transfer-out": "内部转出",
                        }[flow],
                        type: "line",
                        showSymbol: (account.trend || []).length <= 31,
                        itemStyle: {
                          color: {
                            income: "#73a58f",
                            expense: "#b78863",
                            "transfer-in": "#738bb0",
                            "transfer-out": "#a68bb0",
                          }[flow],
                        },
                        data: (account.trend || []).map((row: Row) => ({
                          day: row.day,
                          flow,
                          value:
                            (row[
                              flow === "transfer-in"
                                ? "transfer_in"
                                : flow === "transfer-out"
                                  ? "transfer_out"
                                  : flow
                            ] || 0) / 100,
                        })),
                      })),
                    }}
                  />
                ) : (
                  <Empty
                    image={Empty.PRESENTED_IMAGE_SIMPLE}
                    description="当前区间暂无账户变动"
                  />
                )}
                <p className="overview-card-footnote">
                  内部转账净额 ¥ {Money.format(account.transfer_net)} · 估值盈亏
                  ¥ {Money.format(account.valuation_profit || 0)}
                  。本金、估值及调整不计入上方收支；退款抵减支出。点击金额或曲线查看明细。
                </p>
              </Card>
            ))}
          </div>
        ) : (
          <Card>
            <Empty description="尚未配置关注账户">
              <Button onClick={() => this.props.onConfigure?.()}>
                选择关注账户
              </Button>
            </Empty>
          </Card>
        )}
      </section>
    );
  }
  renderModern(d: Row) {
    const filters = this.state.filters,
      income = d.income_report,
      investment = d.investment_report,
      cash = d.household;
    const accountOptions = d.balance_sheet?.accounts || [];
    return (
      <Spin spinning={this.state.loading}>
        <div className="family-overview">
          <div className="overview-period">
            <div>
              <strong>家庭财务总览</strong>
              <span>
                账面截至 {d.as_of} · 最新账务{" "}
                {d.period.latest_data_date || "暂无"}
              </span>
            </div>
            <Button icon={<ReloadOutlined />} onClick={() => this.load()}>
              刷新总览
            </Button>
          </div>
          {this.renderBalanceHero(d)}
          {this.renderGroupBalance(d)}
          <section
            className="overview-analysis-filters"
            aria-label="总览收支过滤条件"
          >
            <ReportPeriodFilter
              refreshKey={this.props.refreshKey}
              filters={filters}
              label="总览指定日期"
              onChange={(patch) => this.filter(patch)}
            />
            <ReportAccountFilters
              accounts={accountOptions}
              defaults={d.account_scope}
              disabled={this.state.loading}
              filters={filters}
              onChange={(patch) => this.filter(patch)}
            />
            <p className="overview-scope-note">
              时间区间：{d.period.start} 至 {d.period.end}
              。账户屏蔽作用于收入与支出；资产负债展示完整家庭余额，理财仅看证券理财账户，关注账户按配置独立展示。各模块分别核对，不将本金转入当成收益。
            </p>
          </section>
          <div className="metrics analysis-metrics mt">
            {[
              ["期间收入", income.income, `${income.count} 笔有效收入`],
              [
                "期间净支出",
                cash.expense,
                `${cash.count} 笔付款 · 退款抵减 ${Money.format(cash.refunds)}`,
              ],
              ["收支结余", cash.net, "收入 − 净支出，不等于资产变化"],
              [
                "理财收益",
                investment.profit,
                "证券及理财账户，本金转入转出不计收益",
              ],
            ].map(([title, value, note]) => (
              <div className="metric" key={String(title)}>
                <span>{title}</span>
                <strong
                  className={
                    Number(value) < 0
                      ? "balance-negative"
                      : title === "期间收入" || title === "理财收益"
                        ? "income"
                        : ""
                  }
                >
                  ¥ {Money.format(Number(value))}
                </strong>
                <small>{note}</small>
              </div>
            ))}
          </div>
          <div className="overview-core-grid">
            <Card
              title="收入 · 来源与节奏"
              extra={
                <Button
                  type="link"
                  onClick={() => this.props.onReport("income")}
                >
                  收入分析 <ArrowRightOutlined />
                </Button>
              }
            >
              <div className="overview-core-stats">
                <div>
                  <span>期间收入</span>
                  <strong>¥ {Money.format(income.income)}</strong>
                </div>
                <div>
                  <span>收入笔数</span>
                  <strong>{income.count} 笔</strong>
                </div>
              </div>
              {income.count ? (
                <Chart
                  label="总览区间收入趋势"
                  style={{ height: 240 }}
                  onClick={(params) =>
                    this.openCore("income", params.data?.day, d)
                  }
                  option={{
                    tooltip: { trigger: "axis", renderMode: "richText" },
                    grid: { left: 65, right: 20, top: 20, bottom: 35 },
                    xAxis: {
                      type: "category",
                      data: income.trend.map((row: Row) => row.period),
                    },
                    yAxis: { type: "value", name: "元" },
                    series: [
                      {
                        name: "收入",
                        type: "line",
                        showSymbol: income.trend.length <= 31,
                        data: income.trend.map((row: Row) => ({
                          day: row.period,
                          value: row.income / 100,
                        })),
                        itemStyle: { color: "#73a58f" },
                      },
                    ],
                  }}
                />
              ) : (
                <Empty description="当前范围暂无收入" />
              )}
              <div className="overview-core-list">
                {income.categories.slice(0, 3).map((row: Row) => (
                  <span key={row.id}>
                    {row.name} · ¥ {Money.format(row.amount)}
                  </span>
                ))}
              </div>
              <p className="overview-card-footnote">
                点击日期查看当天收入；沿用上方账户屏蔽条件，内部转账不计收入。
              </p>
            </Card>
            {this.renderSpending(d)}
            <Card
              className="overview-wealth-card"
              title="理财 · 收益与本金"
              extra={
                <Button
                  type="link"
                  onClick={() => this.props.onReport("investments")}
                >
                  理财分析 <ArrowRightOutlined />
                </Button>
              }
            >
              <div className="overview-core-stats">
                <div>
                  <span>期末理财资产</span>
                  <strong>¥ {Money.format(investment.ending)}</strong>
                </div>
                <div>
                  <span>期间收益</span>
                  <strong
                    className={
                      investment.profit < 0 ? "balance-negative" : "income"
                    }
                  >
                    ¥ {Money.format(investment.profit)}
                  </strong>
                </div>
              </div>
              <div className="overview-core-stats">
                <div>
                  <span>本金转入</span>
                  <strong>¥ {Money.format(investment.capital_in)}</strong>
                </div>
                <div>
                  <span>本金转出</span>
                  <strong>¥ {Money.format(investment.capital_out)}</strong>
                </div>
              </div>
              {investment.account_count ? (
                <Chart
                  label="总览区间理财收益趋势"
                  style={{ height: 240 }}
                  onClick={(params) =>
                    this.openCore("investment", params.data?.day, d)
                  }
                  option={{
                    tooltip: { trigger: "axis", renderMode: "richText" },
                    grid: { left: 65, right: 20, top: 20, bottom: 35 },
                    xAxis: {
                      type: "category",
                      data: investment.trend.map((row: Row) => row.period),
                    },
                    yAxis: { type: "value", name: "元" },
                    series: [
                      {
                        name: "期间收益",
                        type: "line",
                        showSymbol: investment.trend.length <= 31,
                        data: investment.trend.map((row: Row) => ({
                          day: row.period,
                          value: row.profit / 100,
                        })),
                        itemStyle: { color: "#738bb0" },
                      },
                    ],
                  }}
                />
              ) : (
                <Empty description="暂无证券理财账户" />
              )}
              <p className="overview-card-footnote">
                点击日期核对收益记录。资产可能因本金、估值和期初录入变化；收益单独计算。
              </p>
            </Card>
          </div>
          {this.renderAttentionAccounts(d)}
          <div className="overview-data-status">
            <span>
              {d.pending_count} 条账单待入账 · 最新导入{" "}
              {d.last_import?.at || "暂无"}
            </span>
            <Space>
              <Button type="link" onClick={this.props.onPending}>
                查看待入账
              </Button>
              <Button type="link" onClick={this.props.onImport}>
                导入账单
              </Button>
            </Space>
          </div>
          {this.renderChartDetails()}
        </div>
      </Spin>
    );
  }
  render() {
    return this.state.data?.income_report
      ? this.renderModern(this.state.data)
      : this.renderLegacy();
  }
  renderLegacy() {
    const { data: d, loading, trendView } = this.state;
    if (!d)
      return (
        <Card loading={loading}>
          {!loading && (
            <Button onClick={() => this.load()}>重新加载总览</Button>
          )}
        </Card>
      );
    const household = d.household,
      investment = d.investments,
      reading = new OverviewReading(d);
    return (
      <Spin spinning={loading}>
        <div className="family-overview">
          <div className="overview-period">
            <div>
              <strong>家庭财务快照</strong>
              <span>
                资产截至 {d.as_of} · 本月收支 {d.month_start} 至 {d.as_of}
              </span>
            </div>
            <Button icon={<ReloadOutlined />} onClick={() => this.load()}>
              刷新快照
            </Button>
          </div>
          {this.renderBalanceHero(d)}
          <div className="overview-cashflow">
            <Card>
              <span>本月生活收入</span>
              <strong className="income">
                ¥ {Money.format(household.income)}
              </strong>
              <small>已入账生活收入，不含内部转账和理财盈亏</small>
            </Card>
            <Card>
              <span>本月家庭开支（净额）</span>
              <strong>¥ {Money.format(household.expense)}</strong>
              <small>
                {household.count} 笔付款 · 已扣除独立退款 ¥{" "}
                {Money.format(household.refunds)}
              </small>
            </Card>
            <Card>
              <span>本月生活收支结余</span>
              <strong
                className={household.net < 0 ? "balance-negative" : "income"}
              >
                ¥ {Money.format(household.net)}
              </strong>
              <small>生活收入 − 家庭开支，不含内部转账和投资盈亏</small>
            </Card>
          </div>

          <div className="overview-main-grid">
            {this.renderSpending(d)}
            <Card title="优先回看这些记录" className="overview-attention">
              <button onClick={this.props.onPending}>
                <div>
                  <strong>{d.pending_count} 条待入账</strong>
                  <span>
                    {d.pending_count
                      ? "确认后才会计入收支与账户余额"
                      : "当前没有等待确认入账的账单"}
                  </span>
                </div>
                <ArrowRightOutlined />
              </button>
              <button onClick={() => this.props.onReport("expenses")}>
                <div>
                  <strong>¥ {Money.format(household.unknown_amount)}</strong>
                  <span>本月用途未知的净开支，影响分类解读</span>
                </div>
                <ArrowRightOutlined />
              </button>
              <button onClick={() => this.props.onReport("expenses")}>
                <div>
                  <strong>{household.large_count} 笔大额付款</strong>
                  <span>
                    另有 {household.frequent_count} 个高频交易方可回看
                  </span>
                </div>
                <ArrowRightOutlined />
              </button>
              <p>
                先确认入账和分类，再据此判断开支结构；待确认账单不计入上述收支。
              </p>
            </Card>
          </div>
          <div className="overview-main-grid">
            {this.renderGroupBalance(d)}
            <Card
              title="本月理财表现"
              extra={
                <Button
                  type="link"
                  onClick={() => this.props.onReport("investments")}
                >
                  理财分析 <ArrowRightOutlined />
                </Button>
              }
            >
              <div className="overview-investment">
                <span>本月理财净收益</span>
                <strong
                  className={
                    investment.profit < 0 ? "balance-negative" : "income"
                  }
                >
                  {investment.profit > 0 ? "+" : ""}¥{" "}
                  {Money.format(investment.profit)}
                </strong>
                <small>
                  {investment.account_count} 个理财账户 · 按已记录的估值与流水
                </small>
              </div>
              <div className="overview-investment-facts">
                <div>
                  <span>当前理财资产</span>
                  <strong>¥ {Money.format(investment.assets)}</strong>
                  {reading.investmentShare && (
                    <small>占家庭资产 {reading.investmentShare}</small>
                  )}
                </div>
                <div>
                  <span>最近估值更新</span>
                  <strong className="overview-valuation-date">
                    {investment.last_valuation?.slice(0, 10) || "尚无估值记录"}
                  </strong>
                  <small>余额变动还可能来自本金投入或新设期初</small>
                </div>
              </div>
              <p className="overview-card-footnote">
                本金转入、转出不计入收益；没有新估值记录时，图中金额不代表市场价格没有变化。
              </p>
            </Card>
          </div>
          <Card
            title="最近账务动态"
            extra={
              <Space>
                <Button type="link" onClick={this.props.onImport}>
                  导入新账单
                </Button>
                <Button
                  type="link"
                  onClick={() => this.props.onReport("details")}
                >
                  查看明细
                </Button>
              </Space>
            }
          >
            {d.recent.length ? (
              <div className="overview-activity">
                {d.recent.map((r: Row) => (
                  <button key={r.id} onClick={() => this.props.onDetail(r)}>
                    <div>
                      <strong>
                        {r.source === "证券余额更新"
                          ? "证券估值" + (r.kind === "INCOME" ? "盈利" : "亏损")
                          : r.counterparty ||
                            (
                              {
                                EXPENSE: "支出",
                                INCOME: "收入",
                                TRANSFER: "内部转账",
                                REFUND: "退款",
                              } as Row
                            )[r.kind]}
                      </strong>
                      <small>
                        {r.occurred_at} · {r.source}
                      </small>
                    </div>
                    <span
                      className={
                        r.kind === "INCOME" || r.kind === "REFUND"
                          ? "income"
                          : ""
                      }
                    >
                      {r.kind === "EXPENSE"
                        ? "-"
                        : r.kind === "INCOME" || r.kind === "REFUND"
                          ? "+"
                          : ""}
                      ¥ {Money.format(r.amount)}
                    </span>
                  </button>
                ))}
              </div>
            ) : (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description="还没有已入账的账务活动"
              />
            )}
            <div className="overview-data-status">
              <span>
                最近账务日期：{d.last_activity?.slice(0, 10) || "暂无"}
              </span>
              <span>
                最近账单导入：{d.last_import?.at || "暂无"} · 数据保存在本机
              </span>
            </div>
          </Card>
          {this.renderChartDetails()}
        </div>
      </Spin>
    );
  }
}
