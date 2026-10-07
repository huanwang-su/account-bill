import React from "react";
import {
  Button,
  Card,
  DatePicker,
  Drawer,
  Empty,
  Input,
  Select,
  Space,
  Spin,
  Tag,
  message,
} from "antd";
import dayjs from "dayjs";
import { LedgerApi, MoneyFormatter as Money, Row } from "./api";
import { Chart } from "./Chart";
import { PagedTable } from "./PagedTable";

interface Props {
  accounts: Row[];
  initialAccountId?: number;
  refreshKey: string;
  onDetail: (row: Row) => void;
  onValuation: (account: Row) => void;
}
interface State {
  accountId?: number;
  filters: Row;
  query: string;
  report?: Row;
  history: Row[];
  selected?: Row;
  loading: boolean;
}

export class CounterpartyWorkspace extends React.Component<Props, State> {
  api = new LedgerApi();
  requestVersion = 0;
  state: State = {
    accountId: this.props.initialAccountId,
    filters: {},
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
        },
        () => this.load(),
      );
    else if (previous.refreshKey !== this.props.refreshKey) this.load();
  }
  componentWillUnmount() {
    this.requestVersion++;
  }
  async load() {
    const version = ++this.requestVersion;
    const accountId = this.state.accountId;
    if (!accountId) return;
    this.setState({ loading: true });
    try {
      const account = this.props.accounts.find((a) => a.id === accountId);
      const [report, history] = await Promise.all([
        this.api.request(
          "/reports/counterparties?" +
            this.api.query({ account_id: accountId, ...this.state.filters }),
        ),
        account?.kind === "证券"
          ? this.api.request(`/accounts/${accountId}/valuations`)
          : Promise.resolve([]),
      ]);
      if (version === this.requestVersion)
        this.setState({ report, history, loading: false });
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
      { filters: { ...this.state.filters, ...patch }, selected: undefined },
      () => this.load(),
    );
  }
  async valuationDetail(id: number) {
    try {
      const row = await this.api.transaction(id);
      if (row) this.props.onDetail(row);
    } catch (error) {
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
        dataSource={rows}
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
                onClick={() => this.setState({ selected: row })}
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
    const ranked: Row[] = [...(report?.parties || [])]
      .sort((a, b) => Math.abs(b.net) - Math.abs(a.net))
      .slice(0, 10)
      .reverse();
    return (
      <div className="counterparty-workspace">
        <div className="section-top">
          <div>
            <h2>单账户交易方分析</h2>
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
                },
                () => this.load(),
              )
            }
          />
          <DatePicker.RangePicker
            aria-label="交易方分析日期"
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
                { filters: {}, query: "", selected: undefined },
                () => this.load(),
              )
            }
          >
            重置筛选
          </Button>
        </div>
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
                extra={<small className="muted">点击交易方查看每次收付</small>}
              >
                {this.partyTable(report.parties)}
              </Card>
              <div className="counterparty-charts mb">
                <Card title="累计净额 · 前 10 位">
                  {ranked.length ? (
                    <Chart
                      label="交易方累计净额排行"
                      option={{
                        tooltip: { trigger: "axis", renderMode: "richText" },
                        grid: { left: 140, right: 35, top: 20, bottom: 35 },
                        xAxis: { type: "value", name: "元" },
                        yAxis: {
                          type: "category",
                          data: ranked.map((r) => r.counterparty),
                          axisLabel: { width: 120, overflow: "truncate" },
                        },
                        series: [
                          {
                            type: "bar",
                            data: ranked.map((r) => ({
                              value: r.net / 100,
                              itemStyle: {
                                color: r.net >= 0 ? "#73a58f" : "#b78863",
                              },
                            })),
                          },
                        ],
                      }}
                    />
                  ) : (
                    <Empty description="当前条件没有交易方往来" />
                  )}
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
          title={`${selected?.counterparty || ""} · 收付明细`}
          onClose={() => this.setState({ selected: undefined })}
          width={950}
          zIndex={900}
          destroyOnHidden
        >
          {selected && (
            <>
              <Space size="large" wrap>
                <span>收款 ¥ {Money.format(selected.incoming)}</span>
                <span>付款 ¥ {Money.format(selected.outgoing)}</span>
                <span>净额 ¥ {Money.format(selected.net)}</span>
                <span>{selected.count} 笔</span>
              </Space>
              <PagedTable<Row>
                className="counterparty-detail-table mt"
                rowKey="id"
                dataSource={selected.transactions}
                defaultPageSize={10}
                pageResetKey={selected.key}
                columns={[
                  { title: "时间", dataIndex: "occurred_at" },
                  { title: "说明", dataIndex: "note" },
                  {
                    title: "账户收付（元）",
                    dataIndex: "account_change",
                    align: "right",
                    render: (v) => `${v > 0 ? "+" : ""}${Money.format(v)}`,
                  },
                  {
                    title: "类型",
                    render: (_, r) =>
                      (
                        ({
                          INCOME: "收入",
                          EXPENSE: "支出",
                          TRANSFER: "内部转账",
                          REFUND: "退款",
                        }) as Row
                      )[r.kind] || r.kind,
                  },
                  {
                    title: "操作",
                    render: (_, r) => (
                      <Button
                        type="link"
                        size="small"
                        onClick={() => this.props.onDetail(r)}
                      >
                        查看交易
                      </Button>
                    ),
                  },
                ]}
              />
            </>
          )}
        </Drawer>
      </div>
    );
  }
}
