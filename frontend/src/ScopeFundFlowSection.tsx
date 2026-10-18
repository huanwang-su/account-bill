import React from "react";
import { Button, Card, Empty, Select, Spin, Tabs } from "antd";
import {
  AccountGroupTree,
  LedgerApi,
  MoneyFormatter as Money,
  type Row,
} from "./api";
import { AnalysisDrilldownBar } from "./AnalysisDrilldown";
import { AnalysisDetailFocus } from "./AnalysisDetailFocus";
import { DistributionDiagram } from "./DistributionDiagram";
import { PagedTable } from "./PagedTable";
import { ScopeFundFlowData } from "./ScopeFundFlowData";
import { ReportAccountFilters } from "./ReportAccountFilters";

interface Props {
  filters: Row;
  refreshKey: string;
  onDetail: (row: Row) => void;
  dimension?: "total" | "group" | "account";
}
interface State {
  report?: Row;
  loading: boolean;
  error?: string;
  dimension: "total" | "group" | "account";
  scopeKey: string;
  selection?: Row;
  activeTab: string;
}

/** Boundary cash movements follow only the outer date and funding-account scope. */
export class ScopeFundFlowSection extends React.Component<Props, State> {
  api = new LedgerApi();
  detailFocus = new AnalysisDetailFocus();
  requestVersion = 0;
  state: State = {
    loading: true,
    dimension: this.props.dimension || "total",
    scopeKey: "total",
    activeTab: "transactions",
  };
  scopeFilters(filters = this.props.filters) {
    const exclusions = ReportAccountFilters.query(filters);
    return {
      period: filters.period,
      start: filters.start,
      end: filters.end,
      group_id: filters.group_id,
      account_id: filters.account_id,
      exclude_investment_accounts: exclusions.exclude_investment_accounts,
      exclude_single_accounts: exclusions.exclude_single_accounts,
      excluded_account_ids: exclusions.excluded_account_ids,
    };
  }
  componentDidMount() {
    this.load();
  }
  componentDidUpdate(previous: Props) {
    if (previous.dimension !== this.props.dimension && this.props.dimension)
      this.changeDimension(this.props.dimension);
    if (
      JSON.stringify(this.scopeFilters(previous.filters)) !==
        JSON.stringify(this.scopeFilters()) ||
      previous.refreshKey !== this.props.refreshKey
    )
      this.load();
  }
  componentWillUnmount() {
    this.requestVersion++;
    this.detailFocus.cancel();
  }
  async load() {
    const version = ++this.requestVersion;
    this.detailFocus.cancel();
    this.setState({ loading: true, error: undefined, selection: undefined });
    try {
      const report = await this.api.request(
        "/reports/fund-boundaries?" + this.api.query(this.scopeFilters()),
      );
      if (version !== this.requestVersion) return;
      const dimension = this.props.dimension || this.state.dimension;
      const candidates =
        dimension === "group"
          ? report.group_scopes
          : dimension === "account"
            ? report.account_scopes
            : [report.summary];
      const existing = candidates.some(
        (row: Row) => row.key === this.state.scopeKey,
      );
      this.setState({
        report,
        loading: false,
        scopeKey: existing
          ? this.state.scopeKey
          : candidates[0]?.key || "total",
        dimension: candidates.length ? dimension : "total",
      });
    } catch (error) {
      if (version === this.requestVersion)
        this.setState({
          report: undefined,
          loading: false,
          error:
            error instanceof Error ? error.message : "范围资金进出加载失败",
        });
    }
  }
  scopes(dimension = this.state.dimension): Row[] {
    const report = this.state.report;
    return !report
      ? []
      : dimension === "total"
        ? [report.summary]
        : dimension === "group"
          ? report.group_scopes
          : report.account_scopes;
  }
  changeDimension(dimension: State["dimension"]) {
    this.detailFocus.cancel();
    const scopes = this.scopes(dimension);
    const scopeKey = scopes[0]?.key || "total";
    this.setState({
      dimension: scopes.length ? dimension : "total",
      scopeKey,
      selection: undefined,
    });
  }
  selectScope(scopeKey: string) {
    this.detailFocus.cancel();
    this.setState({ scopeKey, selection: undefined });
  }
  select(selection: Row, expected = this.state.report) {
    if (
      this.state.loading ||
      !this.state.report ||
      expected !== this.state.report ||
      selection.scope_key !== this.state.scopeKey
    )
      return;
    this.detailFocus.request();
    this.setState(
      { selection: { ...selection }, activeTab: "transactions" },
      () => this.detailFocus.afterRender(),
    );
  }
  clearSelection() {
    this.detailFocus.cancel();
    this.setState({ selection: undefined });
  }
  open(id: number) {
    if (this.state.loading) return;
    const row = this.state.report?.transactions.find(
      (row: Row) => row.id === id,
    );
    if (row) this.props.onDetail(row);
  }
  scopeName(scope: Row) {
    return scope.level === "group"
      ? new AccountGroupTree(this.state.report?.groups || []).path(
          scope.group_id,
        ) || scope.name
      : scope.name;
  }
  amount(value: number, signed = false) {
    return (
      <span className="fund-flow-money">
        {signed && value > 0 ? "+" : ""}
        {Money.format(value)}
      </span>
    );
  }
  renderReport(report: Row) {
    const data = new ScopeFundFlowData(report, this.state.scopeKey),
      scope = data.scope,
      local = data.summary(this.state.selection);
    const rows = data.transactions(this.state.selection);
    const reset = JSON.stringify([
      report.start_at,
      report.end_at,
      this.state.scopeKey,
      this.state.selection,
    ]);
    return (
      <>
        <div className="scope-fund-flow-controls">
          {!this.props.dimension && (
            <Select
              aria-label="范围进出分析维度"
              value={this.state.dimension}
              onChange={(dimension) => this.changeDimension(dimension)}
              options={[
                { value: "total", label: "整体范围" },
                {
                  value: "group",
                  label: "按账户组",
                  disabled: !report.group_scopes.length,
                },
                {
                  value: "account",
                  label: "按单账户",
                  disabled: !report.account_scopes.length,
                },
              ]}
            />
          )}
          {this.state.dimension !== "total" && (
            <Select
              aria-label="范围进出分析对象"
              showSearch
              optionFilterProp="label"
              value={this.state.scopeKey}
              onChange={(key) => this.selectScope(key)}
              options={this.scopes().map((row) => ({
                value: row.key,
                label: this.scopeName(row),
              }))}
            />
          )}
          <span>
            {report.start} 至 {report.end} · {scope.account_ids.length} 个账户
          </span>
        </div>
        <p className="scope-fund-flow-rule">
          {this.scopeName(scope)}
          ：只统计跨出、跨入该范围的实际资金。账户组包含所有子组，范围内部互转已剔除；分类和交易标签不影响本模块。
        </p>
        <div className="fund-flow-summary">
          {[
            [
              "资金流入",
              scope.incoming,
              `${scope.incoming_count} 笔跨范围转入`,
            ],
            [
              "资金流出",
              scope.outgoing,
              `${scope.outgoing_count} 笔跨范围转出`,
            ],
            ["净流入", scope.net, "流入 − 流出"],
            [
              "内部互转 · 已剔除",
              scope.internal_excluded,
              `${scope.internal_count} 笔，不计入上方进出`,
            ],
          ].map(([title, value, note]) => (
            <div className="fund-flow-stat" key={String(title)}>
              <span>{title}</span>
              <strong>
                ¥ {this.amount(Number(value), title === "净流入")}
              </strong>
              <small>{note}</small>
            </div>
          ))}
        </div>
        <p className="fund-flow-footnote">
          整体指主筛选选定的账户集合，只计跨该范围的进出；选择全部家庭账户时，家庭内部交易全部剔除。单个组或账户与其他自有账户的往来也可跨范围，不等同于工资收入或消费支出。期初、估值和账面调整不计实际资金流转。
        </p>
        {scope.unallocated_count > 0 && (
          <p className="scope-fund-flow-rule">
            另有 {scope.unallocated_count}{" "}
            笔跨范围多方交易尚未确定线路，未计入金额，可在资金流转报表核对原交易。
          </p>
        )}
        <div className="scope-fund-flow-chart">
          <h3>范围资金进出构成</h3>
          {data.nodes.length ? (
            <DistributionDiagram
              data={data}
              columns={["资金方向", "范围内账户组", "资金账户", "范围外对手"]}
              label={`${scope.name}范围资金进出桑基图，内部互转已剔除`}
              onSelect={(selection) => this.select(selection, report)}
            />
          ) : (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description="该范围本期没有跨范围的实际资金进出"
            />
          )}
          <p className="fund-flow-footnote">
            点击方向、对手或连线，直接查看对应交易。图中金额不包含内部互转；范围净流入可与含估值、调整的账户余额变化不同。
          </p>
        </div>
        <AnalysisDrilldownBar
          elementRef={this.detailFocus.ref}
          label="范围进出明细"
          items={
            this.state.selection
              ? [
                  {
                    key: "boundary",
                    label: this.state.selection.label,
                    onClear: () => this.clearSelection(),
                  },
                ]
              : []
          }
          onReset={() => this.clearSelection()}
          resetLabel="清除图表联动"
          emptyText={`显示${this.scopeName(scope)}的全部跨范围进出`}
        />
        <p className="fund-flow-local-total">
          <span>本区流入 ¥ {this.amount(local.incoming)}</span>
          <span>流出 ¥ {this.amount(local.outgoing)}</span>
          <span>{local.count} 笔交易</span>
        </p>
        <Tabs
          activeKey={this.state.activeTab}
          onChange={(activeTab) => {
            this.detailFocus.cancel();
            this.setState({ activeTab });
          }}
          items={[
            {
              key: "transactions",
              label: `对应交易（${rows.length}）`,
              children: (
                <PagedTable<Row>
                  rowKey="id"
                  dataSource={rows}
                  defaultPageSize={10}
                  pageResetKey={reset}
                  scroll={{ x: 1000 }}
                  columns={[
                    {
                      title: "时间 / 对方",
                      width: 220,
                      render: (_, row) => (
                        <>
                          <div className="cell-title">
                            {row.counterparty ||
                              row.account_names?.join("、") ||
                              "未填写交易方"}
                          </div>
                          <small className="muted">{row.occurred_at}</small>
                        </>
                      ),
                    },
                    {
                      title: "资金账户",
                      width: 220,
                      render: (_, row) => row.account_names?.join("、") || "—",
                    },
                    ...[
                      ["boundary_incoming", "本区流入"],
                      ["boundary_outgoing", "本区流出"],
                    ].map(([key, title]) => ({
                      title: `${title}（元）`,
                      dataIndex: key,
                      width: 155,
                      align: "right" as const,
                      sorter: (a: Row, b: Row) => a[key] - b[key],
                      render: (value: number) => this.amount(value),
                    })),
                    {
                      title: "原交易金额（元）",
                      dataIndex: "amount",
                      width: 165,
                      align: "right",
                      render: (value) => this.amount(value),
                    },
                    {
                      title: "操作",
                      width: 75,
                      render: (_, row) => (
                        <Button
                          size="small"
                          type="link"
                          disabled={this.state.loading}
                          onClick={() => this.open(row.id)}
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
              key: "comparison",
              label:
                this.state.dimension === "total"
                  ? "整体汇总"
                  : this.state.dimension === "group"
                    ? "账户组比较"
                    : "账户比较",
              children: (
                <>
                  <p className="fund-flow-footnote">
                    各范围独立计算，组包含所有子组，父组和子组的数据不能相加。点“查看范围”切换上方图表与统计。
                  </p>
                  <PagedTable<Row>
                    rowKey="key"
                    dataSource={this.scopes()}
                    defaultPageSize={10}
                    pageResetKey={JSON.stringify([
                      report.start_at,
                      report.end_at,
                      this.state.dimension,
                    ])}
                    scroll={{ x: 900 }}
                    columns={[
                      {
                        title:
                          this.state.dimension === "account" ? "账户" : "范围",
                        width: 240,
                        render: (_, row) => this.scopeName(row),
                      },
                      ...[
                        ["incoming", "流入"],
                        ["outgoing", "流出"],
                        ["net", "净流入"],
                        ["internal_excluded", "内部互转（已剔除）"],
                      ].map(([key, title]) => ({
                        title: `${title}（元）`,
                        dataIndex: key,
                        align: "right" as const,
                        width: 160,
                        sorter: (a: Row, b: Row) => a[key] - b[key],
                        render: (value: number) =>
                          this.amount(value, key === "net"),
                      })),
                      {
                        title: "交易数",
                        dataIndex: "count",
                        align: "right",
                        width: 75,
                      },
                      {
                        title: "操作",
                        width: 100,
                        render: (_, row) => (
                          <Button
                            size="small"
                            type="link"
                            onClick={() => this.selectScope(row.key)}
                          >
                            查看范围
                          </Button>
                        ),
                      },
                    ]}
                  />
                </>
              ),
            },
          ]}
        />
        <p className="fund-flow-footnote">
          本区金额只累计跨范围的匹配线路，原交易详情保留整笔金额；同一笔拆分交易可能只有一部分计入本区。
        </p>
      </>
    );
  }
  render() {
    return (
      <Card
        className="scope-fund-flow-section mb"
        title="范围资金进出 · 剔除内部互转"
        extra={
          <Button
            size="small"
            onClick={() => this.load()}
            loading={this.state.loading}
          >
            刷新
          </Button>
        }
      >
        <Spin spinning={this.state.loading}>
          {this.state.report ? (
            this.renderReport(this.state.report)
          ) : this.state.error ? (
            <>
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={this.state.error}
              />
              <Button onClick={() => this.load()}>重试</Button>
            </>
          ) : (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description="正在计算资金进出"
            />
          )}
        </Spin>
      </Card>
    );
  }
}
