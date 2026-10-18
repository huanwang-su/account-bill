import React from "react";
import { Button, Card, Empty } from "antd";
import { MoneyFormatter as Money, Row } from "./api";
import { DistributionDiagram } from "./DistributionDiagram";
export { distributionOption } from "./DistributionDiagram";
import {
  BalanceSheetDistribution,
  BalanceSheetAccountTag,
  BalanceSheetStructure,
} from "./BalanceSheetStructure";

/** Both sides keep their own monetary scale; widths describe each side's distribution. */
export class BalanceSheetFlow extends React.Component<{
  snapshot: Row;
  role: string;
  onSelect?: (selection: Row) => void;
}> {
  render() {
    const { snapshot, role } = this.props;
    const statement = new BalanceSheetStructure(snapshot);
    const data = new BalanceSheetDistribution(statement, role);
    const title = role === "ASSET" ? "资产" : "负债";
    return (
      <Card
        className="balance-flow-card"
        title={`${title}分布`}
        extra={<strong>¥ {Money.format(data.total)}</strong>}
      >
        <p className="balance-flow-hint">
          线宽按本图金额比例绘制，悬停查看金额、占比与所属路径；点击节点或连线查看对应明细。
        </p>
        {data.nodes.length ? (
          <DistributionDiagram
            data={data}
            columns={
              role === "ASSET"
                ? ["总资产", "账户组", "账户标签", "账户"]
                : undefined
            }
            label={`${title}分布桑基图：总额、直属账户组、${role === "ASSET" ? "账户标签、" : ""}账户；正额合计 ${Money.format(data.positiveTotal)} 元，账面总额 ${Money.format(data.total)} 元`}
            onSelect={this.props.onSelect}
          />
        ) : (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={`当前条件下没有正额${title}`}
          />
        )}
        {data.adjustments.length > 0 && (
          <div className="balance-flow-adjustments">
            <strong>抵减项</strong>
            {data.adjustments.map((a) => (
              <div key={a.id}>
                <span>
                  <Button
                    type="link"
                    size="small"
                    onClick={() =>
                      this.props.onSelect?.({
                        namespace: role,
                        level: "account",
                        account_id: a.id,
                        group_id: a.group_id ?? 0,
                        label: a.name,
                        ...(role === "ASSET" && {
                          account_tag: BalanceSheetAccountTag.forAccount(a).key,
                          account_tag_label:
                            BalanceSheetAccountTag.forAccount(a).label,
                        }),
                      })
                    }
                  >
                    {statement.path(a.group_id) || "未分组"} / {a.name}
                  </Button>
                </span>
                <span>¥ {Money.format(a.amount)}</span>
              </div>
            ))}
            <p>
              正额 ¥ {Money.format(data.positiveTotal)} ＋ 抵减 ¥{" "}
              {Money.format(data.total - data.positiveTotal)} ＝ 账面总额 ¥{" "}
              {Money.format(data.total)}。负数余额不参与连线宽度。
            </p>
          </div>
        )}
        <p className="balance-flow-footnote">
          账户组按直属账户拆分，父组与子组不重复累计。
          {role === "ASSET" &&
            "账户标签按账户类型归纳，合并账户沿用目标类型，每个账户仅计一次，不修改自定义标签。"}
          {data.zeroCount > 0
            ? `${data.zeroCount} 个零余额账户不绘制，仍保留在下方明细。`
            : ""}
        </p>
      </Card>
    );
  }
}
