import React from "react";
import * as echarts from "echarts";

/** Shared lifecycle and resize handling for overview and analytical charts. */
export class Chart extends React.Component<{
  option: echarts.EChartsOption;
  label?: string;
  onClick?: (params: any) => void;
}> {
  el = React.createRef<HTMLDivElement>();
  chart?: echarts.ECharts;
  observer?: ResizeObserver;
  componentDidMount() {
    this.chart = echarts.init(this.el.current!);
    this.chart.setOption(this.props.option);
    this.chart.on("click", (params) => this.props.onClick?.(params));
    this.observer = new ResizeObserver(() => this.chart?.resize());
    this.observer.observe(this.el.current!);
  }
  componentDidUpdate() {
    this.chart?.setOption(this.props.option, true);
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
        role="img"
        aria-label={this.props.label}
      />
    );
  }
}
