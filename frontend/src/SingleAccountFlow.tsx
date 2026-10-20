import React from "react";
import { Button, Card, Empty, Select, Space } from "antd";
import { DisplayMoneyFormatter as Money, type Row } from "./api";
import { DistributionDiagram } from "./DistributionDiagram";
import type { SingleAccountSelection } from "./SingleAccountDrilldown";
import {
  SingleAccountFlowData,
  type SingleAccountFlowMode,
} from "./SingleAccountFlowData";

interface Props {
  account: Row;
  mode: SingleAccountFlowMode;
  loading: boolean;
  onSelect: (scope: SingleAccountSelection) => void;
}

/** Account-local charts always pass explicit transaction identities to details. */
export class SingleAccountFlow extends React.Component<
  Props,
  { partyView: "top8" | "all" }
> {
  state: { partyView: "top8" | "all" } = { partyView: "top8" };

  render() {
    const { account, mode, loading, onSelect } = this.props;
    const counterparties = mode === "counterparties";
    const data = new SingleAccountFlowData(account, mode, {
      partyLimit:
        counterparties && this.state.partyView === "top8" ? 8 : undefined,
    });
    return (
      <Card
        className="mb single-account-flow-card"
        title={counterparties ? "交易方往来流向" : "账户资金变动流向"}
        extra={
          <Space className="single-account-flow-toolbar" wrap>
            {counterparties && data.partyCount > 8 && (
              <Select
                className="single-account-flow-limit"
                aria-label="交易方桑基图显示范围"
                value={this.state.partyView}
                disabled={loading}
                options={[
                  { value: "top8", label: "往来规模前8位" },
                  { value: "all", label: "全部交易方" },
                ]}
                onChange={(partyView) => this.setState({ partyView })}
              />
            )}
            <Button
              size="small"
              disabled={loading || !data.nodes.length}
              onClick={() => {
                if (!loading) onSelect(data.all());
              }}
            >
              全部图中交易
            </Button>
          </Space>
        }
      >
        <p className="muted single-account-flow-note">
          {counterparties ? "往来净收付" : "图中账户净变动"}{" "}
          {data.signedTotal > 0 ? "+" : ""}¥ {Money.format(data.signedTotal)}；
          流入 ¥ {Money.format(data.incoming)}，流出 ¥{" "}
          {Money.format(data.outgoing)}。
          线宽按流入与流出合计计算，点击节点或连线核对整笔交易。
        </p>
        {data.nodes.length ? (
          <DistributionDiagram
            data={data}
            label={`${account.name}${counterparties ? "交易方往来" : "账户资金变动"}桑基图`}
            columns={
              counterparties
                ? ["往来总额", "收款 / 付款", "交易方"]
                : ["资金方向", "变动类型", "收支分类 / 对端账户"]
            }
            onSelect={(selection) => {
              if (!loading) onSelect(selection as SingleAccountSelection);
            }}
          />
        ) : (
          <Empty
            description={
              loading
                ? "正在更新账户流向"
                : counterparties
                  ? "当前区间没有普通交易方往来"
                  : "当前区间没有实际账户变动"
            }
          />
        )}
        <details className="analysis-method">
          <summary>统计口径与图示</summary>
          <p className="muted single-account-flow-note">
            {counterparties
              ? "收付合计衡量实际往来规模，净收付为收款减付款；两者都不等同于家庭收入或投资收益。包含退款和内部转账，不含期初录入及证券估值。"
              : "按本账户实际余额变动列示，收入、付款、退款、内部转账、证券估值和调整分别展示。分类能够核对时按分摊金额绘图，点击后查看整笔交易；内部转入不是新增家庭收入。"}
            {counterparties &&
              data.partyCount > data.displayedPartyCount &&
              " 默认按收款＋付款合计取前8位，其余合并显示；选择“全部交易方”可完整展开。合并节点仍保留准确交易范围。"}
            {counterparties &&
              data.excludedValuationCount > 0 &&
              ` 已另列 ${data.excludedValuationCount} 笔证券估值，不计入此图。`}
          </p>
          {data.allocationNotes.map((note) => (
            <p key={note} className="muted single-account-flow-note">
              {note}
            </p>
          ))}
        </details>
        {data.unavailableCount > 0 && (
          <p className="muted single-account-flow-note">
            有 {data.unavailableCount}{" "}
            条记录未提供可核对的账户变动金额，未绘入图中；可在完整明细中查看。
          </p>
        )}
      </Card>
    );
  }
}
