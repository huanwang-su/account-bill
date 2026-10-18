import React from "react";
import { Button, Tag } from "antd";
import dayjs from "dayjs";
import { AppearanceContext } from "./Appearance";

export interface DetailPeriod {
  start: string;
  end: string;
  label: string;
}

/** Translate chart buckets to explicit detail dates without altering report scope. */
export class ReportDrilldown {
  static period(
    value: unknown,
    grain: "day" | "month" = "day",
    bounds?: { start?: string; end?: string },
  ): DetailPeriod | undefined {
    if (typeof value !== "string") return undefined;
    const match = value.match(
      grain === "month" ? /^\d{4}-\d{2}(?:-\d{2})?$/ : /^\d{4}-\d{2}-\d{2}$/,
    );
    if (!match) return undefined;
    const raw = grain === "month" ? value.slice(0, 7) + "-01" : value;
    const date = dayjs(raw);
    if (!date.isValid() || date.format("YYYY-MM-DD") !== raw) return undefined;
    const first = date.format("YYYY-MM-DD");
    const last =
      grain === "month" ? date.endOf("month").format("YYYY-MM-DD") : first;
    const start = bounds?.start && bounds.start > first ? bounds.start : first;
    const end = bounds?.end && bounds.end < last ? bounds.end : last;
    if (start > end) return undefined;
    return { start, end, label: start === end ? start : `${start} 至 ${end}` };
  }

  static contains(period: DetailPeriod | undefined, occurredAt?: string) {
    if (!period) return true;
    const day = occurredAt?.slice(0, 10);
    return !!day && day >= period.start && day <= period.end;
  }
}

export interface DrilldownItem {
  key: string;
  label: string;
  onClear?: () => void;
}

/** A local scope indicator beside the detail block it controls. */
export class AnalysisDrilldownBar extends React.Component<{
  label?: string;
  items: DrilldownItem[];
  onReset: () => void;
  resetLabel?: string;
  emptyText?: string;
  elementRef?: React.Ref<HTMLElement>;
}> {
  static contextType = AppearanceContext;
  declare context: React.ContextType<typeof AppearanceContext>;

  render() {
    const {
      label = "明细范围",
      items,
      onReset,
      resetLabel = "清除联动",
      emptyText = "点击图表或排行查看对应明细",
    } = this.props;
    return (
      <section
        className="analysis-drilldown-bar"
        aria-label={label}
        ref={this.props.elementRef}
        data-detail-selected={items.length ? "true" : undefined}
        data-reduced-motion={this.context?.reducedMotion ? "true" : undefined}
      >
        <div className="analysis-drilldown-scope" aria-live="polite">
          <strong>{label}</strong>
          {items.length ? (
            items.map((item) => (
              <Tag
                key={item.key}
                closable={!!item.onClear}
                onClose={(event) => {
                  event.preventDefault();
                  item.onClear?.();
                }}
              >
                {item.label}
              </Tag>
            ))
          ) : (
            <span className="muted">{emptyText}</span>
          )}
        </div>
        <Button size="small" disabled={!items.length} onClick={onReset}>
          {resetLabel}
        </Button>
      </section>
    );
  }
}
