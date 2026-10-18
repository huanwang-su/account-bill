import React from "react";
import { Popover } from "antd";
import { AnalysisAccountSelection } from "./AnalysisAccountScope";
import type { Row } from "./api";

/** The list explains one switch, independently of other exclusions. */
export class AccountExclusionHint extends React.Component<{
  accounts: Row[];
  ids?: number[];
  label: string;
  enabled: boolean;
  children: React.ReactElement;
}> {
  render() {
    const { accounts, ids, label, enabled, children } = this.props;
    const selected = new Set(
      new AnalysisAccountSelection(accounts).resolve(ids || []),
    );
    const rows = accounts.filter((account) => selected.has(account.id));
    return (
      <Popover
        trigger={["hover", "focus"]}
        placement="bottomLeft"
        title={`${label} · ${rows.length} 个账户`}
        content={
          <div
            className="account-exclusion-hint"
            role="note"
            aria-label={`${label}账户列表`}
          >
            <p className="muted">
              {enabled
                ? "当前已屏蔽以下账户"
                : "当前未启用，开启后屏蔽以下账户"}
            </p>
            {ids === undefined ? (
              <p>名单加载中…</p>
            ) : rows.length ? (
              <ul>
                {rows.map((account) => (
                  <li key={account.id}>{account.name}</li>
                ))}
              </ul>
            ) : (
              <p>暂无对应账户</p>
            )}
          </div>
        }
      >
        {children}
      </Popover>
    );
  }
}
