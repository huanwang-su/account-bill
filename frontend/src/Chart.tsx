import React from "react";
import { AppearanceContext, ResolvedAppearance } from "./Appearance";
import { ChartAppearance } from "./ChartAppearance";
import * as echarts from "echarts";

/** Shared lifecycle and resize handling for overview and analytical charts. */
export class Chart extends React.Component<{
  option: echarts.EChartsOption;
  label?: string;
  style?: React.CSSProperties;
  onClick?: (params: any) => void;
}> {
  static contextType = AppearanceContext;
  declare context: React.ContextType<typeof AppearanceContext>;
  currentAppearance?: ResolvedAppearance;
  currentReducedMotion?: boolean;
  currentOption?: echarts.EChartsOption;
  el = React.createRef<HTMLDivElement>();
  chart?: echarts.ECharts;
  observer?: ResizeObserver;
  componentDidMount() {
    this.draw();
    this.observer = new ResizeObserver(() => this.chart?.resize());
    this.observer.observe(this.el.current!);
  }
  draw() {
    const { resolved: mode, reducedMotion } = this.context;
    if (!this.chart) {
      // ChartAppearance supplies both light and dark defaults without replacing
      // the canvas or its click handler when the palette changes.
      this.chart = echarts.init(this.el.current!);
      this.chart.on("click", (params) => this.props.onClick?.(params));
    }
    if (
      this.currentOption === this.props.option &&
      this.currentAppearance === mode &&
      this.currentReducedMotion === reducedMotion
    )
      return;
    this.chart.setOption(
      ChartAppearance.option(this.props.option, mode, reducedMotion),
      true,
    );
    this.currentAppearance = mode;
    this.currentReducedMotion = reducedMotion;
    this.currentOption = this.props.option;
  }
  componentDidUpdate() {
    this.draw();
  }
  componentWillUnmount() {
    this.observer?.disconnect();
    this.chart?.dispose();
  }
  render() {
    return (
      <div
        ref={this.el}
        className="chart"
        style={this.props.style}
        role="img"
        aria-label={this.props.label}
      />
    );
  }
}
