import React from "react";
import { Button, Space } from "antd";
import type { Row } from "./api";
import { AccountChoices } from "./AccountChoices";

/** Both report workspaces share canonical account choices and wealth defaults. */
export class AnalysisAccountSelection {
  constructor(public accounts: Row[]) {}
  choices() {
    return AccountChoices.rank(this.accounts).filter(
      (a) => !a.merged_into_id && ["ASSET", "LIABILITY"].includes(a.role),
    );
  }
  defaults(): number[] {
    return this.choices()
      .filter((a) => a.role === "ASSET" && ["证券", "理财"].includes(a.kind))
      .map((a) => a.id);
  }
  resolve(selection?: number[]): number[] {
    if (selection === undefined) return this.defaults();
    const ids = new Set<number>();
    for (let id of selection) {
      const seen = new Set<number>();
      let account = this.accounts.find((a) => a.id === id);
      while (account?.merged_into_id && !seen.has(id)) {
        seen.add(id);
        id = account.merged_into_id;
        account = this.accounts.find((a) => a.id === id);
      }
      if (account && !account.merged_into_id && account.role !== "SYSTEM")
        ids.add(account.id);
    }
    return [...ids];
  }
  query(selection?: number[]): string {
    return JSON.stringify(this.resolve(selection));
  }
}

export class AnalysisScopeNotice extends React.Component<{
  accounts: Row[];
  excludedIds?: number[];
  accountId?: number;
  onConfigure?: () => void;
}> {
  render() {
    const ids = this.props.excludedIds || [];
    const names = this.props.accounts
      .filter((a) => ids.includes(a.id))
      .map((a) => a.name)
      .join("、");
    return (
      <div className="analysis-account-exclusions mb">
        <Space wrap>
          <span title={names}>已按分析配置屏蔽 {ids.length} 个账户</span>
          {this.props.onConfigure && (
            <Button type="link" size="small" onClick={this.props.onConfigure}>
              查看 / 修改配置
            </Button>
          )}
        </Space>
        <p className="muted">
          账户屏蔽统一在“设置 →
          分析配置”管理，作用于本页指标、图表、明细和上期比较。
        </p>
        {this.props.accountId && ids.includes(this.props.accountId) && (
          <p>所选账户已被屏蔽，请调整配置或选择其他账户。</p>
        )}
      </div>
    );
  }
}
