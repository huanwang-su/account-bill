import { ReportPeriodFilter } from "./ReportPeriodFilter";
import React from "react";
import {
  Button,
  Card,
  Drawer,
  Empty,
  Input,
  Select,
  Space,
  Spin,
  Tag,
  message,
} from "antd";
import { LedgerApi, MoneyFormatter as Money, Row } from "./api";
import { Chart } from "./Chart";
import { PagedTable } from "./PagedTable";
import { AnalysisDrilldownBar } from "./AnalysisDrilldown";

import { PartyReadoutData } from "./AccountReadoutData";
import { PartyMovement } from "./SingleAccountDrilldown";

interface Props {
  accounts: Row[];
  initialAccountId?: number;
  refreshKey: string;
  onDetail: (row: Row) => void;
  onValuation: (account: Row) => void;
}
type MovementDirection = "incoming" | "outgoing";

interface State {
  accountId?: number;
  filters: Row;
  query: string;
  report?: Row;
  history: Row[];
  selected?: Row;
  selectedDay?: string;
  selectedDirection?: MovementDirection;
  reportScope?: { accountId: number; filters: Row };
  loading: boolean;
}

export class CounterpartyWorkspace extends React.Component<Props, State> {
  api = new LedgerApi();
  requestVersion = 0;
  detailVersion = 0;
  state: State = {
    accountId: this.props.initialAccountId,
    filters: ReportPeriodFilter.defaults(),
    query: "",
    history: [],
    loading: false,
  };
  componentDidMount() {
    this.load();
  }
  componentDidUpdate(previous: Props) {
    if (previous.initialAccountId !== this.props.initialAccountId)
      this.setState(
        {
          accountId: this.props.initialAccountId,
          report: undefined,
          selected: undefined,
          selectedDay: undefined,
          selectedDirection: undefined,
          history: [],
        },
        () => this.load(),
      );
    else if (previous.refreshKey !== this.props.refreshKey) this.load();
  }
  componentWillUnmount() {
    this.requestVersion++;
    this.detailVersion++;
  }
  async load() {
    const version = ++this.requestVersion;
    this.detailVersion++;
    const accountId = this.state.accountId;
    if (!accountId) {
      this.setState({ loading: false });
      return;
    }
    const filters = { ...this.state.filters };
    this.setState({ loading: true });
    try {
      const account = this.props.accounts.find((a) => a.id === accountId);
      const [report, history] = await Promise.all([
        this.api.request(
          "/reports/counterparties?" +
            this.api.query({ account_id: accountId, ...filters }),
        ),
        account?.kind === "证券"
          ? this.api.request(`/accounts/${accountId}/valuations`)
          : Promise.resolve([]),
      ]);
      if (version === this.requestVersion)
        this.setState((state) => {
          const selected = state.selected?.aggregate
            ? PartyMovement.all(report)
            : [...(report.parties || []), ...(report.valuations || [])].find(
                (row: Row) => row.key === state.selected?.key,
              );
          return {
            report,
            history,
            loading: false,
            reportScope: { accountId, filters },
            selected,
            selectedDay: selected ? state.selectedDay : undefined,
            selectedDirection: selected ? state.selectedDirection : undefined,
          };
        });
    } catch (error) {
      if (version === this.requestVersion) {
        this.setState({ loading: false });
        message.error(
          error instanceof Error ? error.message : "交易方分析加载失败",
        );
      }
    }
  }
  filter(patch: Row) {
    this.setState(
      {
        filters: { ...this.state.filters, ...patch },
        report: undefined,
        selected: undefined,
        selectedDay: undefined,
        selectedDirection: undefined,
      },
      () => this.load(),
    );
  }
  openParty(
    selected: Row,
    selectedDay?: string,
    selectedDirection?: MovementDirection,
  ) {
    if (!this.state.loading)
      this.setState({ selected, selectedDay, selectedDirection });
  }
  closeParty = () => {
    this.detailVersion++;
    this.setState({
      selected: undefined,
      selectedDay: undefined,
      selectedDirection: undefined,
    });
  };
  selectedRows(): Row[] {
    const { selected, selectedDay, selectedDirection, loading } = this.state;
    if (loading) return [];
    return (selected?.transactions || []).filter(
      (row: Row) =>
        (!selectedDay || row.occurred_at.slice(0, 10) === selectedDay) &&
        (!selectedDirection ||
          (selectedDirection === "incoming"
            ? row.account_change > 0
            : row.account_change < 0)),
    );
  }
  movementDirection(params: any): MovementDirection | undefined {
    const direction = params.data?.direction || params.seriesId;
    if (direction === "incoming" || direction === "outgoing") return direction;
    if (["收款", "估值收益"].includes(params.seriesName)) return "incoming";
    if (["付款", "估值亏损"].includes(params.seriesName)) return "outgoing";
  }
  directionLabel(direction: MovementDirection, valuation = false) {
    if (valuation)
      return direction === "incoming" ? "仅估值收益" : "仅估值亏损";
    return direction === "incoming" ? "仅收款" : "仅付款";
  }
  scopeLabel() {
    const filters = this.state.reportScope?.filters || this.state.filters;
    if (!filters.start && !filters.end) return "全部历史";
    return `${filters.start || "最早记录"} 至 ${filters.end || "最近记录"}`;
  }
  movementChart(
    rows: Row[],
    label: string,
    onDay: (day: string, direction?: MovementDirection) => void,
    valuation = false,
  ) {
    const report = this.state.report;
    const selected = this.state.selected;
    const trend = PartyMovement.daily(rows);
    if (!trend.length) return <Empty description="当前范围没有账户变动" />;
    return (
      <Chart
        label={label}
        style={{ height: 250 }}
        option={{
          tooltip: {
            trigger: "axis",
            renderMode: "richText",
            valueFormatter: (value: any) =>
              "¥ " + Money.format(Math.round(Math.abs(Number(value)) * 100)),
          },
          legend: { bottom: 0 },
          grid: { left: 75, right: 25, top: 20, bottom: 65 },
          xAxis: {
            type: "category",
            data: trend.map((row) => row.day),
            triggerEvent: true,
          },
          yAxis: { type: "value", name: "元" },
          series: [
            {
              id: "incoming",
              name: valuation ? "估值收益" : "收款",
              type: "bar",
              stack: "movements",
              barMaxWidth: 24,
              data: trend.map((row) => ({
                value: row.incoming / 100,
                day: row.day,
                direction: "incoming",
              })),
              itemStyle: { color: "#73a58f" },
            },
            {
              id: "outgoing",
              name: valuation ? "估值亏损" : "付款",
              type: "bar",
              stack: "movements",
              barMaxWidth: 24,
              data: trend.map((row) => ({
                value: -row.outgoing / 100,
                day: row.day,
                direction: "outgoing",
              })),
              itemStyle: { color: "#b78863" },
            },
          ],
        }}
        onClick={(params) => {
          if (
            this.state.loading ||
            this.state.report !== report ||
            this.state.selected !== selected
          )
            return;
          const axis = params.componentType === "xAxis";
          if (
            !axis &&
            params.componentType &&
            params.componentType !== "series"
          )
            return;
          const key = axis ? params.value : params.data?.day || params.name;
          const day = trend.find((row) => row.day === key)?.day;
          const direction = axis ? undefined : this.movementDirection(params);
          if (day && (axis || direction)) onDay(day, direction);
        }}
      />
    );
  }
  async valuationDetail(id: number) {
    const version = ++this.detailVersion;
    if (this.state.loading) return;
    try {
      const row = await this.api.transaction(id);
      if (row && version === this.detailVersion) this.props.onDetail(row);
    } catch (error) {
      if (version === this.detailVersion)
        message.error(error instanceof Error ? error.message : "无法查看交易");
    }
  }
  partyTable(rows: Row[], valuation = false) {
    return (
      <PagedTable<Row>
        className={
          valuation ? "counterparty-valuation-table" : "counterparty-table"
        }
        rowKey="key"
        dataSource={valuation ? rows : PartyReadoutData.rank(rows)}
        defaultPageSize={10}
        pageResetKey={JSON.stringify([
          this.state.accountId,
          this.state.filters,
        ])}
        columns={[
          {
            title: valuation ? "估值项目" : "交易方",
            dataIndex: "counterparty",
            render: (text, row) => (
              <Button
                type="link"
                size="small"
                disabled={this.state.loading}
                onClick={() => this.openParty(row)}
              >
                {text}
              </Button>
            ),
          },
          {
            title: valuation ? "累计收益" : "累计收款",
            dataIndex: "incoming",
            align: "right",
            sorter: (a, b) => a.incoming - b.incoming,
            render: (value) => Money.format(value),
          },
          {
            title: valuation ? "累计亏损" : "累计付款",
            dataIndex: "outgoing",
            align: "right",
            sorter: (a, b) => a.outgoing - b.outgoing,
            render: (value) => Money.format(value),
          },
          {
            title: valuation ? "估值盈亏" : "累计净额",
            dataIndex: "net",
            align: "right",
            sorter: (a, b) => a.net - b.net,
            render: (value) => (
              <span className={value > 0 ? "income" : ""}>
                {Money.format(value)}
              </span>
            ),
          },
          ...(!valuation
            ? [
                {
                  title: "收付合计",
                  key: "gross",
                  align: "right" as const,
                  sorter: (a: Row, b: Row) =>
                    PartyReadoutData.gross(a) - PartyReadoutData.gross(b),
                  render: (_: unknown, row: Row) =>
                    Money.format(PartyReadoutData.gross(row)),
                },
              ]
            : []),
          {
            title: "交易数",
            dataIndex: "count",
            width: 85,
            sorter: (a, b) => a.count - b.count,
          },
          {
            title: "首次 / 最近交易",
            render: (_, row) => (
              <small>
                {row.first_at.slice(0, 10)}
                <br />
                {row.last_at.slice(0, 10)}
              </small>
            ),
          },
        ]}
      />
    );
  }

  render() {
    const { report, selected, accountId, filters, query, history, loading } =
      this.state;
    const accounts = this.props.accounts.filter(
      (a) => !a.merged_into_id && ["ASSET", "LIABILITY"].includes(a.role),
    );
    const account = accounts.find((a) => a.id === accountId);
    const ranked: Row[] = PartyReadoutData.rank(report?.parties || [])
      .slice(0, 10)
      .reverse();
    const rankedByKey = new Map<string, Row>(
      ranked.map((party): [string, Row] => [String(party.key), party]),
    );
    const all = report ? PartyMovement.all(report) : undefined;
    const selectedRows = this.selectedRows();
    const selectedTotals = PartyMovement.summary(selectedRows);
    return (
      <div className="counterparty-workspace">
        <div className="section-top">
          <div>
            <p className="muted">
              按同名交易方汇总资金往来，查看累计净额、交易数及每次收付。
            </p>
          </div>
          {account?.kind === "证券" && account.active && (
            <Button onClick={() => this.props.onValuation(account)}>
              更新证券余额
            </Button>
          )}
        </div>
        <div className="filters">
          <Select
            aria-label="交易方分析账户"
            placeholder="请选择账户"
            showSearch
            optionFilterProp="label"
            style={{ width: 250 }}
            value={accountId}
            options={accounts.map((a) => ({
              value: a.id,
              label: a.name + (a.active ? "" : "（停用）"),
            }))}
            onChange={(accountId) =>
              this.setState(
                {
                  accountId,
                  report: undefined,
                  history: [],
                  selected: undefined,
                  selectedDay: undefined,
                  selectedDirection: undefined,
                },
                () => this.load(),
              )
            }
          />
          <ReportPeriodFilter
            refreshKey={this.props.refreshKey}
            filters={filters}
            label="交易方分析日期"
            onChange={(patch) => this.filter(patch)}
          />
          <Input.Search
            aria-label="搜索交易方"
            placeholder="搜索交易方"
            allowClear
            style={{ width: 230 }}
            value={query}
            onChange={(event) => {
              const query = event.target.value;
              this.setState({ query });
              if (!query) this.filter({ q: undefined });
            }}
            onSearch={() => this.filter({ q: query.trim() || undefined })}
          />
          <Button
            onClick={() =>
              this.setState(
                {
                  filters: ReportPeriodFilter.defaults(),
                  report: undefined,
                  query: "",
                  selected: undefined,
                  selectedDay: undefined,
                  selectedDirection: undefined,
                },
                () => this.load(),
              )
            }
          >
            重置筛选
          </Button>
        </div>
        {report && (
          <p className="muted analysis-note">
            当前统计：{report.account_name} · {this.scopeLabel()}
            {this.state.reportScope?.filters.q
              ? ` · 交易方包含“${this.state.reportScope.filters.q}”`
              : ""}
            。账户收付包含退款和内部转账，证券估值单列。
          </p>
        )}
        {!accountId ? (
          <Card>
            <Empty description="选择一个账户，分析与各交易方的收付往来" />
          </Card>
        ) : !report && loading ? (
          <Card loading />
        ) : (
          report && (
            <Spin spinning={loading}>
              <div className="metrics analysis-metrics">
                <div className="metric">
                  <span>累计收款</span>
                  <strong className="income" data-testid="party-incoming">
                    ¥ {Money.format(report.incoming)}
                  </strong>
                  <small>含退款、转入</small>
                </div>
                <div className="metric">
                  <span>累计付款</span>
                  <strong data-testid="party-outgoing">
                    ¥ {Money.format(report.outgoing)}
                  </strong>
                  <small>含支出、转出</small>
                </div>
                <div className="metric featured">
                  <span>累计净额</span>
                  <strong data-testid="party-net">
                    ¥ {Money.format(report.net)}
                  </strong>
                  <small>收款 − 付款，证券估值另列</small>
                </div>
                <div className="metric">
                  <span>交易方 / 交易数</span>
                  <strong data-testid="party-count">
                    {report.party_count} / {report.count}
                  </strong>
                  <small>每笔交易只计一次</small>
                </div>
              </div>

              <Card
                className="mb"
                title="交易方资金往来（元）"
                extra={
                  <small className="muted">
                    默认按收付合计排序，点击名称查看明细
                  </small>
                }
              >
                {this.partyTable(report.parties)}
              </Card>
              <div className="counterparty-charts mb">
                <Card title="收付规模 · 前 10 位">
                  {ranked.length ? (
                    <Chart
                      label="交易方收付规模排行"
                      option={{
                        tooltip: {
                          trigger: "axis",
                          renderMode: "richText",
                          formatter: (params: any) => {
                            const items = Array.isArray(params)
                              ? params
                              : [params];
                            const party = rankedByKey.get(
                              String(items[0]?.axisValue || items[0]?.name),
                            );
                            return [
                              party?.counterparty || "",
                              ...items.map(
                                (item) =>
                                  `${item.seriesName}：¥ ${Money.format(Math.round(Math.abs(Number(item.value)) * 100))}`,
                              ),
                            ].join("\n");
                          },
                        },
                        legend: { bottom: 0 },
                        grid: { left: 140, right: 35, top: 20, bottom: 55 },
                        xAxis: { type: "value", name: "元" },
                        yAxis: {
                          type: "category",
                          data: ranked.map((r) => String(r.key)),
                          triggerEvent: true,
                          axisLabel: {
                            width: 120,
                            overflow: "truncate",
                            formatter: (value: string) =>
                              rankedByKey.get(value)?.counterparty || "",
                          },
                          axisPointer: {
                            label: {
                              formatter: (params: any) =>
                                rankedByKey.get(String(params.value))
                                  ?.counterparty || "",
                            },
                          },
                        },
                        series: [
                          {
                            id: "incoming",
                            name: "收款",
                            type: "bar",
                            stack: "party-movements",
                            data: ranked.map((r) => r.incoming / 100),
                            itemStyle: { color: "#73a58f" },
                          },
                          {
                            id: "outgoing",
                            name: "付款",
                            type: "bar",
                            stack: "party-movements",
                            data: ranked.map((r) => -r.outgoing / 100),
                            itemStyle: { color: "#b78863" },
                          },
                        ],
                      }}
                      onClick={(params) => {
                        if (
                          loading ||
                          this.state.loading ||
                          this.state.report !== report
                        )
                          return;
                        const axis = params.componentType === "yAxis";
                        if (
                          !axis &&
                          params.componentType &&
                          params.componentType !== "series"
                        )
                          return;
                        const row = rankedByKey.get(
                          String(
                            axis
                              ? params.value
                              : params.data?.partyKey || params.name,
                          ),
                        );
                        const direction = axis
                          ? undefined
                          : this.movementDirection(params);
                        if (row && (axis || direction))
                          this.openParty(row, undefined, direction);
                      }}
                    />
                  ) : (
                    <Empty description="当前条件没有交易方往来" />
                  )}
                  <p className="muted analysis-note">
                    按收款＋付款合计取前10位；付款向左、收款向右。点击柱子查看该交易方对应方向的明细，点击名称查看全部收付。
                  </p>
                </Card>
                <Card title="证券估值盈亏（元）">
                  <div className="counterparty-valuation-summary">
                    <span>
                      累计收益{" "}
                      <b data-testid="valuation-gain">
                        ¥ {Money.format(report.valuation_gain)}
                      </b>
                    </span>
                    <span>
                      累计亏损 <b>¥ {Money.format(report.valuation_loss)}</b>
                    </span>
                    <span>
                      净盈亏{" "}
                      <b data-testid="valuation-net">
                        ¥ {Money.format(report.valuation_net)}
                      </b>
                    </span>
                  </div>
                  {this.partyTable(report.valuations, true)}
                </Card>
              </div>
              <Card
                className="mb counterparty-trend-card"
                title="每日收付趋势"
                extra={
                  <small className="muted">
                    点击柱子查看当天对应收付，点击日期查看当天全部收付
                  </small>
                }
              >
                {this.movementChart(
                  all!.transactions,
                  "交易方每日收付趋势",
                  (day, direction) => this.openParty(all!, day, direction),
                )}
                <p className="muted analysis-note">
                  显示所选区间内有交易的日期；收款向上、付款向下，含退款和内部转账，不含证券估值。
                </p>
              </Card>
              {account?.kind === "证券" && (
                <Card
                  className="mb"
                  title="证券余额更新历史"
                  extra={
                    <small className="muted">
                      以下为全部历史，不受日期与交易方搜索影响
                    </small>
                  }
                >
                  <PagedTable<Row>
                    rowKey="id"
                    className="securities-history-table"
                    dataSource={history}
                    defaultPageSize={10}
                    pageResetKey={String(accountId)}
                    columns={[
                      { title: "更新时间", dataIndex: "occurred_at" },
                      {
                        title: "更新前余额",
                        dataIndex: "calculated",
                        align: "right",
                        render: (v) => Money.format(v),
                      },
                      {
                        title: "新余额",
                        dataIndex: "actual",
                        align: "right",
                        render: (v) => Money.format(v),
                      },
                      {
                        title: "盈亏",
                        dataIndex: "change",
                        align: "right",
                        render: (v, r) =>
                          r.baseline ? "期初基准" : Money.format(v),
                      },
                      {
                        title: "状态",
                        render: (_, r) => (
                          <Tag>
                            {r.status === "REVERSED"
                              ? "已撤销"
                              : r.baseline
                                ? "期初"
                                : r.transaction_id
                                  ? "已入账"
                                  : "余额未变"}
                          </Tag>
                        ),
                      },
                      {
                        title: "交易",
                        render: (_, r) =>
                          r.transaction_id ? (
                            <Button
                              type="link"
                              size="small"
                              onClick={() =>
                                this.valuationDetail(r.transaction_id)
                              }
                            >
                              查看
                            </Button>
                          ) : (
                            "—"
                          ),
                      },
                    ]}
                  />
                </Card>
              )}
              <p className="muted analysis-note">
                累计净额是该账户的收款减付款，包含退款与转账，表示资金往来差额，不等同于投资收益。证券估值变动单列；期初、撤销和合并账户内部抵消的变动不计入。相同交易方名称合并统计，不自动猜测不同名称是否为同一人。
              </p>
            </Spin>
          )
        )}
        <Drawer
          open={!!selected}
          title={`${selected?.counterparty || ""} · ${selected?.valuation ? "估值盈亏明细" : "收付明细"}`}
          onClose={this.closeParty}
          width={950}
          zIndex={900}
          destroyOnHidden
        >
          {selected && (
            <Spin spinning={loading}>
              <p className="muted analysis-note">
                {report?.account_name} · {this.scopeLabel()}
                。下方趋势保留完整区间，点击柱子按日期及收付方向查看明细。
              </p>
              <AnalysisDrilldownBar
                label="当前明细范围"
                items={[
                  ...(this.state.selectedDay
                    ? [
                        {
                          key: "day",
                          label: this.state.selectedDay,
                          onClear: () =>
                            this.setState({ selectedDay: undefined }),
                        },
                      ]
                    : []),
                  ...(this.state.selectedDirection
                    ? [
                        {
                          key: "direction",
                          label: this.directionLabel(
                            this.state.selectedDirection,
                            selected.valuation,
                          ),
                          onClear: () =>
                            this.setState({ selectedDirection: undefined }),
                        },
                      ]
                    : []),
                ]}
                onReset={() =>
                  this.setState({
                    selectedDay: undefined,
                    selectedDirection: undefined,
                  })
                }
                resetLabel="返回完整区间"
                emptyText={
                  selected.aggregate
                    ? "展示全部交易方在所选区间的记录，点击趋势可按日查看。"
                    : "展示该交易方在所选区间的全部记录，点击趋势可按日查看。"
                }
              />
              <Space size="large" wrap>
                <span>
                  {selected.valuation ? "估值收益" : "收款"} ¥{" "}
                  {Money.format(selectedTotals.incoming)}
                </span>
                <span>
                  {selected.valuation ? "估值亏损" : "付款"} ¥{" "}
                  {Money.format(selectedTotals.outgoing)}
                </span>
                <span>
                  {selected.valuation ? "净盈亏" : "净额"} ¥{" "}
                  {Money.format(selectedTotals.net)}
                </span>
                <span>{selectedTotals.count} 笔</span>
              </Space>
              {this.movementChart(
                selected.transactions,
                selected.counterparty +
                  (selected.valuation ? "每日估值盈亏" : "每日收付"),
                (day, direction) =>
                  this.setState({
                    selectedDay: day,
                    selectedDirection: direction,
                  }),
                selected.valuation,
              )}
              <p className="muted analysis-note">
                {selected.valuation
                  ? "以下金额为证券估值变动，不作为现金收款或付款。"
                  : "以下金额为该账户每笔交易的完整余额变化，含退款及内部转账；不等同于生活收支或投资收益。"}
              </p>
              <PagedTable<Row>
                className="counterparty-detail-table mt"
                rowKey="id"
                dataSource={selectedRows}
                defaultPageSize={10}
                pageResetKey={JSON.stringify([
                  accountId,
                  this.state.reportScope?.filters,
                  selected.key,
                  this.state.selectedDay,
                  this.state.selectedDirection,
                ])}
                columns={[
                  { title: "时间", dataIndex: "occurred_at" },
                  { title: "说明", dataIndex: "note" },
                  {
                    title: selected.valuation
                      ? "估值变动（元）"
                      : "账户收付（元）",
                    dataIndex: "account_change",
                    align: "right",
                    render: (v) => `${v > 0 ? "+" : ""}${Money.format(v)}`,
                  },
                  {
                    title: "类型",
                    render: (_, r) =>
                      selected.valuation
                        ? "证券估值"
                        : (
                            {
                              INCOME: "收入",
                              EXPENSE: "支出",
                              TRANSFER: "内部转账",
                              REFUND: "退款",
                            } as Row
                          )[r.kind] || r.kind,
                  },
                  {
                    title: "操作",
                    render: (_, r) => (
                      <Button
                        type="link"
                        size="small"
                        disabled={loading}
                        onClick={() => {
                          if (!this.state.loading) this.props.onDetail(r);
                        }}
                      >
                        查看交易
                      </Button>
                    ),
                  },
                ]}
              />
            </Spin>
          )}
        </Drawer>
      </div>
    );
  }
}
