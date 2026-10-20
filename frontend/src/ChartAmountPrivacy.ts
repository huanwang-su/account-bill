import type { EChartsOption } from "echarts";
import { AmountPrivacy } from "./AmountPrivacy";
import { ChartAppearance } from "./ChartAppearance";

/** Mask chart text, retaining values and identities for layout and drill-down. */
export class ChartAmountPrivacy {
  static option(
    input: EChartsOption,
    hidden: boolean,
    copy = true,
  ): EChartsOption {
    if (!hidden) return input;
    const option = copy ? ChartAppearance.copy(input) : input;
    const each = (value: any, apply: (item: any) => void) => {
      for (const item of Array.isArray(value) ? value : [value])
        if (item && typeof item === "object") apply(item);
    };
    const names = new Map<string, string>();
    each(option.series, (series) =>
      each(series.data, (data) => {
        if (data.name) names.set(data.name, data.displayName || data.name);
      }),
    );
    const caption = (params: any): string => {
      const data = params.data;
      if (params.dataType === "edge")
        return `${names.get(data.source) || data.source} → ${names.get(data.target) || data.target}`;
      return data?.path || data?.displayName || params.name || "";
    };
    const label = (params: any) => {
      const name = caption(params);
      return (name ? name + "\n" : "") + AmountPrivacy.mask;
    };
    const tooltip = (params: any) => {
      const rows = Array.isArray(params) ? params : [params];
      return rows
        .map((row) => {
          const name = caption(row);
          const series =
            row.seriesName && !row.seriesName.startsWith("series\0")
              ? row.seriesName
              : "";
          return [name, series !== name ? series : "", AmountPrivacy.mask]
            .filter(Boolean)
            .join(" · ");
        })
        .join("\n");
    };
    // Replace both default tooltips and explicit template/callback formatters.
    // Rich text avoids interpreting counterparty names as HTML.
    const maskTooltip = (item: any) => {
      item.tooltip = {
        ...item.tooltip,
        renderMode: "richText",
        formatter: tooltip,
        valueFormatter: () => AmountPrivacy.mask,
      };
    };
    maskTooltip(option);
    const pointer = (item: any) => {
      item.axisPointer = {
        ...item.axisPointer,
        label: {
          ...item.axisPointer?.label,
          formatter: () => AmountPrivacy.mask,
        },
      };
    };
    pointer(option);
    pointer(option.tooltip);
    for (const key of ["xAxis", "yAxis", "radiusAxis", "angleAxis"])
      each(option[key], (axis) => {
        if (
          axis.type === "category" ||
          axis.type === "time" ||
          (!axis.type && axis.data)
        )
          return;
        axis.axisLabel = {
          ...axis.axisLabel,
          formatter: () => AmountPrivacy.mask,
        };
        pointer(axis);
      });
    const labels = (item: any) => {
      for (const key of ["label", "endLabel", "edgeLabel"])
        item[key] = { ...item[key], formatter: label };
      for (const state of ["emphasis", "select", "blur"])
        if (item[state]) labels(item[state]);
    };
    each(option.series, (series) => {
      labels(series);
      maskTooltip(series);
      series.animation = false;
      series.universalTransition = false;
      for (const key of ["data", "links", "edges", "levels"])
        each(series[key], (item) => {
          labels(item);
          if (item.tooltip) maskTooltip(item);
        });
      for (const key of ["markLine", "markPoint", "markArea"])
        if (series[key]) {
          labels(series[key]);
          maskTooltip(series[key]);
          each(series[key].data, (item) => {
            labels(item);
            each(item, labels);
          });
        }
    });
    each(option.dataZoom, (zoom) => {
      zoom.showDetail = false;
    });
    if (option.toolbox?.feature?.dataView)
      option.toolbox.feature.dataView.show = false;
    option.aria = { ...option.aria, enabled: false };
    option.animation = false;
    return option;
  }
}
