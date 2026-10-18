import React from "react";
import { Button, Card, Drawer, Empty, Spin, Tag } from "antd";
import { MoneyFormatter as Money, type Row } from "./api";
import { Chart } from "./Chart";
import { PagedTable } from "./PagedTable";
import { ReportDetailReading } from "./ReportDetailReading";

interface Props {
  summary: Row;
  transactions: Row[];
  scopeKey: string;
  loading?: boolean;
  onDetail: (row: Row) => void;
}

/** Column selections project the current report, without changing its filters. */
export class ReportCharts extends React.Component<Props, { selection?: Row }> {
  state: { selection?: Row } = {};

  componentDidUpdate(previous: Props) {
    if (
      this.state.selection &&
      (previous.scopeKey !== this.props.scopeKey ||
        previous.summary !== this.props.summary ||
        previous.transactions !== this.props.transactions ||
        this.props.loading)
    )
      this.setState({ selection: undefined });
  }
  categories() {
    return new ReportDetailReading(
      this.props.summary,
      this.props.transactions,
    ).categoriesByImpact.slice(0, 6);
  }
  selectMonth(params: any, expected = this.props) {
    if (this.props.loading || expected !== this.props) return;
    const { month, direction } = params.data || {};
    if (
      !["income", "expense"].includes(direction) ||
      !this.props.summary.months?.some((row: Row) => row.month === month)
    )
      return;
    this.setState({
      selection: {
        type: "month",
        month,
        direction,
        label: `${month} · ${direction === "income" ? "收入" : "净支出（含退款）"}`,
      },
    });
  }
  selectCategory(params: any, expected = this.props) {
    if (this.props.loading || expected !== this.props) return;
    const category = this.categories().find(
      (row) => row.id === params.data?.id,
    );
    if (category)
      this.setState({
        selection: {
          type: "category",
          id: category.id,
          label: `${category.name} · 分类净额`,
        },
      });
  }
  rows(selection = this.state.selection): Row[] {
    if (!selection) return [];
    return this.props.transactions.flatMap((row) => {
      if (selection.type === "month") {
        if (
          row.occurred_at?.slice(0, 7) !== selection.month ||
          !(
            selection.direction === "income"
              ? ["INCOME"]
              : ["EXPENSE", "REFUND"]
          ).includes(row.kind)
        )
          return [];
        return [
          {
            ...row,
            analysis_amount: row.amount * (row.kind === "REFUND" ? -1 : 1),
          },
        ];
      }
      if (!["EXPENSE", "REFUND"].includes(row.kind)) return [];
      const entries = (row.entries || []).filter(
        (entry: Row) =>
          entry.category_id === selection.id && entry.selected !== false,
      );
      if (!entries.length) return [];
      return [
        {
          ...row,
          analysis_amount: entries.reduce(
            (sum: number, entry: Row) => sum + entry.amount,
            0,
          ),
        },
      ];
    });
  }
  open(id: number) {
    if (this.props.loading || !this.rows().some((row) => row.id === id)) return;
    const row = this.props.transactions.find((row) => row.id === id);
    if (row) this.props.onDetail(row);
  }
  renderDetails() {
    const rows = this.rows();
    return (
      <Drawer
        title={this.state.selection?.label || "图表明细"}
        open={Boolean(this.state.selection)}
        onClose={() => this.setState({ selection: undefined })}
        width={960}
      >
        <p className="muted">
          沿用当前全部筛选条件，仅查看所点柱子对应的记录。净支出包含退款抵减；分类金额只累计匹配分项，原交易保持完整。
        </p>
        <p className="analysis-large-summary">
          对应净额 ¥{" "}
          {Money.format(
            rows.reduce((sum, row) => sum + row.analysis_amount, 0),
          )}{" "}
          · {rows.length} 笔记录
        </p>
        <PagedTable<Row>
          rowKey="id"
          dataSource={rows}
          defaultPageSize={10}
          pageResetKey={JSON.stringify([
            this.props.scopeKey,
            this.state.selection,
          ])}
          scroll={{ x: 850 }}
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
                ).join("、"),
            },
            {
              title: "类型",
              render: (_, row) => (
                <Tag>
                  {row.kind === "REFUND"
                    ? "退款抵减"
                    : row.kind === "INCOME"
                      ? "收入"
                      : "支出"}
                </Tag>
              ),
            },
            {
              title: "本柱金额（元）",
              align: "right",
              dataIndex: "analysis_amount",
              sorter: (a, b) => a.analysis_amount - b.analysis_amount,
              render: (value) => Money.format(value),
            },
            {
              title: "原交易金额（元）",
              align: "right",
              dataIndex: "amount",
              render: (value) => Money.format(value),
            },
            {
              title: "操作",
              render: (_, row) => (
                <Button
                  type="link"
                  size="small"
                  disabled={this.props.loading}
                  onClick={() => this.open(row.id)}
                >
                  查看原交易
                </Button>
              ),
            },
          ]}
        />
      </Drawer>
    );
  }
  render() {
    const source = this.props;
    const s = this.props.summary;
    const categories = this.categories();
    return (
      <>
        <Spin spinning={Boolean(this.props.loading)}>
          <div className="chart-grid">
            <Card
              title="收支趋势"
              extra={
                <span className="muted">
                  按月汇总 · 点击柱子查看该月收款或净支出
                </span>
              }
            >
              {s.months?.length ? (
                <Chart
                  label="统计明细月度收入与净支出"
                  onClick={(params) => this.selectMonth(params, source)}
                  option={{
                    tooltip: { trigger: "axis", renderMode: "richText" },
                    legend: { bottom: 0 },
                    grid: { left: 55, right: 20, top: 20, bottom: 55 },
                    xAxis: {
                      type: "category",
                      data: s.months.map((row: Row) => row.month),
                      axisTick: { show: false },
                    },
                    yAxis: {
                      type: "value",
                      name: "元",
                      splitLine: { lineStyle: { color: "#edf0ee" } },
                    },
                    series: [
                      {
                        name: "收入",
                        type: "bar",
                        barMaxWidth: 24,
                        itemStyle: {
                          color: "#96c7b1",
                          borderRadius: [4, 4, 0, 0],
                        },
                        data: s.months.map((row: Row) => ({
                          month: row.month,
                          direction: "income",
                          value: row.income / 100,
                        })),
                      },
                      {
                        name: "净支出",
                        type: "bar",
                        barMaxWidth: 24,
                        itemStyle: {
                          color: "#b78863",
                          borderRadius: [4, 4, 0, 0],
                        },
                        data: s.months.map((row: Row) => ({
                          month: row.month,
                          direction: "expense",
                          value: row.expense / 100,
                        })),
                      },
                    ],
                  }}
                />
              ) : (
                <Empty description="记下第一笔，开始观察收支变化" />
              )}
            </Card>
            <Card
              title="哪些分类影响最大"
              extra={
                <span className="muted">
                  净额绝对值前 6 类 · 点击柱子查看分类分项
                </span>
              }
            >
              {categories.length ? (
                <Chart
                  label="统计明细分类净额排行"
                  onClick={(params) => this.selectCategory(params, source)}
                  option={{
                    tooltip: { trigger: "axis", renderMode: "richText" },
                    grid: { left: 100, right: 35, top: 12, bottom: 30 },
                    xAxis: { type: "value", name: "元" },
                    yAxis: {
                      type: "category",
                      inverse: true,
                      data: categories.map((row: Row) => row.name),
                      axisLabel: { width: 90, overflow: "truncate" },
                    },
                    series: [
                      {
                        type: "bar",
                        barMaxWidth: 18,
                        itemStyle: {
                          color: "#73a58f",
                          borderRadius: [0, 4, 4, 0],
                        },
                        data: categories.map((row: Row) => ({
                          id: row.id,
                          name: row.name,
                          value: row.value / 100,
                          itemStyle: {
                            color: row.value < 0 ? "#73a58f" : "#b78863",
                          },
                        })),
                      },
                    ],
                  }}
                />
              ) : (
                <Empty description="确认支出后查看分类分布" />
              )}
            </Card>
          </div>
        </Spin>
        {this.renderDetails()}
      </>
    );
  }
}
