import React from "react";
import { Select } from "antd";
import { LedgerApi, DisplayMoneyFormatter as Money } from "../api";
import type { Page, TransactionRecord } from "../contracts";
import { LatestRequest } from "../LatestRequest";

/** Refund lookup searches the ledger, independent of the currently visible page. */
export class ExpenseTransactionPicker extends React.Component<
  { value?: number; onChange?: (value?: number) => void },
  { rows: TransactionRecord[]; loading: boolean }
> {
  api = new LedgerApi();
  loader = new LatestRequest(this.api);
  state = { rows: [] as TransactionRecord[], loading: false };
  componentDidMount() {
    void this.load("");
  }
  componentWillUnmount() {
    this.loader.dispose();
  }
  async load(query: string) {
    const version = this.loader.begin();
    this.setState({ loading: true });
    try {
      const page = await this.api.request<Page<TransactionRecord>>(
        "/transactions?" +
          this.api.query({ kind: "EXPENSE", q: query, page: 1, page_size: 20 }),
      );
      const rows = page.items;
      if (this.props.value && !rows.some((row) => row.id === this.props.value))
        rows.unshift(
          await this.api.request<TransactionRecord>(
            `/transactions/${this.props.value}`,
          ),
        );
      if (this.loader.current(version)) this.setState({ rows, loading: false });
    } catch (error) {
      if (this.loader.current(version)) this.setState({ loading: false });
    }
  }
  render() {
    return (
      <Select
        allowClear
        showSearch
        value={this.props.value}
        onChange={this.props.onChange}
        loading={this.state.loading}
        filterOption={false}
        onSearch={(query) => void this.load(query)}
        placeholder="搜索原支出的交易方、描述或账户"
        options={this.state.rows.map((row) => ({
          value: row.id,
          label: `#${row.id} ${row.counterparty} ¥${Money.format(row.amount)}`,
        }))}
      />
    );
  }
}
