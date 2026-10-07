import React from "react";
import {
  Alert,
  Button,
  Card,
  DatePicker,
  Empty,
  Select,
  Space,
  Table,
  Tag,
  message,
} from "antd";
import dayjs from "dayjs";
import {
  AccountGroupTree,
  LedgerApi,
  MoneyFormatter as Money,
  Row,
} from "./api";

/** Group subtotals are presentation rows; account balances are counted once. */
class BalanceSheetTree {
  constructor(private snapshot: Row) {}
  build(role: string): Row[] {
    const groups: Row[] = this.snapshot.groups;
    const accounts: Row[] = this.snapshot.accounts.filter(
      (a: Row) => a.role === role,
    );
    const account = (a: Row): Row => ({
      ...a,
      key: `account:${a.id}`,
      nodeType: "account",
    });
    const group = (g: Row): Row | undefined => {
      const children: Row[] = [
        ...groups
          .filter((child) => child.parent_id === g.id)
          .flatMap((child) => {
            const row = group(child);
            return row ? [row] : [];
          }),
        ...accounts.filter((a) => a.group_id === g.id).map(account),
      ];
      if (!children.length) return undefined;
      return {
        key: `group:${g.id}`,
        name: g.name,
        nodeType: "group",
        children,
        amount: children.reduce((sum, row) => sum + row.amount, 0),
      };
    };
    const roots = groups
      .filter((g) => !groups.some((parent) => parent.id === g.parent_id))
      .flatMap((g) => {
        const row = group(g);
        return row ? [row] : [];
      });
    const ungrouped = accounts.filter((a) => a.group_id === null).map(account);
    if (ungrouped.length)
      roots.push({
        key: "ungrouped",
        name: "未分组",
        nodeType: "group",
        children: ungrouped,
        amount: ungrouped.reduce((sum, row) => sum + row.amount, 0),
      });
    return roots;
  }
}

interface Props {
  groups: Row[];
  refreshKey: string;
  onAccounts: () => void;
}
interface State {
  asOf: string;
  groupId?: number;
  snapshot?: Row;
  loading: boolean;
}

export class BalanceSheetWorkspace extends React.Component<Props, State> {
  api = new LedgerApi();
  requestVersion = 0;
  state: State = { asOf: dayjs().format("YYYY-MM-DD"), loading: true };
  componentDidMount() {
    this.load();
  }
  componentDidUpdate(previous: Props) {
    if (previous.refreshKey !== this.props.refreshKey) this.load();
  }
  componentWillUnmount() {
    this.requestVersion++;
  }
  async load() {
    const version = ++this.requestVersion;
    this.setState({ loading: true });
    try {
      const snapshot = await this.api.request(
        "/reports/balance-sheet?" +
          this.api.query({
            as_of: this.state.asOf,
            group_id: this.state.groupId,
          }),
      );
      if (version === this.requestVersion)
        this.setState({ snapshot, loading: false });
    } catch (error) {
      if (version === this.requestVersion) {
        this.setState({ loading: false });
        message.error(
          error instanceof Error ? error.message : "资产负债表加载失败",
        );
      }
    }
  }
  renderSection(role: string, title: string, total: number) {
    const snapshot = this.state.snapshot!;
    return (
      <Card title={title} extra={<strong>¥ {Money.format(total)}</strong>}>
        <Table<Row>
          key={`${role}:${snapshot.as_of}:${snapshot.group_id}`}
          rowKey="key"
          pagination={false}
          size="middle"
          dataSource={new BalanceSheetTree(snapshot).build(role)}
          expandable={{ defaultExpandAllRows: true, indentSize: 20 }}
          locale={{
            emptyText: (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={`还没有${title}账户`}
              />
            ),
          }}
          rowClassName={(row) =>
            row.nodeType === "group" ? "balance-group-row" : ""
          }
          columns={[
            {
              title: "账户组 / 账户",
              render: (_, row) => (
                <div>
                  <span className="cell-title">{row.name}</span>
                  {row.nodeType === "account" && (
                    <div className="balance-account-note">
                      <small className="muted">{row.kind}</small>
                      {!row.active && <Tag>停用</Tag>}
                      {!row.opening_set && <Tag color="orange">期初待补全</Tag>}
                      {!!row.merged_source_count && (
                        <Tag>含 {row.merged_source_count} 个合并来源</Tag>
                      )}
                    </div>
                  )}
                </div>
              ),
            },
            {
              title: "账面金额（元）",
              width: 160,
              align: "right",
              render: (_, row) => (
                <span className={row.amount < 0 ? "balance-negative" : ""}>
                  {Money.format(row.amount)}
                </span>
              ),
            },
          ]}
          summary={() => (
            <Table.Summary.Row>
              <Table.Summary.Cell index={0}>
                <strong>{title}合计</strong>
              </Table.Summary.Cell>
              <Table.Summary.Cell index={1} align="right">
                <strong>{Money.format(total)}</strong>
              </Table.Summary.Cell>
            </Table.Summary.Row>
          )}
        />
      </Card>
    );
  }
  render() {
    const snapshot = this.state.snapshot;
    return (
      <div className="balance-sheet-workspace">
        <div className="filters">
          <Space>
            <span>截止日期</span>
            <DatePicker
              allowClear={false}
              aria-label="资产负债表截止日期"
              value={dayjs(this.state.asOf)}
              onChange={(value) => {
                if (value)
                  this.setState({ asOf: value.format("YYYY-MM-DD") }, () =>
                    this.load(),
                  );
              }}
            />
          </Space>
          <Select
            aria-label="资产负债表账户组"
            allowClear
            placeholder="全部账户组"
            style={{ width: 250 }}
            value={this.state.groupId}
            options={new AccountGroupTree(this.props.groups).options()}
            onChange={(groupId) =>
              this.setState({ groupId, snapshot: undefined }, () => this.load())
            }
          />
          <Button onClick={() => this.load()} loading={this.state.loading}>
            刷新
          </Button>
        </div>
        {this.state.loading ? (
          <Card loading />
        ) : (
          snapshot && (
            <>
              <div className="balance-sheet-metrics">
                <div className="metric">
                  <span>资产总额</span>
                  <strong data-testid="balance-assets">
                    ¥ {Money.format(snapshot.assets)}
                  </strong>
                  <small>自有资产账户</small>
                </div>
                <div className="metric">
                  <span>负债总额</span>
                  <strong data-testid="balance-liabilities">
                    ¥ {Money.format(snapshot.liabilities)}
                  </strong>
                  <small>欠款为正数 · 预付款为负数</small>
                </div>
                <div className="metric featured">
                  <span>净资产</span>
                  <strong data-testid="balance-net">
                    ¥ {Money.format(snapshot.net_assets)}
                  </strong>
                  <small>资产 − 负债</small>
                </div>
              </div>
              {!!snapshot.missing_opening_ids.length && (
                <Alert
                  className="mb"
                  type="warning"
                  showIcon
                  message={`${snapshot.missing_opening_ids.length} 个账户的期初余额尚未补全，金额可能仅代表已记录的累计变动。`}
                  action={
                    <Button
                      type="link"
                      size="small"
                      onClick={this.props.onAccounts}
                    >
                      补全期初余额
                    </Button>
                  }
                />
              )}
              <div className="balance-sheet-grid">
                {this.renderSection("ASSET", "资产", snapshot.assets)}
                {this.renderSection("LIABILITY", "负债", snapshot.liabilities)}
              </div>
              <div className="balance-equation">
                资产 ¥ {Money.format(snapshot.assets)} − 负债 ¥{" "}
                {Money.format(snapshot.liabilities)} = 净资产 ¥{" "}
                {Money.format(snapshot.net_assets)}
              </div>
              <p className="muted balance-sheet-note">
                截至 {snapshot.as_of}{" "}
                日末，按交易发生时间累计账户流水（含期初余额和撤销冲回）。按照当前账户组及合并配置展示，合并来源只计一次，停用账户保留余额；商户、公共记账账户和待核对记录不计入。
              </p>
            </>
          )
        )}
      </div>
    );
  }
}
