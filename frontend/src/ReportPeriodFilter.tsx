import React from "react";
import { Button, DatePicker, Select } from "antd";
import dayjs from "dayjs";
import { LedgerApi, type Row } from "./api";

/** Shared presets use the latest recorded month, rather than the computer month. */
export class ReportPeriodFilter extends React.Component<
  {
    filters: Row;
    onChange: (patch: Row) => void;
    label?: string;
    refreshKey?: string;
    mode?: "range" | "snapshot";
    allowAll?: boolean;
  },
  { resolved?: Row; loading: boolean; error?: string; snapshotPreset?: string }
> {
  api = new LedgerApi();
  version = 0;
  state: {
    resolved?: Row;
    loading: boolean;
    error?: string;
    snapshotPreset?: string;
  } = {
    loading: true,
  };
  static defaults(): Row {
    return { period: "latest_month" };
  }
  static preset(filters: Row) {
    return (
      filters.period ||
      (filters.start || filters.end ? "custom" : "latest_month")
    );
  }
  componentDidMount() {
    this.resolve();
  }
  componentDidUpdate(previous: Readonly<typeof this.props>) {
    if (
      previous.refreshKey !== this.props.refreshKey ||
      JSON.stringify([
        previous.filters.period,
        previous.filters.start,
        previous.filters.end,
        previous.filters.as_of,
      ]) !==
        JSON.stringify([
          this.props.filters.period,
          this.props.filters.start,
          this.props.filters.end,
          this.props.filters.as_of,
        ])
    )
      this.resolve();
  }
  componentWillUnmount() {
    this.version++;
  }
  async resolve(preset?: string, apply = false) {
    const version = ++this.version;
    const chosen = preset || ReportPeriodFilter.preset(this.props.filters);
    if (chosen === "all" && this.props.allowAll) {
      this.setState({ loading: false, error: undefined });
      if (apply || this.props.filters.start || this.props.filters.end)
        this.props.onChange({
          period: "all",
          start: undefined,
          end: undefined,
        });
      return;
    }
    this.setState({ loading: true, error: undefined });
    try {
      const data = await this.api.request(
        "/reports/period?" +
          this.api.query({
            period:
              chosen === "custom" || this.props.mode === "snapshot"
                ? "latest_month"
                : chosen,
          }),
      );
      if (version !== this.version) return;
      this.setState({ resolved: data, loading: false });
      if (
        apply ||
        (this.props.mode !== "snapshot" &&
          chosen !== "custom" &&
          (this.props.filters.start !== data.start ||
            this.props.filters.end !== data.end))
      )
        this.props.onChange({
          period: chosen,
          start: data.start,
          end: data.end,
        });
    } catch (error) {
      if (version === this.version)
        this.setState({
          loading: false,
          error: error instanceof Error ? error.message : "统计时间加载失败",
        });
    }
  }
  render() {
    const { filters, label, onChange, mode } = this.props;
    const { resolved, loading, error } = this.state;
    const all = this.props.allowAll && filters.period === "all";
    const start = all ? undefined : filters.start || resolved?.start,
      end = all ? undefined : filters.end || resolved?.end;
    const snapshot = mode === "snapshot";
    const cutoff =
      filters.as_of || resolved?.latest_data_date || resolved?.today;
    return (
      <div
        className="report-period-controls"
        aria-label={snapshot ? "截止日期过滤" : "统计区间过滤"}
      >
        <span>{snapshot ? "截至日期" : "统计区间"}</span>
        <Select
          aria-label={snapshot ? "截止日期快捷范围" : "时间快捷范围"}
          style={{ width: 200 }}
          loading={loading}
          disabled={loading}
          value={
            snapshot
              ? this.state.snapshotPreset ||
                (cutoff === resolved?.latest_data_date
                  ? "latest"
                  : cutoff === resolved?.today
                    ? "today"
                    : "custom")
              : ReportPeriodFilter.preset(filters)
          }
          options={
            snapshot
              ? [
                  { value: "latest", label: "最新账务日" },
                  { value: "today", label: "今天" },
                  { value: "custom", label: "指定日期" },
                ]
              : [
                  ...(this.props.allowAll
                    ? [{ value: "all", label: "全部日期" }]
                    : []),
                  { value: "latest_month", label: "最新数据所在整月" },
                  { value: "1m", label: "最近 1 个月" },
                  { value: "3m", label: "最近 3 个月" },
                  { value: "6m", label: "最近 6 个月" },
                  { value: "1y", label: "最近 1 年" },
                  { value: "custom", label: "指定区间" },
                ]
          }
          onChange={(period) => {
            if (snapshot) {
              this.setState({ snapshotPreset: period });
              if (period !== "custom")
                onChange({
                  as_of:
                    period === "today"
                      ? resolved?.today
                      : resolved?.latest_data_date || resolved?.today,
                });
            } else if (period === "custom") {
              if (start && end) onChange({ period, start, end });
              else this.resolve("custom", true);
            } else this.resolve(period, true);
          }}
        />
        {snapshot ? (
          <DatePicker
            aria-label={label || "截至日期"}
            allowClear={false}
            value={cutoff ? dayjs(cutoff) : null}
            onChange={(value) => {
              if (value) {
                this.setState({ snapshotPreset: "custom" });
                onChange({ as_of: value.format("YYYY-MM-DD") });
              }
            }}
          />
        ) : (
          <DatePicker.RangePicker
            aria-label={label || "统计日期"}
            allowClear={false}
            value={start && end ? [dayjs(start), dayjs(end)] : null}
            onChange={(values) =>
              values?.[0] &&
              values[1] &&
              onChange({
                period: "custom",
                start: values[0].format("YYYY-MM-DD"),
                end: values[1].format("YYYY-MM-DD"),
              })
            }
          />
        )}
        <Button
          disabled={loading}
          onClick={() =>
            snapshot
              ? (this.setState({ snapshotPreset: "latest" }),
                onChange({
                  as_of: resolved?.latest_data_date || resolved?.today,
                }))
              : this.resolve("latest_month", true)
          }
        >
          重置范围
        </Button>
        {error && (
          <small className="balance-negative" role="alert">
            {error}
            <Button type="link" onClick={() => this.resolve()}>
              重试
            </Button>
          </small>
        )}
      </div>
    );
  }
}
