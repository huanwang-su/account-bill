import { ReportPeriodFilter } from "./ReportPeriodFilter";
import React from "react";
import { Button, Card, Empty, Select, Spin, Tabs, Tag, Segmented } from "antd";
import {
  AccountGroupTree,
  LedgerApi,
  MoneyFormatter as Money,
  type Row,
} from "./api";
import { AnalysisDrilldownBar } from "./AnalysisDrilldown";
import { AnalysisDetailFocus } from "./AnalysisDetailFocus";
import { DistributionDiagram } from "./DistributionDiagram";
import { FundFlowData } from "./FundFlowData";
import { PagedTable } from "./PagedTable";
import { ScopeFundFlowSection } from "./ScopeFundFlowSection";
import { ReportAccountFilters } from "./ReportAccountFilters";

interface Props {
  accounts: Row[];
  groups: Row[];
  refreshKey: string;
  onDetail: (transaction: Row) => void;
}
interface State {
  filters: Row;
  dimension: "account" | "group";
  view: "all" | "internal" | "external";
  activeTab: string;
  report?: Row;
  selection?: Row;
  loading: boolean;
  error?: string;
  perspective: "total" | "group" | "account" | "network";
}

/** Actual paired movements, with untouched source transactions for inspection. */
export class FundFlowWorkspace extends React.Component<Props, State> {
  api = new LedgerApi();
  detailFocus = new AnalysisDetailFocus();
  boundaryRef = React.createRef<ScopeFundFlowSection>();
  requestVersion = 0;
  state: State = {
    filters: ReportPeriodFilter.defaults(),
    dimension: "account",
    view: "all",
    activeTab: "stats",
    loading: true,
    perspective: "total",
  };

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

  async load() {
    this.detailFocus.cancel();
    const version = ++this.requestVersion;
    this.setState({ loading: true, error: undefined });
    try {
      const report = await this.api.request(
        "/reports/fund-flows?" +
          this.api.query(ReportAccountFilters.query(this.state.filters)),
      );
      if (version === this.requestVersion)
        this.setState({ report, loading: false });
    } catch (error) {
      if (version === this.requestVersion)
        this.setState({
          report: undefined,
          loading: false,
          error: error instanceof Error ? error.message : "资金流转加载失败",
        });
    }
  }

  filter(patch: Row) {
    this.detailFocus.cancel();
    this.setState(
      (state) => ({
        filters: { ...state.filters, ...patch },
        selection: undefined,
      }),
      () => this.load(),
    );
  }

  display(patch: Partial<Pick<State, "dimension" | "view">>) {
    this.detailFocus.cancel();
    this.setState((state) => ({
      dimension: patch.dimension ?? state.dimension,
      view: patch.view ?? state.view,
      selection: undefined,
    }));
  }

  select(selection: Row) {
    if (!this.state.loading && this.state.report) {
      this.detailFocus.request();
      this.setState(
        { selection: { ...selection }, activeTab: "transactions" },
        () => this.detailFocus.afterRender(),
      );
    }
  }

  clearSelection() {
    this.detailFocus.cancel();
    this.setState({ selection: undefined });
  }

  openTransaction(id: number) {
    if (this.state.loading) return;
    const transaction = this.state.report?.transactions?.find(
      (row: Row) => row.id === id,
    );
    if (transaction) this.props.onDetail(transaction);
  }

  kind(kind: string) {
    return (
      (
        {
          INCOME: "收入到账",
          EXPENSE: "对外付款",
          REFUND: "退款到账",
          TRANSFER: "转账",
        } as Row
      )[kind] || "资金流转"
    );
  }

  amount(value: number, signed = false) {
    return (
      <span className="fund-flow-money">
        {signed && value > 0 ? "+" : ""}
        {Money.format(value)}
      </span>
    );
  }

  statsTable(rows: Row[], pageResetKey: string) {
    const grouped = this.state.dimension === "group";
    return (
      <>
        <PagedTable<Row>
          rowKey="key"
          dataSource={rows}
          defaultPageSize={10}
          pageResetKey={pageResetKey}
          scroll={{ x: grouped ? 990 : 1080 }}
          locale={{ emptyText: "当前范围没有资金账户进出记录" }}
          columns={[
            {
              title: grouped ? "直属账户组" : "资金账户",
              width: 240,
              render: (_, row) => (
                <div className="fund-flow-identity">
                  <strong>{row.name}</strong>
                  {(!grouped || (row.path && row.path !== row.name)) && (
                    <small>
                      {grouped
                        ? row.path
                        : new AccountGroupTree(this.props.groups).path(
                            row.group_id,
                          ) || "未分组"}
                    </small>
                  )}
                </div>
              ),
            },
            ...[
              ["incoming", "转入"],
              ["outgoing", "转出"],
              ["net", "净流入"],
              ...(grouped ? [["internal_amount", "组内互转"]] : []),
            ].map(([key, title]) => ({
              title: `${title}（元）`,
              dataIndex: key,
              width: 155,
              align: "right" as const,
              sorter: (a: Row, b: Row) => a[key] - b[key],
              render: (value: number) => this.amount(value, key === "net"),
            })),
            {
              title: "涉及交易数",
              dataIndex: "transaction_count",
              width: 110,
              align: "right",
              sorter: (a, b) => a.transaction_count - b.transaction_count,
            },
          ]}
        />
        <p className="fund-flow-footnote">
          仅统计所选范围内资金账户{grouped ? "的直属账户组" : ""}
          ，净流入＝转入－转出。
          {grouped &&
            "组内互转同时计入该组转入和转出，净额相抵；互转金额另列且只计一次。"}
          同一交易涉及多个账户时，会分别出现在对应账户或组的统计中。
        </p>
      </>
    );
  }

  flowTable(rows: Row[], pageResetKey: string) {
    return (
      <>
        <PagedTable<Row>
          rowKey="id"
          dataSource={rows}
          defaultPageSize={10}
          pageResetKey={pageResetKey}
          scroll={{ x: 1080 }}
          locale={{ emptyText: "当前范围没有已分配的流转线路" }}
          columns={[
            ...["source", "target"].map((key) => ({
              title: key === "source" ? "转出方" : "转入方",
              width: 240,
              render: (_: unknown, row: Row) => (
                <div className="fund-flow-identity">
                  <strong>{row[`${key}_name`]}</strong>
                  <small>
                    {row[`${key}_external`]
                      ? "外部"
                      : this.state.dimension === "group"
                        ? row[`${key}_account`]
                        : row[`${key}_group`] || "未分组"}
                    {!row[`${key}_external`] &&
                      row[`${key}_in_scope`] === false &&
                      " · 范围外"}
                  </small>
                </div>
              ),
            })),
            {
              title: "流转类型",
              dataIndex: "kind",
              width: 120,
              render: (value, row) =>
                value === "TRANSFER"
                  ? row.source_external || row.target_external
                    ? "外部转账"
                    : "账户间转账"
                  : this.kind(value),
            },
            {
              title: "线路金额（元）",
              dataIndex: "amount",
              width: 160,
              align: "right",
              sorter: (a, b) => a.amount - b.amount,
              render: (value) => this.amount(value),
            },
            {
              title: "时间",
              dataIndex: "occurred_at",
              width: 180,
              sorter: (a, b) =>
                String(a.occurred_at).localeCompare(String(b.occurred_at)),
            },
            {
              title: "操作",
              width: 75,
              render: (_, row) => (
                <Button
                  type="link"
                  size="small"
                  disabled={this.state.loading}
                  onClick={() => this.openTransaction(row.transaction_id)}
                >
                  查看交易
                </Button>
              ),
            },
          ]}
        />
        <p className="fund-flow-footnote">
          每行是一笔交易中可确定的一条资金线路。跨账户组或账户筛选仍保留另一端的实际账户；多条线路可来自同一笔原交易。
        </p>
      </>
    );
  }

  transactionTable(rows: Row[], pageResetKey: string) {
    return (
      <>
        <PagedTable<Row>
          rowKey="id"
          dataSource={rows}
          defaultPageSize={10}
          pageResetKey={pageResetKey}
          scroll={{ x: 1190 }}
          locale={{ emptyText: "当前范围没有对应交易" }}
          columns={[
            {
              title: "时间",
              dataIndex: "occurred_at",
              width: 175,
              sorter: (a, b) =>
                String(a.occurred_at).localeCompare(String(b.occurred_at)),
            },
            {
              title: "类型",
              dataIndex: "kind",
              width: 120,
              render: (value) => this.kind(value),
            },
            {
              title: "对方 / 账户",
              width: 240,
              render: (_, row) => (
                <div className="fund-flow-identity">
                  <strong>
                    {row.counterparty ||
                      row.category_names?.join("、") ||
                      "未记录对方"}
                  </strong>
                  <small>{row.account_names?.join("、") || "—"}</small>
                </div>
              ),
            },
            {
              title: "原交易金额（元）",
              dataIndex: "amount",
              width: 165,
              align: "right",
              sorter: (a, b) => a.amount - b.amount,
              render: (value) => this.amount(value),
            },
            {
              title: "本区流转金额（元）",
              dataIndex: "selected_flow_amount",
              width: 175,
              align: "right",
              sorter: (a, b) =>
                (a.selected_flow_amount ?? 0) - (b.selected_flow_amount ?? 0),
              render: (value, row) =>
                row.allocation === "unallocated" ? (
                  <span className="muted">未分配</span>
                ) : (
                  this.amount(value ?? 0)
                ),
            },
            {
              title: "线路状态",
              dataIndex: "allocation",
              width: 145,
              render: (value) => (
                <Tag>
                  {value === "unallocated"
                    ? "多方未分配"
                    : value === "merged_internal"
                      ? "合并账户内互转"
                      : "已分配线路"}
                </Tag>
              ),
            },
            {
              title: "操作",
              width: 75,
              render: (_, row) => (
                <Button
                  type="link"
                  size="small"
                  disabled={this.state.loading}
                  onClick={() => this.openTransaction(row.id)}
                >
                  查看
                </Button>
              ),
            },
          ]}
        />
        <p className="fund-flow-footnote">
          原交易金额保留整笔口径，本区流转金额为当前视图与联动范围内已配对线路之和；一笔交易可有多条线路。未分配交易只在全部流转中列示，合并账户内互转不绘制线路。
        </p>
      </>
    );
  }

  renderReport(report: Row) {
    const { dimension, view, selection } = this.state;
    const data = new FundFlowData(report, dimension, view);
    const summary = data.summary();
    const local = data.summary(selection);
    const stats = data.stats(selection);
    const flows = data.flowRows(selection);
    const transactions = data.transactions(selection);
    const pageResetKey = JSON.stringify([
      this.state.filters,
      dimension,
      view,
      selection,
    ]);
    const unallocated = report.unallocated?.length || 0;
    const merged = report.merged_internal?.transaction_count || 0;
    return (
      <>
        <div className="fund-flow-heading">
          <p>
            {report.start
              ? `${report.start} 至 ${report.end || "当前"}`
              : report.end
                ? `最早记录至 ${report.end}`
                : "全部记录期间"}
            {" · 金额单位：元"}
          </p>
          <span>{report.scope_account_ids?.length || 0} 个范围内资金账户</span>
        </div>
        <div className="fund-flow-summary">
          {[
            ["范围转入", summary.incoming, "进入范围内资金账户的已配对金额"],
            ["范围转出", summary.outgoing, "从范围内资金账户转出的已配对金额"],
            ["净流入", summary.net, "范围转入减范围转出"],
            ["账户间转账", summary.internal, "包括范围内互转，每条线路计一次"],
          ].map(([title, value, note]) => (
            <div className="fund-flow-stat" key={title}>
              <span>{title}</span>
              <strong>
                ¥ {this.amount(value as number, title === "净流入")}
              </strong>
              <small>{note}</small>
            </div>
          ))}
        </div>
        <p className="fund-flow-footnote">
          范围内账户之间互转会同时计入转入和转出，净额相抵；两侧合计不是收入、支出或总交易额。
        </p>
        <Card className="fund-flow-diagram" title="资金流转图">
          <p className="fund-flow-footnote">
            左侧为转出方，右侧为转入方，同一账户可分别出现在两侧。线宽表示已配对金额；点击节点或连线联动下方明细，图保持当前整体范围。
          </p>
          {data.nodes.length ? (
            <DistributionDiagram
              data={data}
              columns={["转出方", "转入方"]}
              label={`资金流转桑基图：转出方、转入方；已配对线路金额 ${Money.format(data.positiveTotal)} 元`}
              onSelect={(value) => this.select(value)}
            />
          ) : (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description="当前条件没有可绘制的资金流转"
            />
          )}
          {(unallocated > 0 || merged > 0) && (
            <div className="fund-flow-notice" role="note">
              <div>
                {unallocated > 0 && (
                  <p>
                    {unallocated}{" "}
                    笔多方交易无法唯一分配线路，未绘入图中，可在全部流转的交易明细查看。
                  </p>
                )}
                {merged > 0 && (
                  <p>
                    {merged}{" "}
                    笔合并账户内部互转不形成账户间线路，原交易仍在全部流转或账户间转账明细中保留。
                  </p>
                )}
              </div>
              <Button
                size="small"
                disabled={this.state.loading}
                onClick={() => {
                  this.detailFocus.cancel();
                  this.setState({
                    view: "all",
                    activeTab: "transactions",
                    selection: undefined,
                  });
                }}
              >
                查看全部交易明细
              </Button>
            </div>
          )}
          <details className="fund-flow-method">
            <summary>统计口径与未入图记录</summary>
            <p>
              本图展示有效收入、付款、退款和账户间转账的实际资金配对；账户组按直属归属汇总，不重复累计父子组。期初录入、已撤销或冲销记录、估值和其他调整不作为资金流转绘图。
            </p>
            {report.excluded?.length > 0 && (
              <ul>
                {report.excluded.map((row: Row) => (
                  <li key={row.reason}>
                    {row.label}：{row.transaction_count} 笔 · ¥{" "}
                    {Money.format(row.amount)}
                  </li>
                ))}
              </ul>
            )}
            <p>
              复杂多对多记录不推断账户之间的分配关系；未分配部分不计入图中线路及上方已配对金额，仍保留原交易。合并账户内部互转不产生账户间流量。
            </p>
          </details>
        </Card>
        <Card className="fund-flow-details" title="流转明细">
          <AnalysisDrilldownBar
            elementRef={this.detailFocus.ref}
            label="流转明细范围"
            items={
              selection
                ? [
                    {
                      key: "flow",
                      label: selection.label || "图中所选流转",
                      onClear: () => this.clearSelection(),
                    },
                  ]
                : []
            }
            onReset={() => this.clearSelection()}
            resetLabel="清除图表联动"
            emptyText="点击上图节点或连线，可联动进出统计、流转线路与交易明细。"
          />
          <p className="fund-flow-local-total" aria-live="polite">
            <span>
              本区已配对金额 <strong>¥ {this.amount(local.amount)}</strong>
            </span>
            <span>已配对涉及 {local.count} 笔交易</span>
          </p>
          <Tabs
            activeKey={this.state.activeTab}
            onChange={(activeTab) => {
              this.detailFocus.cancel();
              this.setState({ activeTab });
            }}
            items={[
              {
                key: "stats",
                label: `${dimension === "group" ? "账户组" : "账户"}进出统计（${stats.length}）`,
                children: this.statsTable(stats, pageResetKey),
              },
              {
                key: "flows",
                label: `流转线路（${flows.length}）`,
                children: this.flowTable(flows, pageResetKey),
              },
              {
                key: "transactions",
                label: `交易明细（${transactions.length}）`,
                children: this.transactionTable(transactions, pageResetKey),
              },
            ]}
          />
        </Card>
      </>
    );
  }

  render() {
    const { filters, dimension, view, report, loading, error } = this.state;
    const accounts = this.props.accounts.filter(
      (row) => ["ASSET", "LIABILITY"].includes(row.role) && !row.merged_into_id,
    );
    return (
      <div className="fund-flow-workspace">
        <section className="fund-flow-filters" aria-label="资金流转筛选">
          <ReportPeriodFilter
            refreshKey={this.props.refreshKey}
            filters={filters}
            label="资金流转日期"
            onChange={(patch) => this.filter(patch)}
          />
          <label>
            <span>账户组（含子组）</span>
            <Select
              allowClear
              showSearch
              optionFilterProp="label"
              aria-label="资金流转账户组"
              placeholder="全部账户组"
              value={filters.group_id}
              options={[
                { value: 0, label: "未分组" },
                ...new AccountGroupTree(this.props.groups).options(),
              ]}
              onChange={(group_id) => this.filter({ group_id })}
            />
          </label>
          <label>
            <span>资金账户</span>
            <Select
              allowClear
              showSearch
              optionFilterProp="label"
              aria-label="资金流转账户"
              placeholder="全部资金账户"
              value={filters.account_id}
              options={accounts.map((row) => ({
                value: row.id,
                label: row.name + (row.active ? "" : "（停用）"),
              }))}
              onChange={(account_id) => this.filter({ account_id })}
            />
          </label>
          {this.state.perspective === "network" && (
            <label>
              <span>图表维度</span>
              <Select
                aria-label="资金流转维度"
                value={dimension}
                options={[
                  { value: "account", label: "按账户" },
                  { value: "group", label: "按直属账户组" },
                ]}
                onChange={(value) => this.display({ dimension: value })}
              />
            </label>
          )}
          {this.state.perspective === "network" && (
            <label>
              <span>流转类型</span>
              <Select
                aria-label="资金流转类型"
                value={view}
                options={[
                  { value: "all", label: "全部流转" },
                  { value: "internal", label: "账户间转账" },
                  { value: "external", label: "对外进出" },
                ]}
                onChange={(value) => this.display({ view: value })}
              />
            </label>
          )}
          <Button
            onClick={() =>
              this.setState(
                {
                  filters: ReportPeriodFilter.defaults(),
                  selection: undefined,
                },
                () => this.load(),
              )
            }
          >
            重置范围
          </Button>
        </section>
        <ReportAccountFilters
          accounts={this.props.accounts}
          filters={filters}
          defaults={report?.account_scope}
          disabled={loading}
          onChange={(patch) => this.filter(patch)}
        />
        <Segmented
          className="fund-flow-perspectives"
          aria-label="资金流转分析视角"
          value={this.state.perspective}
          options={[
            { value: "total", label: "整体进出" },
            { value: "group", label: "账户组进出" },
            { value: "account", label: "单账户进出" },
            { value: "network", label: "账户间流转线路" },
          ]}
          onChange={(value) => {
            this.detailFocus.cancel();
            this.boundaryRef.current?.detailFocus.cancel();
            this.setState({ perspective: value as State["perspective"] });
          }}
        />
        {this.state.perspective !== "network" && (
          <ScopeFundFlowSection
            ref={this.boundaryRef}
            filters={ReportAccountFilters.query(filters, report?.account_scope)}
            dimension={this.state.perspective}
            refreshKey={this.props.refreshKey}
            onDetail={this.props.onDetail}
          />
        )}
        {this.state.perspective === "network" && (
          <Spin spinning={loading}>
            {report ? (
              this.renderReport(report)
            ) : error ? (
              <Card className="fund-flow-error">
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description={error}
                />
                <Button onClick={() => this.load()}>重新加载</Button>
              </Card>
            ) : (
              <Card loading className="fund-flow-loading" />
            )}
          </Spin>
        )}
      </div>
    );
  }
}
