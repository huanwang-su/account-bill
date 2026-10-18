import React from "react";
import {
  Button,
  Collapse,
  Dropdown,
  Empty,
  Input,
  Space,
  Tag,
  Tooltip,
  Tree,
} from "antd";
import {
  AlipayCircleOutlined,
  BankOutlined,
  CheckCircleOutlined,
  EllipsisOutlined,
  FolderOutlined,
  PlusOutlined,
  WalletOutlined,
  WechatOutlined,
} from "@ant-design/icons";
import { AccountGroupTree, MoneyFormatter as Money, Row } from "./api";

type Scope = number | "all" | "ungrouped";
interface Props {
  accounts: Row[];
  groups: Row[];
  onAdd: (group?: number) => void;
  onEdit: (kind: string, account: Row) => void;
  onTransactions: (filters: Row) => void;
  onConfigure: () => void;
  onAnalyse: (account: Row) => void;
}

/** Ownership hierarchy uses canonical accounts once; group totals include descendants. */
export class AccountDirectory {
  accounts: Row[];
  constructor(
    public groups: Row[],
    accounts: Row[],
  ) {
    this.accounts = accounts.filter(
      (a) => a.role !== "SYSTEM" && !a.merged_into_id,
    );
  }
  children(parent: number | null) {
    return this.groups.filter((g) => (g.parent_id ?? null) === parent);
  }
  direct(group: number | null) {
    return this.accounts.filter((a) => (a.group_id ?? null) === group);
  }
  members(scope: Scope): Row[] {
    if (scope === "all") return this.accounts;
    if (scope === "ungrouped") return this.direct(null);
    const groupIds = new Set([scope]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const g of this.groups) {
        if (groupIds.has(g.parent_id) && !groupIds.has(g.id)) {
          groupIds.add(g.id);
          changed = true;
        }
      }
    }
    return this.accounts.filter((a) => groupIds.has(a.group_id));
  }
  balance(scope: Scope) {
    return this.members(scope).reduce(
      (sum, a) =>
        sum + (["ASSET", "LIABILITY"].includes(a.role) ? a.balance : 0),
      0,
    );
  }
  path(id: number) {
    return new AccountGroupTree(this.groups).path(id);
  }
}

export class AccountWorkspace extends React.Component<
  Props,
  { scope: Scope; query: string }
> {
  state: { scope: Scope; query: string } = { scope: "all", query: "" };
  componentDidUpdate() {
    if (
      typeof this.state.scope === "number" &&
      !this.props.groups.some((g) => g.id === this.state.scope)
    )
      this.setState({ scope: "all", query: "" });
  }
  selectScope(scope: Scope) {
    this.setState({ scope, query: "" });
  }
  icon(account: Row) {
    if (account.kind.includes("银行") || account.kind.includes("信用卡"))
      return <BankOutlined />;
    if (account.kind.includes("微信")) return <WechatOutlined />;
    if (account.kind.includes("支付宝")) return <AlipayCircleOutlined />;
    return <WalletOutlined />;
  }
  accountRow(a: Row) {
    const tone = a.kind.includes("微信")
      ? "wechat"
      : a.kind.includes("支付宝")
        ? "alipay"
        : a.kind.includes("银行")
          ? "bank"
          : "other";
    return (
      <div
        className={`account-list-row ${!a.active ? "is-inactive" : ""}`}
        data-account-id={a.id}
        key={a.id}
      >
        <div className="account-list-identity">
          <span className={`account-provider-icon ${tone}`}>
            {this.icon(a)}
          </span>
          <div>
            <div className="account-list-name">
              <span title={a.name}>{a.name}</span>
              {!a.active && <Tag>停用</Tag>}
            </div>
            <div className="account-list-metadata">
              <span>{a.kind}</span>
              {a.number && <span>尾号 {a.number.slice(-4)}</span>}
              <span>
                {
                  (
                    {
                      ASSET: "资金账户",
                      LIABILITY: "负债账户",
                      EXTERNAL: "外部往来",
                    } as Row
                  )[a.role]
                }
              </span>
              {a.tags.length > 0 && (
                <span className="account-list-tags" title={a.tags.join("、")}>
                  {a.tags.map((tag: string) => (
                    <span key={tag}>{tag}</span>
                  ))}
                </span>
              )}
            </div>
            {a.note && (
              <p className="account-list-note" title={a.note}>
                {a.note}
              </p>
            )}
          </div>
        </div>
        <div className="account-list-amount">{Money.format(a.balance)}</div>
        <div className="account-list-opening">
          {a.opening_set ? (
            <span className="opening-ready">
              <CheckCircleOutlined /> 已设置
            </span>
          ) : (
            <Tooltip title="当前金额为已记录的累计变动；设置期初后可核对完整余额。">
              <Button
                type="link"
                size="small"
                className="account-opening-action"
                aria-label={`设置期初：${a.name}`}
                onClick={() => this.props.onEdit("opening", a)}
              >
                设置期初
              </Button>
            </Tooltip>
          )}
        </div>
        <div className="account-list-actions">
          <Button
            type="link"
            size="small"
            onClick={() => this.props.onTransactions({ account_id: a.id })}
          >
            流水
          </Button>
          <Button
            type="link"
            size="small"
            onClick={() => this.props.onEdit("account", a)}
          >
            编辑
          </Button>
          <Dropdown
            trigger={["click"]}
            menu={{
              items: [
                ...(["ASSET", "LIABILITY"].includes(a.role)
                  ? [{ key: "counterparties", label: "交易方分析" }]
                  : []),
                ...(a.kind === "证券" && a.role === "ASSET" && a.active
                  ? [{ key: "valuation", label: "更新证券余额" }]
                  : []),
                ...(!a.opening_set
                  ? [{ key: "opening", label: "设置期初" }]
                  : []),
                { key: "reconcile", label: "账户对账" },
              ],
              onClick: ({ key }) =>
                key === "counterparties"
                  ? this.props.onAnalyse(a)
                  : this.props.onEdit(key, a),
            }}
          >
            <Button
              type="text"
              size="small"
              aria-label={`更多操作：${a.name}`}
              icon={<EllipsisOutlined />}
            />
          </Dropdown>
        </div>
      </div>
    );
  }
  section(
    group: Row | undefined,
    accounts: Row[],
    directory: AccountDirectory,
  ) {
    const id = group?.id ?? "ungrouped";
    return (
      <section
        className="account-list-group"
        data-group-section={id}
        key={id}
        aria-label={`${group?.name ?? "未分组"}账户组`}
      >
        <div className="account-list-group-heading">
          <div>
            <FolderOutlined />
            <h3>{group ? directory.path(group.id) : "未分组账户"}</h3>
            <span>
              {accounts.length} 个{group ? "直属" : ""}账户
            </span>
          </div>
          <div className="group-section-actions">
            {group && (
              <>
                <Button
                  type="link"
                  size="small"
                  onClick={() => this.props.onAdd(group.id)}
                >
                  添加到本组
                </Button>
                <Button
                  type="link"
                  size="small"
                  onClick={() =>
                    this.props.onTransactions({ group_id: group.id })
                  }
                >
                  查看本组流水
                </Button>
              </>
            )}
          </div>
        </div>
        {accounts.length ? (
          <>{accounts.map((a) => this.accountRow(a))}</>
        ) : (
          <div className="account-group-empty">
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={group ? "这个账户组还没有账户" : "所有账户都已分组"}
            />
          </div>
        )}
      </section>
    );
  }
  render() {
    const directory = new AccountDirectory(
        this.props.groups,
        this.props.accounts,
      ),
      { scope, query } = this.state;
    const group = this.props.groups.find((g) => g.id === scope),
      selected = directory.members(scope);
    const title =
      scope === "all"
        ? "全部账户"
        : scope === "ungrouped"
          ? "未分组账户"
          : group?.name;
    const uninitialized = selected.filter(
      (a) => ["ASSET", "LIABILITY"].includes(a.role) && !a.opening_set,
    ).length;
    const needle = query.trim().toLowerCase();
    const visible = selected.filter(
      (a) =>
        !needle ||
        [a.name, a.number, a.kind, a.note]
          .join(" ")
          .toLowerCase()
          .includes(needle),
    );
    const visibleIds = new Set(visible.map((a) => a.id));
    const sections: React.ReactNode[] = [];
    const visit = (g: Row) => {
      const direct = directory.direct(g.id).filter((a) => visibleIds.has(a.id));
      if (
        direct.length ||
        (!needle &&
          !directory.children(g.id).length &&
          !directory.direct(g.id).length)
      )
        sections.push(this.section(g, direct, directory));
      directory.children(g.id).forEach(visit);
    };
    if (scope === "all") directory.children(null).forEach(visit);
    else if (group) visit(group);
    const ungrouped = directory
      .direct(null)
      .filter((a) => visibleIds.has(a.id));
    if (
      (scope === "ungrouped" && (!needle || ungrouped.length > 0)) ||
      (scope === "all" && ungrouped.length > 0)
    )
      sections.push(this.section(undefined, ungrouped, directory));
    const treeNode = (g: Row): any => ({
      key: String(g.id),
      title: (
        <span data-group-node={g.id} title={directory.path(g.id)}>
          <span>{g.name}</span>
          <small>{directory.members(g.id).length}</small>
        </span>
      ),
      children: directory.children(g.id).map(treeNode),
    });
    const treeData = directory.children(null).map(treeNode);
    return (
      <div className="account-directory account-desktop">
        <div className="account-directory-layout">
          <div className="account-group-navigation">
            <div className="account-navigation-header">
              <div className="account-navigation-title">
                <FolderOutlined /> 账户组
              </div>
              <Button
                type="text"
                size="small"
                aria-label="管理账户组"
                onClick={this.props.onConfigure}
              >
                管理
              </Button>
            </div>
            <div className="account-scope-selector">
              <button
                type="button"
                className="account-group-shortcut"
                aria-pressed={scope === "all"}
                onClick={() => this.selectScope("all")}
              >
                <span
                  className="account-group-shortcut-label"
                  data-group-node="all"
                >
                  全部账户
                </span>
                <span className="account-group-count">
                  {directory.accounts.length}
                </span>
              </button>
              <Tree
                blockNode
                defaultExpandAll
                selectedKeys={typeof scope === "number" ? [String(scope)] : []}
                treeData={treeData}
                onSelect={(keys) => {
                  const key = keys[0];
                  this.selectScope(key === undefined ? "all" : Number(key));
                }}
              />
              <button
                type="button"
                className="account-group-shortcut"
                aria-pressed={scope === "ungrouped"}
                onClick={() => this.selectScope("ungrouped")}
              >
                <span
                  className="account-group-shortcut-label"
                  data-group-node="ungrouped"
                >
                  未分组
                </span>
                <span className="account-group-count">
                  {directory.direct(null).length}
                </span>
              </button>
            </div>
            <div className="group-tree-hint">包含子组，合并账户不重复计数</div>
          </div>
          <div className="account-directory-content">
            <div
              className="account-scope-summary"
              data-scope-summary={String(scope)}
            >
              <div className="account-scope-title">
                <p className="account-breadcrumb">
                  {typeof scope === "number"
                    ? directory.path(scope)
                    : "账户总览"}
                </p>
                <h2>{title}</h2>
                <span>
                  {selected.length} 个账户 ·{" "}
                  {scope === "ungrouped"
                    ? "未指定归属"
                    : scope === "all"
                      ? "全部账户组"
                      : "当前组及子组"}
                </span>
              </div>
              <div className="account-scope-balance">
                <span>
                  账面净额 <small>CNY</small>
                </span>
                <strong>¥ {Money.format(directory.balance(scope))}</strong>
                <span className="account-scope-footnote">
                  自有资产与负债合计
                </span>
              </div>
              <div className="account-scope-actions">
                <Button
                  type="primary"
                  icon={<PlusOutlined />}
                  onClick={() =>
                    this.props.onAdd(
                      typeof scope === "number" ? scope : undefined,
                    )
                  }
                >
                  添加账户
                </Button>
              </div>
            </div>
            {uninitialized > 0 && (
              <div className="account-opening-notice">
                <span />
                {uninitialized} 个资金账户未设期初，当前金额为已记录的累计变动。
              </div>
            )}
            <div className="account-list-panel">
              <div className="account-list-toolbar">
                <div>
                  <strong>账户列表</strong>
                  <span>
                    {needle
                      ? `显示 ${visible.length} / ${selected.length} 个账户`
                      : "按所属账户组排列"}
                  </span>
                </div>
                <Input
                  allowClear
                  prefix={<WalletOutlined />}
                  aria-label="搜索账户"
                  placeholder="搜索账户名称或卡号"
                  value={query}
                  onChange={(e) => this.setState({ query: e.target.value })}
                />
              </div>
              <div className="account-list-columns">
                <span>账户</span>
                <span>账面金额（元）</span>
                <span>期初余额</span>
                <span>操作</span>
              </div>
              {sections.length ? (
                sections
              ) : (
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description={
                    needle
                      ? "没有匹配的账户"
                      : "还没有账户，点击添加账户开始管理"
                  }
                />
              )}
              <div className="account-list-footer">
                外部往来和公共记账账户不计入账面净额。
              </div>
            </div>
          </div>
        </div>
        <Collapse
          className="account-system-details"
          ghost
          items={[
            {
              key: "system",
              label: "查看公共记账账户",
              children: (
                <Space wrap>
                  {this.props.accounts
                    .filter((a) => a.role === "SYSTEM")
                    .map((a) => (
                      <Tag key={a.id}>
                        {a.name} · ¥ {Money.format(a.balance)}
                      </Tag>
                    ))}
                </Space>
              ),
            },
          ]}
        />
      </div>
    );
  }
}
