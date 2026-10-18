import React from "react";
import { Table } from "antd";
import type { TableProps } from "antd";

type Props<T extends object> = Omit<TableProps<T>, "pagination"> & {
  defaultPageSize?: number;
  pageResetKey?: string;
};

/** Shared local pagination over the complete, filtered data set. */
export class PagedTable<T extends object> extends React.Component<
  Props<T>,
  { current: number; pageSize: number }
> {
  constructor(props: Props<T>) {
    super(props);
    this.state = { current: 1, pageSize: props.defaultPageSize ?? 15 };
  }

  componentDidUpdate(previous: Props<T>) {
    const lastPage = Math.max(
      1,
      Math.ceil((this.props.dataSource?.length ?? 0) / this.state.pageSize),
    );
    if (previous.pageResetKey !== this.props.pageResetKey) {
      if (this.state.current !== 1) this.setState({ current: 1 });
    } else if (this.state.current > lastPage) {
      this.setState({ current: lastPage });
    }
  }

  render() {
    const { defaultPageSize, pageResetKey, onChange, ...props } = this.props;
    const total = props.dataSource?.length ?? 0;
    const reset = this.state.pageSize;
    return (
      <Table<T>
        {...props}
        size={props.size ?? "middle"}
        pagination={{
          current: Math.min(
            this.state.current,
            Math.max(1, Math.ceil(total / this.state.pageSize)),
          ),
          pageSize: this.state.pageSize,
          total,
          showSizeChanger: total > (defaultPageSize ?? 15),
          hideOnSinglePage: total <= (defaultPageSize ?? 15),
          pageSizeOptions: [
            ...new Set([defaultPageSize ?? 15, 10, 20, 50, 100]),
          ]
            .sort((a, b) => a - b)
            .map(String),
          showTotal: (count, range) =>
            count ? `第 ${range[0]}–${range[1]} 条，共 ${count} 条` : "共 0 条",
        }}
        onChange={(pagination, filters, sorter, extra) => {
          const pageSize = pagination.pageSize ?? reset;
          this.setState({
            pageSize,
            current:
              pageSize !== reset || extra.action !== "paginate"
                ? 1
                : (pagination.current ?? 1),
          });
          onChange?.(pagination, filters, sorter, extra);
        }}
      />
    );
  }
}
