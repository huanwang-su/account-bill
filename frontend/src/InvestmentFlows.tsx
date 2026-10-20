import React from "react";
import { Button, Card, Empty } from "antd";
import { DisplayMoneyFormatter as Money, Row } from "./api";
import { AccountDistribution } from "./AccountDistribution";
import { DistributionDiagram } from "./DistributionDiagram";
import { InvestmentDistribution } from "./InvestmentDistribution";

export class InvestmentFlows extends React.Component<{
  report: Row;
  accounts: Row[];
  groups: Row[];
  onAccount?: (id: number) => void;
  onSelect?: (selection: Row) => void;
}> {
  render() {
    const { report, accounts, groups, onAccount, onSelect } = this.props;
    const data = new InvestmentDistribution(report, accounts, groups);
    return (
      <div className="balance-sheet-distributions">
        {(
          [
            ["理财资产分布", data.assets, false],
            ["理财收益分布", data.returns, true],
          ] as const
        ).map(([title, chart, returns]) => (
          <Card
            className="balance-flow-card"
            title={title}
            key={title}
            extra={
              <strong>
                {returns ? "期间净收益 " : "期末余额 "}¥{" "}
                {Money.format(chart.total)}
              </strong>
            }
          >
            <p className="balance-flow-hint">
              {returns
                ? `${report.start} 至 ${report.end}：分别看净盈利与净亏损账户，连线宽度取净收益的绝对金额，两侧独立计算占比。`
                : `截至 ${report.end} 日末：先看正余额分布，再核对负余额抵减；按直属账户组展开到账户。`}
              点击节点或连线打开局部明细。
            </p>
            {chart.nodes.length ? (
              <DistributionDiagram
                data={chart}
                label={`${title}桑基图：总额、账户组、账户`}
                onAccount={onAccount}
                onSelect={onSelect}
              />
            ) : (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={
                  returns
                    ? "所选区间暂无账户净盈亏"
                    : "所选日期没有正余额可绘图"
                }
              />
            )}
            {!returns && chart.adjustments.length > 0 && (
              <div className="balance-flow-adjustments">
                <strong>负余额抵减</strong>
                {chart.adjustments.map((a) => (
                  <div key={a.id}>
                    <span>
                      <Button
                        type="link"
                        size="small"
                        onClick={() =>
                          onSelect
                            ? onSelect({
                                namespace: "investment:asset",
                                level: "account",
                                account_id: a.id,
                                group_id: a.group_id ?? 0,
                                label: a.name,
                              })
                            : onAccount?.(a.id)
                        }
                      >
                        {AccountDistribution.path(groups, a.group_id) ||
                          "未分组"}{" "}
                        / {a.name}
                      </Button>
                    </span>
                    <span>¥ {Money.format(a.amount)}</span>
                  </div>
                ))}
                <p>
                  正额 ¥ {Money.format(chart.positiveTotal)} ＋ 抵减 ¥{" "}
                  {Money.format(chart.total - chart.positiveTotal)} ＝ 理财资产
                  ¥ {Money.format(chart.total)}
                </p>
              </div>
            )}
            <p className="balance-flow-footnote">
              {returns
                ? "每个账户先汇总区间净收益，再区分盈利与亏损；零净收益账户保留在明细表。"
                : "期末余额包含已记本金与损益；零余额账户保留在明细表，本金进出在上方单列。"}
            </p>
          </Card>
        ))}
      </div>
    );
  }
}
