import React from "react";
import { Select, Switch } from "antd";
import { AnalysisAccountSelection } from "./AnalysisAccountScope";
import { AccountExclusionHint } from "./AccountExclusionHint";
import type { Row } from "./api";

/** Local report filters never overwrite the saved income/expense preferences. */
export class ReportAccountFilters extends React.Component<{
  accounts: Row[];
  filters: Row;
  onChange: (patch: Row) => void;
  defaults?: Row;
  disabled?: boolean;
}> {
  static specified(filters: Row): number[] {
    try {
      const value = filters.excluded_account_ids;
      const rows = typeof value === "string" ? JSON.parse(value) : value;
      return Array.isArray(rows) ? rows : [];
    } catch {
      return [];
    }
  }
  static query(filters: Row, defaults: Row = {}): Row {
    return {
      ...filters,
      exclude_investment_accounts:
        filters.exclude_investment_accounts ??
        defaults.exclude_investment_accounts,
      exclude_single_accounts:
        filters.exclude_single_accounts ?? defaults.exclude_single_accounts,
      excluded_account_ids: JSON.stringify(this.specified(filters)),
    };
  }
  render() {
    const { accounts, filters, onChange, disabled } = this.props;
    const investmentEnabled =
      filters.exclude_investment_accounts ??
      this.props.defaults?.exclude_investment_accounts ??
      false;
    const singleEnabled =
      filters.exclude_single_accounts ??
      this.props.defaults?.exclude_single_accounts ??
      false;
    return (
      <div className="report-account-filters">
        <AccountExclusionHint
          accounts={accounts}
          ids={
            this.props.defaults?.investment_account_ids ??
            new AnalysisAccountSelection(accounts).defaults()
          }
          label="证券理财账户"
          enabled={investmentEnabled}
        >
          <label tabIndex={0}>
            <Switch
              aria-label="屏蔽证券理财账户"
              checked={
                filters.exclude_investment_accounts ??
                this.props.defaults?.exclude_investment_accounts ??
                false
              }
              disabled={disabled}
              onChange={(value) =>
                onChange({ exclude_investment_accounts: value })
              }
            />
            <span>屏蔽证券理财账户</span>
          </label>
        </AccountExclusionHint>
        <AccountExclusionHint
          accounts={accounts}
          ids={this.props.defaults?.single_excluded_account_ids}
          label="单账户屏蔽名单"
          enabled={singleEnabled}
        >
          <label tabIndex={0}>
            <Switch
              aria-label="屏蔽单账户名单"
              checked={
                filters.exclude_single_accounts ??
                this.props.defaults?.exclude_single_accounts ??
                false
              }
              disabled={disabled}
              onChange={(value) => onChange({ exclude_single_accounts: value })}
            />
            <span>屏蔽单账户名单</span>
          </label>
        </AccountExclusionHint>
        <label className="report-account-filter-select">
          <span>屏蔽指定账户</span>
          <Select<number[]>
            aria-label="屏蔽指定账户"
            mode="multiple"
            maxTagCount={2}
            allowClear
            showSearch
            optionFilterProp="label"
            placeholder="选择不纳入的账户"
            disabled={disabled}
            value={ReportAccountFilters.specified(filters)}
            options={new AnalysisAccountSelection(accounts)
              .choices()
              .map((row) => ({ value: row.id, label: row.name }))}
            onChange={(value) => onChange({ excluded_account_ids: value })}
          />
        </label>
      </div>
    );
  }
}
