import { ReportPeriodFilter } from "./ReportPeriodFilter";
import React from "react";
import {
  Alert,
  Button,
  Card,
  Descriptions,
  Drawer,
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
import { InvestmentFlows } from "./InvestmentFlows";

import {
  AnalysisDrilldownBar,
  ReportDrilldown,
  type DetailPeriod,
} from "./AnalysisDrilldown";

interface Props {
  accounts: Row[];
  groups: Row[];
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
  drilldown?: Row;
  drillBack?: Row;
  drillReport?: Row;
  drillLoading?: boolean;
  drillError?: string;
  drillPeriod?: DetailPeriod;
  drillTab?: string;
}

export class InvestmentWorkspace extends React.Component<Props, State> {
  api = new LedgerApi();
  requestVersion = 0;
  drillVersion = 0;
  detailVersion = 0;
  state: State = {
    filters: ReportPeriodFilter.defaults(),
    grain: "month",
    loading: true,
  };
  componentDidMount() {
    this.load();
  }
  componentDidUpdate(previous: Props) {
    if (previous.refreshKey !== this.props.refreshKey) {
      const selected = this.state.filters.account_id;
      if (
        selected &&
        !this.props.accounts.some(
          (a) =>
            a.id === selected &&
            !a.merged_into_id &&
            a.role === "ASSET" &&
            ["证券", "理财"].includes(a.kind),
        )
      ) {
        this.filter({ account_id: undefined });
      } else this.load();
    }
  }
  componentWillUnmount() {
    this.requestVersion++;
    this.drillVersion++;
    this.detailVersion++;
  }
  async load() {
    const version = ++this.requestVersion;
    this.drillVersion++;
    this.detailVersion++;
    this.setState({
      loading: true,
      drillReport: undefined,
      drillLoading: ["account", "period"].includes(this.state.drilldown?.level),
    });
    try {
      const report = await this.api.request(
        "/reports/investments?" +
          this.api.query({ ...this.state.filters, grain: this.state.grain }),
      );
      if (version === this.requestVersion)
        this.setState({ report, loading: false }, () => {
          if (this.state.drilldown?.level === "account")
            this.loadDrilldown(this.state.drilldown);
          else if (this.state.drilldown?.level === "period")
            this.setState({ drillReport: report, drillLoading: false });
        });
    } catch (error) {
      if (version === this.requestVersion) {
        this.setState({ loading: false, drillLoading: false });
        message.error(
          error instanceof Error ? error.message : "理财收益分析加载失败",
        );
      }
    }
  }
  changeScope(patch: Partial<State>) {
    this.requestVersion++;
    this.drillVersion++;
    this.detailVersion++;
    this.setState(
      (state) => ({
        ...state,
        ...patch,
        report: undefined,
        loading: true,
        drilldown: undefined,
        drillBack: undefined,
        drillReport: undefined,
        drillLoading: false,
        drillError: undefined,
        drillPeriod: undefined,
      }),
      () => this.load(),
    );
  }
  filter(patch: Row) {
    this.changeScope({ filters: { ...this.state.filters, ...patch } });
  }
  async detail(id: number) {
    if (this.state.loading || this.state.drillLoading) return;
    const version = ++this.detailVersion;
    try {
      const row = await this.api.transaction(id);
      if (row && version === this.detailVersion) this.props.onDetail(row);
    } catch (error) {
      if (version === this.detailVersion)
        message.error(
          error instanceof Error ? error.message : "无法查看原交易",
        );
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

  closeDrilldown = () => {
    this.drillVersion++;
    this.detailVersion++;
    this.setState({
      drilldown: undefined,
      drillBack: undefined,
      drillReport: undefined,
      drillLoading: false,
      drillError: undefined,
      drillPeriod: undefined,
    });
  };
  openDrilldown(selection: Row, back?: Row) {
    if (this.state.loading) return;
    this.detailVersion++;
    const version = ++this.drillVersion;
    this.setState(
      {
        drilldown: { ...selection },
        drillBack: back,
        drillReport:
          selection.level === "period" ? this.state.report : undefined,
        drillError: undefined,
        drillPeriod:
          selection.level === "period" ? selection.period : undefined,
        drillLoading: selection.level === "account",
        drillTab: selection.tab || "profit",
      },
      () => {
        if (
          version === this.drillVersion &&
          selection.level === "account" &&
          !this.state.loading
        )
          this.loadDrilldown(selection);
      },
    );
  }
  async loadDrilldown(selection: Row) {
    const version = ++this.drillVersion;
    const { filters, grain, report } = this.state;
    this.setState({ drillLoading: true, drillError: undefined });
    try {
      const detail =
        report?.account_id === selection.account_id
          ? report
          : await this.api.request(
              "/reports/investments?" +
                this.api.query({
                  ...filters,
                  start: filters.start || report?.start,
                  end: filters.end || report?.end,
                  account_id: selection.account_id,
                  grain,
                }),
            );
      if (version === this.drillVersion)
        this.setState({ drillReport: detail, drillLoading: false });
    } catch (error) {
      if (version === this.drillVersion)
        this.setState({
          drillLoading: false,
          drillError:
            error instanceof Error ? error.message : "账户明细加载失败",
        });
    }
  }
  drilldownAccounts(selection = this.state.drilldown): Row[] {
    if (!selection) return [];
    return (this.state.report?.accounts || []).filter((account: Row) => {
      if (selection.account_id !== undefined)
        return account.id === selection.account_id;
      if (selection.group_id !== undefined) {
        const owner = this.props.accounts.find(
          (item) => item.id === account.id,
        );
        const groupId = this.props.groups.some(
          (group) => group.id === owner?.group_id,
        )
          ? owner!.group_id
          : 0;
        if (groupId !== selection.group_id) return false;
      }
      return selection.namespace === "investment:gain"
        ? account.profit > 0
        : selection.namespace === "investment:loss"
          ? account.profit < 0
          : true;
    });
  }
  accountSelection(account: Row, namespace = "investment:asset"): Row {
    const owner = this.props.accounts.find((item) => item.id === account.id);
    return {
      namespace,
      level: "account",
      account_id: account.id,
      group_id: owner?.group_id ?? 0,
      label: account.name,
    };
  }
  accountNames(names: string[]) {
    return names.map((name, index) => {
      const matches = (this.state.report?.accounts || []).filter(
        (account: Row) => account.name === name,
      );
      return (
        <React.Fragment key={`${index}-${name}`}>
          {index > 0 && "、"}
          {matches.length === 1 ? (
            <Button
              type="link"
              size="small"
              onClick={() =>
                this.openDrilldown(
                  this.accountSelection(matches[0]),
                  this.state.drilldown?.level === "account"
                    ? this.state.drillBack
                    : this.state.drilldown,
                )
              }
            >
              {name}
            </Button>
          ) : (
            name
          )}
        </React.Fragment>
      );
    });
  }
  chartPeriod(params: any, report?: Row): string | undefined {
    const axis = params.componentType === "xAxis";
    if (!axis && params.componentType && params.componentType !== "series")
      return;
    const value = axis ? params.value : params.data?.period || params.name;
    return report?.trend?.find((row: Row) => row.period === value)?.period;
  }
  openPeriod(value: unknown, tab: string, report = this.state.report) {
    if (this.state.loading || report !== this.state.report) return;
    const period = ReportDrilldown.period(value, this.state.grain, report);
    if (!period || !report) return;
    this.drillVersion++;
    this.detailVersion++;
    this.setState({
      drilldown: {
        namespace: "investment:asset",
        level: "period",
        label: "当前分析范围",
        period,
        tab,
      },
      drillReport: report,
      drillPeriod: period,
      drillTab: tab,
      drillLoading: false,
      drillError: undefined,
      drillBack: undefined,
    });
  }
  focusDrillPeriod(
    value: unknown,
    tab: string,
    report = this.state.drillReport,
  ) {
    if (
      this.state.loading ||
      this.state.drillLoading ||
      !this.state.drilldown ||
      !report ||
      report !== this.state.drillReport
    )
      return;
    const period = ReportDrilldown.period(value, this.state.grain, report);
    if (period) {
      this.detailVersion++;
      this.setState({ drillPeriod: period, drillTab: tab });
    }
  }
  clearDrillPeriod = () => {
    this.setState({
      drillPeriod: undefined,
      drilldown:
        this.state.drilldown?.level === "period"
          ? { ...this.state.drilldown, period: undefined }
          : this.state.drilldown,
    });
  };
  backDrilldown = () => {
    const { drillBack, drilldown } = this.state;
    if (drillBack) this.openDrilldown(drillBack);
    else if (drilldown?.level === "account") {
      const group = this.props.groups.find(
        (item) => item.id === drilldown.group_id,
      );
      this.openDrilldown({
        namespace: drilldown.namespace,
        level: "group",
        group_id: drilldown.group_id ?? 0,
        direct_group: true,
        label: group?.name || "未分组",
      });
    } else this.closeDrilldown();
  };
  renderDrilldown() {
    const {
      drilldown,
      drillReport,
      drillLoading,
      drillError,
      drillPeriod,
      drillTab,
    } = this.state;
    if (!drilldown) return null;
    const account = drilldown.level === "account";
    const periodOnly = drilldown.level === "period";
    const rows = this.drilldownAccounts();
    const profits = (drillReport?.profits || []).filter((row: Row) =>
      ReportDrilldown.contains(drillPeriod, row.occurred_at),
    );
    const transfers = (drillReport?.transfers || []).filter((row: Row) =>
      ReportDrilldown.contains(drillPeriod, row.occurred_at),
    );
    const reset = JSON.stringify([
      drilldown.namespace,
      drilldown.group_id,
      drilldown.account_id,
      drillPeriod,
      drillReport?.start,
      drillReport?.end,
    ]);
    const point = (params: any) => this.chartPeriod(params, drillReport);
    return (
      <div className="analysis-drilldown-content investment-drilldown">
        <AnalysisDrilldownBar
          label="局部明细"
          items={[
            {
              key: "scope",
              label: drilldown.label || "当前分析范围",
              onClear: this.backDrilldown,
            },
            ...(drillPeriod
              ? [
                  {
                    key: "period",
                    label: `明细时间：${drillPeriod.label}`,
                    onClear: this.clearDrillPeriod,
                  },
                ]
              : []),
          ]}
          onReset={this.closeDrilldown}
          resetLabel="关闭明细"
        />
        <div className="section-top">
          <p className="muted analysis-detail-note">
            主页面的日期、账户与汇总保持当前设置。
            {periodOnly
              ? "仅定位所点时间的盈亏与转账明细。"
              : account
                ? "趋势与资金明细按该账户及原分析区间读取。"
                : "当前节点对应的直属账户在此列出，点击账户查看其趋势与资金明细。"}
          </p>
          <Button onClick={this.backDrilldown}>
            {account ? "返回账户列表" : "返回当前分析"}
          </Button>
        </div>
        {!account && !periodOnly ? (
          <>
            <p className="muted">
              {drilldown.namespace === "investment:gain"
                ? "仅列区间净收益为正的账户。"
                : drilldown.namespace === "investment:loss"
                  ? "仅列区间净收益为负的账户。"
                  : "包含负余额与零余额账户，保留原账面口径。"}
            </p>
            <PagedTable<Row>
              rowKey="id"
              dataSource={rows}
              pageResetKey={reset}
              defaultPageSize={10}
              columns={[
                {
                  title: "账户",
                  render: (_, row) => (
                    <Button
                      type="link"
                      size="small"
                      onClick={() =>
                        this.openDrilldown(
                          this.accountSelection(row, drilldown.namespace),
                          drilldown,
                        )
                      }
                    >
                      {row.name}
                    </Button>
                  ),
                },
                this.amount("期末资产（元）", "ending"),
                this.amount("净收益（元）", "profit"),
                this.amount("本金净转入（元）", "capital_net"),
              ]}
            />
            <p className="muted">
              {rows.length} 个账户 · 期末资产 ¥{" "}
              {Money.format(rows.reduce((sum, row) => sum + row.ending, 0))} ·
              净收益 ¥{" "}
              {Money.format(rows.reduce((sum, row) => sum + row.profit, 0))}
            </p>
          </>
        ) : (
          <Spin spinning={!!drillLoading}>
            {drillError ? (
              <Alert
                type="error"
                showIcon
                message={drillError}
                action={
                  <Button onClick={() => this.loadDrilldown(drilldown)}>
                    重试
                  </Button>
                }
              />
            ) : !drillReport ? (
              <Card loading={!!drillLoading}>
                <Empty description="暂无该账户的明细" />
              </Card>
            ) : (
              <>
                {account && (
                  <>
                    <div className="metrics analysis-metrics">
                      {[
                        ["期末资产", "ending"],
                        ["净收益", "profit"],
                        ["估值盈亏", "valuation_profit"],
                        ["本金净转入", "capital_net"],
                      ].map(([label, key]) => (
                        <div className="metric" key={key}>
                          <span>{label}</span>
                          <strong>¥ {Money.format(drillReport[key])}</strong>
                        </div>
                      ))}
                    </div>
                    <div className="investment-charts mb">
                      <Card
                        title="账户盈亏趋势（元）"
                        extra={
                          <small className="muted">
                            点击柱子查看该期盈亏明细
                          </small>
                        }
                      >
                        <Chart
                          label="账户盈亏趋势，点击查看该期明细"
                          onClick={(params) =>
                            this.focusDrillPeriod(
                              point(params),
                              "profit",
                              drillReport,
                            )
                          }
                          option={{
                            tooltip: {
                              trigger: "axis",
                              renderMode: "richText",
                            },
                            grid: { left: 65, right: 25, top: 20, bottom: 40 },
                            xAxis: {
                              type: "category",
                              triggerEvent: true,
                              data: drillReport.trend.map(
                                (row: Row) => row.period,
                              ),
                            },
                            yAxis: { type: "value" },
                            series: [
                              {
                                name: "期间盈亏",
                                type: "bar",
                                data: drillReport.trend.map((row: Row) => ({
                                  value: row.profit / 100,
                                  period: row.period,
                                  itemStyle: {
                                    color:
                                      row.profit >= 0 ? "#73a58f" : "#b78863",
                                  },
                                })),
                              },
                            ],
                          }}
                        />
                      </Card>
                      <Card title="账户资产趋势（元）">
                        <Chart
                          label="账户资产趋势，点击查看该期资金明细"
                          onClick={(params) =>
                            this.focusDrillPeriod(
                              point(params),
                              "capital",
                              drillReport,
                            )
                          }
                          option={{
                            tooltip: {
                              trigger: "axis",
                              renderMode: "richText",
                            },
                            grid: { left: 65, right: 25, top: 20, bottom: 40 },
                            xAxis: {
                              type: "category",
                              triggerEvent: true,
                              data: drillReport.trend.map(
                                (row: Row) => row.period,
                              ),
                            },
                            yAxis: { type: "value" },
                            series: [
                              {
                                name: "期末资产",
                                type: "line",
                                itemStyle: { color: "#73a58f" },
                                data: drillReport.trend.map((row: Row) => ({
                                  value: row.assets / 100,
                                  period: row.period,
                                })),
                              },
                            ],
                          }}
                        />
                      </Card>
                    </div>
                  </>
                )}
                <Card
                  title="盈亏与资金明细"
                  extra={
                    drillPeriod && (
                      <Button size="small" onClick={this.clearDrillPeriod}>
                        清除明细时间
                      </Button>
                    )
                  }
                >
                  <Tabs
                    activeKey={drillTab || "profit"}
                    onChange={(drillTab) => this.setState({ drillTab })}
                    items={[
                      {
                        key: "profit",
                        label: `投资盈亏（${profits.length}）`,
                        children: (
                          <PagedTable<Row>
                            rowKey="id"
                            dataSource={profits}
                            defaultPageSize={10}
                            pageResetKey={reset}
                            scroll={{ x: 640 }}
                            columns={[
                              { title: "时间", dataIndex: "occurred_at" },
                              {
                                title: "账户",
                                render: (_, row) =>
                                  this.accountNames(row.account_names),
                              },
                              {
                                title: "类型",
                                render: (_, row) =>
                                  row.valuation ? "估值盈亏" : "其他收益/费用",
                              },
                              this.amount("盈亏（元）", "amount"),
                              {
                                title: "说明",
                                render: (_, row) =>
                                  row.counterparty || row.note || "—",
                              },
                              {
                                title: "操作",
                                render: (_, row) => (
                                  <Button
                                    type="link"
                                    size="small"
                                    onClick={() => this.detail(row.id)}
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
                        label: `资金转账（${transfers.length}）`,
                        children: (
                          <PagedTable<Row>
                            rowKey="id"
                            dataSource={transfers}
                            defaultPageSize={10}
                            pageResetKey={reset}
                            scroll={{ x: 720 }}
                            columns={[
                              { title: "时间", dataIndex: "occurred_at" },
                              {
                                title: "转出账户",
                                render: (_, row) =>
                                  this.accountNames(row.from_accounts),
                              },
                              {
                                title: "转入账户",
                                render: (_, row) =>
                                  this.accountNames(row.to_accounts),
                              },
                              this.amount("转账金额（元）", "amount"),
                              this.amount(
                                "所选理财资产变动",
                                "scope_change",
                                150,
                              ),
                              {
                                title: "操作",
                                render: (_, row) => (
                                  <Button
                                    type="link"
                                    size="small"
                                    onClick={() => this.detail(row.id)}
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
              </>
            )}
          </Spin>
        )}
      </div>
    );
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
    return (
      <div className="investment-workspace">
        <div className="section-top">
          <div>
            <p className="muted">
              先看期末资产，再分开核对期间盈亏与本金进出。
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
              { value: "all", label: "全部理财账户" },
              ...choices.map((a) => ({
                value: a.id,
                label: a.name + (a.active ? "" : "（停用）"),
              })),
            ]}
            onChange={(value) =>
              this.filter({ account_id: value === "all" ? undefined : value })
            }
          />
          <ReportPeriodFilter
            refreshKey={this.props.refreshKey}
            filters={filters}
            label="理财分析日期"
            onChange={(patch) => this.filter(patch)}
          />
          <Select
            aria-label="理财趋势粒度"
            value={grain}
            style={{ width: 115 }}
            options={[
              { value: "month", label: "按月" },
              { value: "day", label: "按日" },
            ]}
            onChange={(grain) => this.changeScope({ grain })}
          />
          <Button
            onClick={() =>
              this.changeScope({ filters: ReportPeriodFilter.defaults() })
            }
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
                  <Empty description="暂无理财账户，可在账户管理中添加证券或理财类型的账户" />
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
                      {selected
                        ? `${selected.name} · 资产与收益`
                        : "整体资产与收益"}
                    </h3>
                    {selected && (
                      <Button
                        onClick={() => this.filter({ account_id: undefined })}
                      >
                        查看全部账户
                      </Button>
                    )}
                  </div>
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
                      <span>期末理财资产</span>
                      <strong data-testid="investment-assets">
                        {report.asset_account_count
                          ? `¥ ${Money.format(report.ending)}`
                          : "—"}
                      </strong>
                      <small>
                        截至 {report.end} · {report.asset_account_count} 个账户
                      </small>
                    </div>
                    <div className="metric featured">
                      <span>期间净收益</span>
                      <strong data-testid="investment-profit">
                        ¥ {Money.format(report.profit)}
                      </strong>
                      <small>
                        收益 ¥ {Money.format(report.gain)} · 亏损/费用 ¥{" "}
                        {Money.format(report.loss)}
                      </small>
                    </div>
                    <div className="metric">
                      <span>期间估值盈亏</span>
                      <strong data-testid="investment-valuation">
                        ¥ {Money.format(report.valuation_profit)}
                      </strong>
                      <small>
                        其他收益/费用净额 ¥ {Money.format(report.other_profit)}
                      </small>
                    </div>
                    <div className="metric">
                      <span>期间本金净转入</span>
                      <strong data-testid="investment-capital">
                        ¥ {Money.format(report.capital_net)}
                      </strong>
                      <small>
                        银行等转入 ¥ {Money.format(report.capital_in)} · 转出 ¥{" "}
                        {Money.format(report.capital_out)}
                      </small>
                    </div>
                  </div>

                  <InvestmentFlows
                    report={report}
                    accounts={this.props.accounts}
                    groups={this.props.groups}
                    onSelect={(selection) => this.openDrilldown(selection)}
                  />
                  <p className="muted analysis-detail-note">
                    先读每期盈亏与区间累计，再看资产余额轨迹；点击时间点查看对应盈亏或资金明细。
                  </p>
                  <div className="investment-charts mb">
                    <Card
                      title="盈亏趋势（元）"
                      extra={
                        <small className="muted">
                          点击柱子查看该期盈亏明细
                        </small>
                      }
                    >
                      <Chart
                        label="理财收益趋势"
                        onClick={(params) =>
                          this.openPeriod(
                            this.chartPeriod(params, report),
                            "profit",
                            report,
                          )
                        }
                        option={{
                          tooltip: { trigger: "axis", renderMode: "richText" },
                          legend: { bottom: 0 },
                          grid: { left: 65, right: 25, top: 20, bottom: 60 },
                          xAxis: {
                            type: "category",
                            triggerEvent: true,
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
                                period: r.period,
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
                              data: report.trend.map((r: Row) => ({
                                value: r.cumulative_profit / 100,
                                period: r.period,
                              })),
                            },
                          ],
                        }}
                      />
                    </Card>
                    <Card title="资产余额轨迹（元）">
                      <Chart
                        label="理财资产趋势"
                        onClick={(params) =>
                          this.openPeriod(
                            this.chartPeriod(params, report),
                            "capital",
                            report,
                          )
                        }
                        option={{
                          tooltip: {
                            trigger: "axis",
                            renderMode: "richText",
                          },
                          grid: { left: 75, right: 25, top: 20, bottom: 60 },
                          xAxis: {
                            type: "category",
                            triggerEvent: true,
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
                              data: report.trend.map((r: Row) => ({
                                value: r.assets / 100,
                                period: r.period,
                              })),
                            },
                          ],
                        }}
                      />
                    </Card>
                  </div>
                  <Card
                    className="mb"
                    title="各账户情况（元）"
                    extra={
                      <small className="muted">
                        点击账户查看趋势与资金明细 · 合并来源只统计一次
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
                                  this.openDrilldown(this.accountSelection(row))
                                }
                              >
                                {text}
                              </Button>{" "}
                              {!row.active && <Tag>停用</Tag>}
                            </>
                          ),
                        },
                        {
                          title: "账户类型",
                          width: 110,
                          render: (_, row) => <Tag>{row.kind}</Tag>,
                        },
                        this.amount("期间净收益", "profit"),
                        this.amount("期间盈利合计", "gain"),
                        this.amount("期间亏损/费用", "loss", 140),
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
                                  render: (_, r) =>
                                    this.accountNames(r.account_names),
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
                                  render: (_, r) =>
                                    this.accountNames(r.from_accounts),
                                },
                                {
                                  title: "转入账户",
                                  render: (_, r) =>
                                    this.accountNames(r.to_accounts),
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
                  <details className="analysis-method">
                    <summary>统计口径与读图说明</summary>
                    <p>
                      统计证券、理财类型资产账户，合并后按目标账户身份计算。期末资产包含期初、本金及已记账损益；银行等账户与理财账户间的转账列为本金进出，理财账户互转在整体范围相抵。
                    </p>
                    <p>
                      盈亏趋势反映期间入账损益，资产趋势反映余额。估值按已记录的余额更新计算；点击图表或账户可打开局部明细核对。
                    </p>
                  </details>
                </>
              )}
            </Spin>
          )
        )}
        <Drawer
          title="理财局部明细"
          width={1000}
          zIndex={900}
          open={!!this.state.drilldown}
          onClose={this.closeDrilldown}
        >
          {this.renderDrilldown()}
        </Drawer>
      </div>
    );
  }
}
