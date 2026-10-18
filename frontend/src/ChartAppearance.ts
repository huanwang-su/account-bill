import type { EChartsOption } from "echarts";
import { Appearance, ResolvedAppearance } from "./Appearance";

type Colors = ReturnType<typeof Appearance.colors>;
type Role = "primary" | "positive" | "negative" | "expense";

/** Copies options without losing formatters, then themes labels and axes uniformly. */
export class ChartAppearance {
  static copy(value: any): any {
    if (Array.isArray(value)) return value.map((item) => this.copy(item));
    if (
      value &&
      typeof value === "object" &&
      [Object.prototype, null].includes(Object.getPrototypeOf(value))
    )
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, this.copy(item)]),
      );
    return value;
  }
  static tint(color: string, surface: string, amount: number) {
    return (
      "#" +
      [1, 3, 5]
        .map((offset) =>
          Math.round(
            parseInt(color.slice(offset, offset + 2), 16) * (1 - amount) +
              parseInt(surface.slice(offset, offset + 2), 16) * amount,
          )
            .toString(16)
            .padStart(2, "0"),
        )
        .join("")
    );
  }
  static color(value: any, colors: Colors, role?: Role) {
    if (typeof value !== "string") return value;
    const source = value.toLowerCase();
    const incomeTints: Record<string, number> = {
      "#73a58f": 0.14,
      "#6d9e8a": 0.2,
      "#96c7b1": 0.38,
      "#86aa95": 0.28,
    };
    const primary = ["#326b53", "#275f49", "#2d6452"].includes(source);
    const expense = ["#b78863", "#a47856"].includes(source);
    const income = source in incomeTints;
    // Unknown explicit colors, gradients and callbacks keep their own meaning.
    if (!primary && !expense && !income) return value;
    const target =
      role || (primary ? "primary" : expense ? "expense" : "positive");
    return target === "positive"
      ? this.tint(colors.positive, colors.surface, incomeTints[source] || 0)
      : colors[target];
  }
  static styles(item: any, colors: Colors, role?: Role) {
    for (const key of ["itemStyle", "lineStyle", "areaStyle"])
      if (item[key]?.color !== undefined)
        item[key].color = this.color(item[key].color, colors, role);
    for (const key of ["emphasis", "blur", "select"])
      if (item[key]) this.styles(item[key], colors, role);
  }
  static motion(item: any, reduced: boolean, disabled = false) {
    const off = reduced || disabled || item.animation === false;
    item.animation = !off;
    item.animationDuration = off ? 0 : 320;
    item.animationDurationUpdate = off ? 0 : 220;
    item.animationDelay = 0;
    item.animationDelayUpdate = 0;
    item.animationEasing = "cubicOut";
    item.animationEasingUpdate = "cubicOut";
    item.stateAnimation = {
      ...item.stateAnimation,
      duration: off ? 0 : 120,
      delay: 0,
    };
    if (off) {
      item.universalTransition = false;
      if (item.label) item.label.valueAnimation = false;
    }
  }
  static option(
    input: EChartsOption,
    mode: ResolvedAppearance,
    reducedMotion = false,
  ): EChartsOption {
    const option = this.copy(input),
      colors = Appearance.colors(mode);
    const dark = Appearance.isDark(mode);
    option.backgroundColor = "transparent";
    option.darkMode = dark;
    option.color =
      option.color === undefined
        ? [
            colors.primary,
            colors.positive,
            colors.expense,
            "#819ec0",
            "#9b8fbb",
            "#6aa6aa",
          ]
        : Array.isArray(option.color)
          ? option.color.map((color: any) => this.color(color, colors))
          : this.color(option.color, colors);
    this.motion(option, reducedMotion);
    option.axisPointer = {
      ...option.axisPointer,
      animation: !reducedMotion,
      animationDurationUpdate: reducedMotion ? 0 : 120,
    };
    option.textStyle = {
      ...option.textStyle,
      color: colors.text,
      fontFamily: "-apple-system,PingFang SC,sans-serif",
    };
    const each = (value: any, apply: (item: any) => void) => {
      for (const item of Array.isArray(value) ? value : [value])
        if (item && typeof item === "object") apply(item);
    };
    each(option.legend, (item) => {
      item.textStyle = { ...item.textStyle, color: colors.muted };
      item.pageTextStyle = { ...item.pageTextStyle, color: colors.muted };
    });
    each(option.title, (item) => {
      item.textStyle = { ...item.textStyle, color: colors.text };
      item.subtextStyle = { ...item.subtextStyle, color: colors.muted };
    });
    for (const axis of ["xAxis", "yAxis", "radiusAxis", "angleAxis"])
      each(option[axis], (item) => {
        item.axisLabel = { ...item.axisLabel, color: colors.muted };
        item.nameTextStyle = { ...item.nameTextStyle, color: colors.muted };
        item.axisLine = {
          ...item.axisLine,
          lineStyle: { ...item.axisLine?.lineStyle, color: colors.border },
        };
        item.splitLine = {
          ...item.splitLine,
          lineStyle: { ...item.splitLine?.lineStyle, color: colors.border },
        };
      });
    each(option.series, (item) => {
      const role: Role | undefined =
        item.type === "bar" || item.type === "line"
          ? /净收支|累计|余额/.test(item.name || "")
            ? "primary"
            : /收入|收款/.test(item.name || "")
              ? "positive"
              : /支出|开支|付款/.test(item.name || "")
                ? "expense"
                : undefined
          : undefined;
      this.styles(item, colors, role);
      each(item.data, (point) => {
        if (item.type === "sankey") {
          // Group and link colors identify ownership, so only theme the root.
          if (point.depth === 0) {
            const name = String(point.name || "");
            const rootRole = /income|:gain:|^movement:increase:/.test(name)
              ? "positive"
              : /:loss:/.test(name)
                ? "negative"
                : /expense|LIABILITY|^movement:decrease:/.test(name)
                  ? "expense"
                  : "primary";
            this.styles(point, colors, rootRole);
          }
        } else {
          this.styles(
            point,
            colors,
            point.value < 0 && point.itemStyle?.color === "#b78863"
              ? "negative"
              : undefined,
          );
        }
      });
      item.label = { ...item.label, color: colors.text };
      this.motion(item, reducedMotion, option.animation === false);
      if (item.emphasis?.label)
        item.emphasis.label = { ...item.emphasis.label, color: colors.text };
      if (item.type === "sankey" && dark)
        item.lineStyle = { ...item.lineStyle, opacity: 0.42 };
    });
    each(option.tooltip, (item) => {
      item.backgroundColor = colors.surface;
      item.borderColor = colors.border;
      item.textStyle = { ...item.textStyle, color: colors.text };
      item.transitionDuration = reducedMotion ? 0 : 0.12;
      item.axisPointer = {
        ...item.axisPointer,
        animation: !reducedMotion,
        animationDurationUpdate: reducedMotion ? 0 : 120,
        lineStyle: { ...item.axisPointer?.lineStyle, color: colors.muted },
        crossStyle: { ...item.axisPointer?.crossStyle, color: colors.muted },
        label: {
          ...item.axisPointer?.label,
          color: colors.text,
          backgroundColor: colors.soft,
        },
      };
    });
    return option;
  }
}
