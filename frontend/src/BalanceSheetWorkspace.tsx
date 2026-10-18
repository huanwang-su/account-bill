import { ReportPeriodFilter } from "./ReportPeriodFilter";
import React from "react";
import {
  Alert,
  Button,
  Card,
  Drawer,
  Empty,
  Select,
  Space,
  Spin,
  Table,
  Tag,
  message,
} from "antd";
import dayjs from "dayjs";
import {
  BalanceSheetAccountTag,
  BalanceSheetStructure,
} from "./BalanceSheetStructure";
import { BalanceSheetFlow } from "./BalanceSheetFlow";
import { AnalysisDrilldownBar } from "./AnalysisDrilldown";
import { PagedTable } from "./PagedTable";

import {
  AccountGroupTree,
  LedgerApi,
  MoneyFormatter as Money,
  Row,
} from "./api";

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
  drilldown?: Row;
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
  select(selection: Row) {
    this.setState({ drilldown: { ...selection } });
  }
  drilldownRows(selection = this.state.drilldown): Row[] {
    const snapshot = this.state.snapshot;
    if (!snapshot || !selection) return [];
    const accounts = new BalanceSheetStructure(snapshot).accounts(
      selection.namespace,
    );
    if (selection.account_id !== undefined)
      return accounts.filter((account) => account.id === selection.account_id);
    const tagged = accounts.filter(
      (account) =>
        selection.account_tag === undefined ||
        BalanceSheetAccountTag.forAccount(account).key ===
          selection.account_tag,
    );
    if (selection.group_id === undefined) return tagged;
    const groups = new Set<number>([selection.group_id]);
    if (!selection.direct_group) {
      let added = true;
      while (added) {
        added = false;
        for (const group of snapshot.groups)
          if (groups.has(group.parent_id) && !groups.has(group.id)) {
            groups.add(group.id);
            added = true;
          }
      }
    }
    return tagged.filter((account) =>
      groups.has(
        snapshot.groups.some((group: Row) => group.id === account.group_id)
          ? account.group_id
          : 0,
      ),
    );
  }
  accountSelection(account: Row, namespace: string): Row {
    return {
      namespace,
      level: "account",
      account_id: account.id,
      group_id: this.state.snapshot?.groups.some(
        (group: Row) => group.id === account.group_id,
      )
        ? account.group_id
        : 0,
      direct_group: true,
      label: account.name,
      ...(namespace === "ASSET" && {
        account_tag: BalanceSheetAccountTag.forAccount(account).key,
        account_tag_label: BalanceSheetAccountTag.forAccount(account).label,
      }),
    };
  }
  back() {
    const selection = this.state.drilldown;
    if (!selection) return;
    if (selection.account_id !== undefined) {
      if (selection.account_tag !== undefined) {
        const current = this.drilldownRows(selection)[0];
        const scope = current
          ? this.accountSelection(current, selection.namespace)
          : selection;
        const path =
          new BalanceSheetStructure(this.state.snapshot!).path(
            scope.group_id,
          ) || "未分组";
        this.select({
          ...scope,
          level: "tag",
          account_id: undefined,
          direct_group: true,
          label: path + " / " + scope.account_tag_label,
        });
        return;
      }
      this.selectGroup(selection);
    } else if (selection.account_tag !== undefined) {
      this.selectGroup(selection);
    } else if (selection.group_id !== undefined) {
      this.select({
        namespace: selection.namespace,
        level: "root",
        label:
          selection.namespace === "ASSET" ? "全部资产账户" : "全部负债账户",
      });
    } else this.setState({ drilldown: undefined });
  }
  selectGroup(selection: Row) {
    const group = this.props.groups.find(
      (item) => item.id === selection.group_id,
    );
    this.select({
      namespace: selection.namespace,
      level: "group",
      group_id: selection.group_id ?? 0,
      direct_group: true,
      label: group?.name || "未分组",
    });
  }

  renderDrilldown() {
    const { drilldown, snapshot } = this.state;
    if (!drilldown || !snapshot) return null;
    const rows = this.drilldownRows();
    const title = drilldown.namespace === "ASSET" ? "资产" : "负债";
    const total = rows.reduce((sum, row) => sum + row.amount, 0);
    return (
      <div className="analysis-drilldown-content">
        <AnalysisDrilldownBar
          label={`${title}局部明细`}
          items={[
            {
              key: "scope",
              label: drilldown.label || `${title}账户`,
              onClear: () => this.back(),
            },
          ]}
          onReset={() => this.setState({ drilldown: undefined })}
          resetLabel="关闭明细"
        />
        <p className="muted">
          截至 {snapshot.as_of} 日末。
          {drilldown.account_tag !== undefined &&
            `账户标签：${drilldown.account_tag_label}，按账户类型归类。`}
          {drilldown.group_id !== undefined &&
          drilldown.account_id === undefined
            ? drilldown.direct_group
              ? "仅列该账户组直属账户。"
              : "包含下级账户组，按账户各计一次。"
            : ""}
          主表日期、账户组和金额口径保持当前设置。
        </p>
        <div className="section-top">
          <div>
            <span className="muted">
              本区{title}账面合计 · {rows.length} 个账户
            </span>
            <h3>¥ {Money.format(total)}</h3>
          </div>
          <Button onClick={() => this.back()}>
            {drilldown.account_id !== undefined
              ? drilldown.account_tag !== undefined
                ? "返回账户标签"
                : "返回直属账户组"
              : drilldown.account_tag !== undefined
                ? "返回直属账户组"
                : drilldown.group_id !== undefined
                  ? `返回全部${title}`
                  : "返回主表"}
          </Button>
        </div>
        <PagedTable<Row>
          rowKey="id"
          dataSource={rows}
          defaultPageSize={10}
          pageResetKey={JSON.stringify([
            drilldown.namespace,
            drilldown.group_id,
            drilldown.direct_group,
            drilldown.account_id,
            drilldown.account_tag,
            snapshot.as_of,
          ])}
          columns={[
            {
              title: "账户",
              render: (_, row) => (
                <Button
                  type="link"
                  size="small"
                  onClick={() =>
                    this.select(this.accountSelection(row, drilldown.namespace))
                  }
                >
                  {row.name}
                </Button>
              ),
            },
            {
              title: "直属账户组",
              render: (_, row) =>
                new BalanceSheetStructure(snapshot).path(row.group_id) ||
                "未分组",
            },
            {
              title:
                drilldown.namespace === "ASSET" ? "账户标签 / 类型" : "类型",
              render: (_, row) => (
                <>
                  {drilldown.namespace === "ASSET" && (
                    <Tag>{BalanceSheetAccountTag.forAccount(row).label}</Tag>
                  )}
                  <Tag>{row.kind}</Tag>
                  {!row.active && <Tag>停用</Tag>}
                </>
              ),
            },
            {
              title: "账面金额（元）",
              align: "right",
              render: (_, row) => (
                <strong className={row.amount < 0 ? "balance-negative" : ""}>
                  {Money.format(row.amount)}
                </strong>
              ),
            },
          ]}
        />
        <p className="muted">
          按账户的账面金额列示，包含负数抵减与零余额；桑基图仅按正额绘制。综合账户在资产、负债两侧分别显示相应部分。
        </p>
      </div>
    );
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
          dataSource={new BalanceSheetStructure(snapshot).tree(role)}
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
                  <Button
                    type="link"
                    size="small"
                    className="cell-title"
                    onClick={() =>
                      this.select({
                        namespace: role,
                        level: row.nodeType === "account" ? "account" : "group",
                        account_id:
                          row.nodeType === "account" ? row.id : undefined,
                        group_id:
                          row.nodeType === "account"
                            ? (row.group_id ?? 0)
                            : row.key === "ungrouped"
                              ? 0
                              : Number(String(row.key).split(":")[1]),
                        direct_group: row.nodeType === "account",
                        label: row.name,
                      })
                    }
                  >
                    {row.name}
                  </Button>
                  {row.nodeType === "account" && (
                    <div className="balance-account-note">
                      <small className="muted">{row.kind}</small>
                      {!row.active && <Tag>停用</Tag>}
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
          <ReportPeriodFilter
            refreshKey={this.props.refreshKey}
            mode="snapshot"
            filters={{ as_of: this.state.asOf }}
            label="资产负债表截止日期"
            onChange={(patch) =>
              this.setState({ asOf: patch.as_of }, () => this.load())
            }
          />
          <Select
            aria-label="资产负债表账户组"
            allowClear
            placeholder="全部账户组"
            style={{ width: 250 }}
            value={this.state.groupId}
            options={new AccountGroupTree(this.props.groups).options()}
            onChange={(groupId) =>
              this.setState({ groupId }, () => this.load())
            }
          />
          <Button onClick={() => this.load()} loading={this.state.loading}>
            刷新
          </Button>
        </div>
        {this.state.loading && !snapshot ? (
          <Card loading />
        ) : (
          snapshot && (
            <Spin spinning={this.state.loading}>
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

              <div className="balance-sheet-distributions">
                <BalanceSheetFlow
                  snapshot={snapshot}
                  role="ASSET"
                  onSelect={(selection) => this.select(selection)}
                />
                <BalanceSheetFlow
                  snapshot={snapshot}
                  role="LIABILITY"
                  onSelect={(selection) => this.select(selection)}
                />
              </div>
              <div className="balance-sheet-grid">
                {this.renderSection("ASSET", "资产", snapshot.assets)}
                {this.renderSection("LIABILITY", "负债", snapshot.liabilities)}
              </div>
              <div className="balance-equation">
                资产 ¥ {Money.format(snapshot.assets)} − 负债 ¥{" "}
                {Money.format(snapshot.liabilities)} = 净资产 ¥{" "}
                {Money.format(snapshot.net_assets)}
              </div>
              <details className="analysis-method">
                <summary>统计口径与读图说明</summary>
                <p>
                  截至 {snapshot.as_of}{" "}
                  日末，按已入账流水累计余额，包含期初和撤销冲回。综合账户的资产、负债部分分别列示；合并来源只计一次，停用账户保留余额。
                </p>
                <p>
                  两侧桑基图分别展示正额分布，负余额与预付款列在抵减项。图中账户组仅含直属账户；表格父组包含下级，阅读合计时按账户各计一次。点击节点、连线或账户查看对应局部明细。
                </p>
              </details>
            </Spin>
          )
        )}
        <Drawer
          title="资产负债明细"
          width={880}
          zIndex={900}
          open={!!this.state.drilldown}
          onClose={() => this.setState({ drilldown: undefined })}
        >
          {this.renderDrilldown()}
        </Drawer>
      </div>
    );
  }
}
