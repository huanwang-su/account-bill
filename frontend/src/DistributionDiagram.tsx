import React from "react";
import type { EChartsOption } from "echarts";
import { MoneyFormatter as Money, type Row } from "./api";
import { Chart } from "./Chart";
import type { AccountDistribution } from "./AccountDistribution";
export type DistributionData = Pick<
  AccountDistribution,
  "nodes" | "links" | "positiveTotal" | "adjustments" | "height"
> & { selection?: (params: any) => Row | undefined };
export function distributionOption(
  data: DistributionData,
  columnCount?: number,
  compact = false,
): EChartsOption {
  const fourColumns =
    data.nodes.reduce(
      (count, node) => Math.max(count, node.depth + 1),
      columnCount || 3,
    ) > 3;
  const nodes = new Map(data.nodes.map((n) => [n.name, n]));
  const share = (value: number, total = data.positiveTotal) => {
    const percent = total ? (100 * value) / total : 0;
    return percent > 0 && percent < 0.1 ? "<0.1%" : `${percent.toFixed(1)}%`;
  };
  return {
    animation: false,
    tooltip: {
      trigger: "item",
      renderMode: "richText",
      confine: true,
      formatter: (params: any) => {
        const row = params.data;
        if (params.dataType === "edge") {
          return `${nodes.get(row.source)?.displayName} → ${nodes.get(row.target)?.displayName}\n¥ ${Money.format(row.signedValue ?? row.value)}\n占${row.shareLabel || (data.adjustments.length ? "正额" : "总额")} ${share(row.value, row.shareTotal)}`;
        }
        return `${row.path}\n¥ ${Money.format(row.signedValue ?? row.value)}\n占${row.shareLabel || (data.adjustments.length ? "正额" : "总额")} ${share(row.value, row.shareTotal)}`;
      },
    },
    series: [
      {
        type: "sankey",
        left: 32,
        right: compact ? 180 : fourColumns ? 220 : 250,
        top: 24,
        bottom: 24,
        nodeWidth: fourColumns ? 16 : 18,
        nodeGap: 38,
        nodeAlign: "justify",
        orient: "horizontal",
        layoutIterations: 0,
        draggable: false,
        data: data.nodes,
        links: data.links,
        lineStyle: { opacity: 0.28, curveness: 0.48 },
        itemStyle: { borderWidth: 0 },
        label: {
          position: "right",
          color: "#31453b",
          fontSize: 12,
          lineHeight: 18,
          distance: 9,
          width: compact ? 150 : fourColumns ? 170 : 215,
          overflow: "truncate",
          formatter: (params: any) =>
            `${params.data.displayName}\n¥ ${Money.format(params.data.signedValue ?? params.data.value)}`,
        },
        emphasis: { focus: "trajectory", lineStyle: { opacity: 0.6 } },
        blur: { itemStyle: { opacity: 0.2 }, lineStyle: { opacity: 0.07 } },
      },
    ],
  };
}

export class DistributionDiagram extends React.Component<{
  data: DistributionData;
  label: string;
  onAccount?: (id: number) => void;
  onSelect?: (selection: Row) => void;
  onNode?: (params: any) => void;
  onEdge?: (params: any) => void;
  columns?: string[];
  compact?: boolean;
}> {
  render() {
    const columns = this.props.columns || ["总额", "账户组", "账户"];
    const fourColumns = columns.length > 3;
    return (
      <div className="balance-flow-scroll">
        <div
          className={`balance-flow-canvas${fourColumns ? " balance-flow-canvas-four" : ""}${this.props.compact ? " balance-flow-canvas-compact" : ""}`}
        >
          <div
            className={`balance-flow-columns${fourColumns ? " balance-flow-columns-four" : ""}`}
            aria-hidden="true"
          >
            {columns.map((column, index) => (
              <span
                key={`${index}-${column}`}
                style={
                  columns.length !== 3 || this.props.compact
                    ? {
                        left: `calc(${(index * 100) / (columns.length - 1)}% + ${32 - (index * (32 + (this.props.compact ? 180 + 18 : fourColumns ? 220 + 16 : 250 + 18))) / (columns.length - 1)}px)`,
                      }
                    : undefined
                }
              >
                {column}
              </span>
            ))}
          </div>
          <Chart
            option={distributionOption(
              this.props.data,
              columns.length,
              this.props.compact,
            )}
            style={{ height: this.props.data.height }}
            label={this.props.label}
            onClick={(params) => {
              const selection =
                this.props.data.selection?.(params) || params.data?.selection;
              if (selection) this.props.onSelect?.({ ...selection });
              if (params.dataType === "node") {
                this.props.onNode?.(params);
                if (params.data?.accountId)
                  this.props.onAccount?.(params.data.accountId);
              } else if (params.dataType === "edge")
                this.props.onEdge?.(params);
            }}
          />
        </div>
      </div>
    );
  }
}
