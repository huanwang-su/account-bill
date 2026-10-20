import React from "react";
import { Button, Card, Empty } from "antd";
import { DisplayMoneyFormatter as Money, type Row } from "./api";
import { AccountDistribution } from "./AccountDistribution";
import {
  BalanceSheetAccountTag,
  BalanceSheetStructure,
} from "./BalanceSheetStructure";
import { DistributionDiagram } from "./DistributionDiagram";

/** The statement's exclusive tags, rolled up before individual accounts. */
export class OverviewBalanceDistribution extends AccountDistribution {
  rows: Row[];
  constructor(
    snapshot: Row,
    public role: string,
  ) {
    const rows = new BalanceSheetStructure(snapshot).accounts(role);
    super(snapshot.groups, rows, {
      namespace: role,
      title: role === "ASSET" ? "资产" : "负债",
      rootColor: role === "ASSET" ? "#326b53" : "#a47856",
      accountTag: (row) => OverviewBalanceDistribution.tag(row),
    });
    this.rows = rows;
    this.nodes = this.nodes.filter((node) => node.depth < 3);
    const names = new Set(this.nodes.map((node) => node.name));
    this.links = this.links.filter((link) => names.has(link.target));
    this.height = Math.max(
      320,
      this.nodes.filter((node) => node.depth === 2).length * 58 + 64,
    );
  }
  static tag(row: Row) {
    if (
      row.role === "LIABILITY" &&
      ["公司贷款", "房贷", "信用卡"].includes(row.kind)
    )
      return { key: `liability:${row.kind}`, label: row.kind };
    return BalanceSheetAccountTag.forAccount(row);
  }
  matching(selection: Row): Row[] {
    return this.rows
      .filter((row) => {
        if (selection.level === "account")
          return row.id === selection.account_id;
        if (row.amount <= 0) return false;
        if (selection.level === "root") return true;
        if ((row.group_id ?? 0) !== selection.group_id) return false;
        return (
          selection.level === "group" ||
          (selection.level === "tag" &&
            OverviewBalanceDistribution.tag(row).key === selection.account_tag)
        );
      })
      .map((row) => ({ ...row, analysis_amount: row.amount }));
  }
}

export class OverviewBalanceFlow extends React.Component<{
  snapshot: Row;
  role: string;
  onSelect: (data: OverviewBalanceDistribution, selection: Row) => void;
}> {
  render() {
    const { snapshot, role, onSelect } = this.props;
    const data = new OverviewBalanceDistribution(snapshot, role);
    const title = role === "ASSET" ? "资产" : "负债";
    return (
      <Card
        className="overview-position-flow"
        title={`${title}分布`}
        extra={<strong>¥ {Money.format(data.total)}</strong>}
      >
        {data.nodes.length ? (
          <DistributionDiagram
            data={data}
            compact
            columns={[`${title}总额`, "账户组", "账户标签"]}
            label={`总览${title}三级分布桑基图`}
            onSelect={(selection) => onSelect(data, selection)}
          />
        ) : (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={`暂无正额${title}`}
          />
        )}
        {data.adjustments.length > 0 && (
          <div className="balance-flow-adjustments">
            <strong>抵减项 · 不参与连线宽度</strong>
            {data.adjustments.map((row) => (
              <div key={row.id}>
                <Button
                  type="link"
                  size="small"
                  onClick={() =>
                    onSelect(data, {
                      namespace: role,
                      level: "account",
                      account_id: row.id,
                      label: row.name,
                    })
                  }
                >
                  {row.name}
                </Button>
                <span>¥ {Money.format(row.amount)}</span>
              </div>
            ))}
            <p>
              正额 ¥ {Money.format(data.positiveTotal)} ＋ 抵减 ¥{" "}
              {Money.format(data.total - data.positiveTotal)} ＝ 账面总额 ¥{" "}
              {Money.format(data.total)}
            </p>
          </div>
        )}
        <p className="overview-card-footnote">
          点击节点或连线查看账户。账户组按直属归属拆分，每个账户按类型归入一个标签。
          {data.zeroCount ? `${data.zeroCount} 个零余额账户不绘制。` : ""}
        </p>
      </Card>
    );
  }
}
