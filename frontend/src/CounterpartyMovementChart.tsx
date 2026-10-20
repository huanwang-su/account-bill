import React from "react";
import { Card, Empty, Select, Space } from "antd";
import type { EChartsOption } from "./ECharts";
import { Chart } from "./Chart";
import { DisplayMoneyFormatter as Money, type Row } from "./api";
import { PartyMetrics } from "./ReportMetrics";
import type { SingleAccountSelection } from "./SingleAccountDrilldown";

type SortMetric = "gross" | "incoming" | "outgoing" | "net" | "count";
type SortOrder = "desc" | "asc";
interface Props {
  account: Row;
  loading: boolean;
  onSelect: (scope: SingleAccountSelection) => void;
}

export class CounterpartyMovementChart extends React.Component<
  Props,
  { metric: SortMetric; order: SortOrder }
> {
  state: { metric: SortMetric; order: SortOrder } = {
    metric: "gross",
    order: "desc",
  };
  private chartCache?: {
    source?: Row[];
    metric: SortMetric;
    order: SortOrder;
    option: EChartsOption;
  };
  static metrics = [
    { value: "gross", label: "收付合计" },
    { value: "incoming", label: "收款金额" },
    { value: "outgoing", label: "付款金额" },
    { value: "net", label: "净收付" },
    { value: "count", label: "交易笔数" },
  ];
  ranked() {
    const { metric, order } = this.state;
    const amount = (party: Row) =>
      metric === "gross" ? PartyMetrics.gross(party) : Number(party[metric]) || 0;
    // Keep the existing deterministic gross ranking as the tie-breaker.
    return PartyMetrics.rank(
      this.props.account.counterparties?.parties || [],
    ).sort((a, b) => (order === "desc" ? -1 : 1) * (amount(a) - amount(b)));
  }
  chartOption(rows: Row[]) {
    const source = this.props.account.counterparties?.parties;
    const { metric, order } = this.state;
    if (
      !this.chartCache ||
      this.chartCache.source !== source ||
      this.chartCache.metric !== metric ||
      this.chartCache.order !== order
    )
      this.chartCache = { source, metric, order, option: this.option(rows) };
    // Detail selections should not reset the user's scroll position.
    return this.chartCache.option;
  }
  selection(params: any): SingleAccountSelection | undefined {
    if (params.componentType === "yAxis" && params.targetType === "axisLabel") {
      const party = this.ranked().find((row) => row.key === params.value);
      return party
        ? { party: { key: party.key, name: party.counterparty } }
        : undefined;
    }
    if (params.componentType !== "series") return;
    const party = this.ranked().find((row) => row.key === params.data?.partyKey);
    if (!party) return;
    if (params.seriesName === "净额")
      return { party: { key: party.key, name: party.counterparty } };
    const direction =
      params.seriesName === "收款"
        ? "incoming"
        : params.seriesName === "付款"
          ? "outgoing"
          : undefined;
    if (!direction) return;
    return {
      party: { key: party.key, name: party.counterparty },
      movement: {
        key: `party-movement:${party.key}:${direction}`,
        label: direction === "incoming" ? "交易方收款" : "交易方付款",
        mode: "counterparties",
        transaction_ids: (party.transactions || [])
          .filter((row: Row) =>
            direction === "incoming"
              ? row.account_change > 0
              : row.account_change < 0,
          )
          .map((row: Row) => row.id),
      },
    };
  }
  option(rows: Row[]): EChartsOption {
    const names = new Map(rows.map((row) => [row.key, row.counterparty]));
    const scroll = rows.length > 10;
    const movementMax = rows.reduce(
      (max, row) => Math.max(max, row.incoming / 100, row.outgoing / 100),
      1,
    );
    const netMax = rows.reduce(
      (max, row) => Math.max(max, Math.abs(row.net) / 100),
      1,
    );
    const ticks = new Intl.NumberFormat("zh-CN", {
      notation: "compact",
      maximumFractionDigits: 1,
    });
    return {
      animation: false,
      title: [
        { text: "← 收款", left: "27.5%" },
        { text: "付款 →", left: "52.5%" },
        { text: "净额（收−支）", left: "81.5%" },
      ].map((title) => ({
        ...title,
        top: 4,
        textAlign: "center" as const,
        textStyle: { fontSize: 13, fontWeight: 500 },
      })),
      axisPointer: { link: [{ yAxisIndex: "all" }] },
      tooltip: {
        trigger: "axis",
        renderMode: "richText",
        axisPointer: { type: "shadow" },
        formatter: (params: any) => {
          const entry = (Array.isArray(params) ? params : [params])[0];
          const party = rows.find((row) => row.key === entry?.data?.partyKey);
          return party
            ? `${party.counterparty}\n收款：¥ ${Money.format(party.incoming)}\n付款：¥ ${Money.format(party.outgoing)}\n净收付：¥ ${Money.format(party.net)}\n收付合计：¥ ${Money.format(PartyMetrics.gross(party))}\n交易笔数：${party.count}`
            : "";
        },
      },
      grid: [
        { left: "16%", width: "23%" },
        { left: "41%", width: "23%" },
        { left: "73%", width: "17%" },
      ].map((grid) => ({ ...grid, top: 44, bottom: 32 })),
      xAxis: [0, 1, 2].map((index) => ({
        gridIndex: index,
        type: "value" as const,
        inverse: index === 0,
        min: index === 2 ? -netMax * 1.35 : 0,
        max: index === 2 ? netMax * 1.35 : movementMax,
        splitNumber: index === 2 ? 2 : 3,
        axisLabel: {
          hideOverlap: true,
          formatter: (value: number) => ticks.format(value),
        },
      })),
      yAxis: [0, 1, 2].map((index) => ({
        gridIndex: index,
        type: "category" as const,
        inverse: true,
        data: rows.map((row) => row.key),
        triggerEvent: true,
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: {
          show: index === 0,
          width: 120,
          margin: 12,
          overflow: "truncate" as const,
          formatter: (key: string) => names.get(key) || key,
        },
      })),
      dataZoom: scroll
        ? [
            {
              type: "slider",
              yAxisIndex: [0, 1, 2],
              orient: "vertical",
              right: 4,
              width: 18,
              startValue: 0,
              endValue: 9,
              zoomLock: true,
              brushSelect: false,
              showDetail: false,
            },
            {
              type: "inside",
              yAxisIndex: [0, 1, 2],
              startValue: 0,
              endValue: 9,
              zoomOnMouseWheel: false,
              moveOnMouseWheel: true,
              moveOnMouseMove: true,
            },
          ]
        : [],
      series: [
        { name: "收款", direction: "incoming", color: "#6d9e8a" },
        { name: "付款", direction: "outgoing", color: "#b78863" },
        { name: "净额", direction: "net", color: "#6d9e8a" },
      ].map(({ name, direction, color }, index) => ({
        name,
        type: "bar" as const,
        xAxisIndex: index,
        yAxisIndex: index,
        barMaxWidth: 16,
        itemStyle: {
          color,
          borderRadius: index === 0 ? [3, 0, 0, 3] : [0, 3, 3, 0],
        },
        emphasis: { focus: "series" as const },
        data: rows.map((row) => ({
          value: row[direction] / 100,
          partyKey: row.key,
          displayName: row.counterparty,
          ...(direction === "net" && {
            itemStyle: {
              color: row.net < 0 ? "#b78863" : row.net > 0 ? "#6d9e8a" : "#8b9690",
              borderRadius: row.net < 0 ? [3, 0, 0, 3] : [0, 3, 3, 0],
            },
            label: {
              show: true,
              position: row.net < 0 ? "left" as const : "right" as const,
              distance: 5,
              width: 76,
              overflow: "truncate" as const,
              formatter: () => `${row.net > 0 ? "+" : ""}${Money.format(row.net)}`,
            },
          }),
        })),
      })),
    };
  }
  render() {
    const { account, loading, onSelect } = this.props;
    const source = account.counterparties?.parties;
    const rows = this.ranked();
    return (
      <Card
        title="对手交易方收付对比"
        className="mb counterparty-movement-card"
        extra={
          <Space className="counterparty-movement-toolbar" wrap>
            <span className="muted">排序</span>
            <Select<SortMetric>
              aria-label="交易方收付图排序指标"
              value={this.state.metric}
              disabled={loading}
              options={CounterpartyMovementChart.metrics}
              onChange={(metric) => this.setState({ metric })}
            />
            <Select<SortOrder>
              aria-label="交易方收付图排序方向"
              value={this.state.order}
              disabled={loading}
              options={[
                { value: "desc", label: "从高到低" },
                { value: "asc", label: "从低到高" },
              ]}
              onChange={(order) => this.setState({ order })}
            />
          </Space>
        }
      >
        <p className="muted single-account-flow-note">
          从本账户看收款与付款，包含退款和内部转账，不含期初录入及证券估值。
          左收右支使用同一金额刻度，右侧净额＝收款−付款，金额单位为元。
          点击收款或付款查看该方向的交易，点击净额或交易方名称查看其全部往来。
          {rows.length > 10 && ` 共 ${rows.length} 个交易方，滚动图表或拖动右侧滑块查看全部。`}
        </p>
        {rows.length ? (
          <div
            className="counterparty-movement-scroll"
            role="region"
            aria-label="交易方收付款与净额图表，可横向滚动"
            tabIndex={0}
          >
            <Chart
              label={`${account.name}对手交易方收款与付款对比图`}
              style={{
                minWidth: 860,
                height: Math.max(280, Math.min(rows.length, 10) * 44 + 80),
              }}
              option={this.chartOption(rows)}
              onClick={(params) => {
                if (
                  this.props.loading ||
                  this.props.account.id !== account.id ||
                  this.props.account.counterparties?.parties !== source
                ) return;
                const selection = this.selection(params);
                if (!loading && selection) onSelect(selection);
              }}
            />
          </div>
        ) : (
          <Empty
            description={loading ? "正在更新交易方收付" : "当前区间没有交易方往来"}
          />
        )}
      </Card>
    );
  }
}
