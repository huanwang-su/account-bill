import React from "react";
import {
  Alert,
  Button,
  Card,
  DatePicker,
  Descriptions,
  Empty,
  Form,
  Input,
  Modal,
  Popconfirm,
  InputNumber,
  Select,
  Space,
  Table,
  TreeSelect,
  Tag,
  message,
} from "antd";
import { PagedTable } from "./PagedTable";
import { BillAssociationDialog } from "./BillAssociationDialog";
import { DownloadOutlined } from "@ant-design/icons";
import {
  LedgerApi,
  MoneyFormatter as Money,
  Row,
  CategoryTree,
  AccountGroupTree,
  BillCategoryTree,
  TagTree,
} from "./api";
const ledgerStates: Row = {
  PENDING: ["待核对", "orange"],
  POSTED: ["已入账", "green"],
  IGNORED: ["不入账", "default"],
  LINKED: ["已关联交易", "cyan"],
  REVERSED: ["已撤销", "red"],
};
const flows: Row = { IN: "收入", OUT: "支出", UNSPECIFIED: "方向未明确" };
const settlements: Row = {
  COMPLETED: "已完成",
  AWAITING_RECEIPT: "待收货",
  REFUNDED: "已退款",
  CLOSED: "已关闭",
  UNKNOWN: "状态未明确",
};
const states: Row = {
  UNCLASSIFIED: ["待分类", "default"],
  CLASSIFIED: ["已分类", "green"],
  NEEDS_REVIEW: ["需复核", "orange"],
};
interface Props {
  mode: "list" | "import";
  initialFilters?: Row;
  refreshKey?: string;
  onChanged: () => Promise<void>;
}
interface State {
  rows: Row[];
  filters: Row;
  busy: boolean;
  loading: boolean;
  associating?: Row;
  editing?: Row;
  detail?: Row;
  history: Row[];
  reviewing?: Row;
  accounts: Row[];
  groups: Row[];
  categories: Row[];
  tags: Row[];
}
/** Reusable provider-independent bill viewer and offline classification workflow. */
export class BillWorkspace extends React.Component<Props, State> {
  api = new LedgerApi();
  state: State = {
    rows: [],
    filters: this.props.initialFilters ?? {},
    busy: false,
    loading: true,
    history: [],
    accounts: [],
    groups: [],
    categories: [],
    tags: [],
  };
  componentDidMount() {
    this.load();
  }
  componentDidUpdate(previous: Props) {
    if (previous.initialFilters !== this.props.initialFilters)
      this.setState({ filters: this.props.initialFilters ?? {} });
    if (
      previous.refreshKey !== this.props.refreshKey ||
      previous.mode !== this.props.mode
    )
      this.load();
  }
  async load() {
    try {
      const [rows, groups, categories, tags] = await Promise.all([
        this.api.request("/bills"),
        this.api.request("/account-groups"),
        this.api.request("/categories"),
        this.api.request("/tags"),
      ]);
      this.setState({ rows, groups, categories, tags, loading: false });
    } catch (e) {
      this.fail(e);
    }
  }
  fail(e: unknown) {
    message.error(e instanceof Error ? e.message : "操作失败");
    this.setState({ loading: false });
  }
  async reverse(row: Row) {
    this.setState({ busy: true });
    try {
      await this.api.request("/bills/reverse", "POST", { bill_id: row.id });
      await this.load();
      await this.props.onChanged();
      message.success("交易已撤销，已入账的余额变动已冲回");
    } catch (e) {
      this.fail(e);
    } finally {
      this.setState({ busy: false });
    }
  }
  async review(row: Row) {
    try {
      const [accounts, categories, policy] = await Promise.all([
        this.api.request("/accounts"),
        this.api.request("/categories"),
        this.api.request("/classification-policy"),
      ]);
      this.setState({
        reviewing: { ...row, refund_income: policy.unmatched_refund_income },
        accounts,
        categories,
      });
    } catch (e) {
      this.fail(e);
    }
  }
  async resolve(values: Row) {
    this.setState({ busy: true });
    try {
      await this.api.request("/bills/resolve", "POST", {
        ...values,
        bill_id: this.state.reviewing!.id,
      });
      this.setState({ reviewing: undefined });
      await this.load();
      await this.props.onChanged();
      message.success("已确认并生成账户流水");
    } catch (e) {
      this.fail(e);
    } finally {
      this.setState({ busy: false });
    }
  }
  async edit(values: Row) {
    const row = this.state.editing!;
    this.setState({ busy: true });
    try {
      await this.api.request("/bills/classifications", "POST", {
        schema_version: "local-ledger.bills.v1",
        bills: [
          {
            id: row.id,
            revision: row.revision,
            facts: row.facts,
            classification: {
              category_path: values.category
                .split("/")
                .map((s: string) => s.trim()),
              tags: values.tags || [],
              status: values.status,
              review_scope: values.review_scope || "UNSPECIFIED",
              note: values.note || "",
              classified_by: "人工修正",
            },
          },
        ],
      });
      this.setState({ editing: undefined });
      await this.load();
      await this.props.onChanged();
      message.success("分类已保存");
    } catch (e) {
      this.fail(e);
    } finally {
      this.setState({ busy: false });
    }
  }
  async details(row: Row) {
    this.setState({ detail: row, history: [] });
    try {
      this.setState({
        history: await this.api.request(
          "/bills/history?bill_id=" + encodeURIComponent(row.id),
        ),
      });
    } catch (e) {
      this.fail(e);
    }
  }
  get filtered() {
    const f = this.state.filters;
    return this.state.rows.filter(
      (r) =>
        (!f.q ||
          (
            r.facts.counterparty +
            " " +
            (r.display_description || r.facts.description) +
            " " +
            (r.source_transaction_id || "") +
            " " +
            (r.related_sources || [])
              .map((source: Row) =>
                [
                  source.source_transaction_id,
                  source.original_fields?.counterparty,
                ].join(" "),
              )
              .join(" ")
          )
            .toLowerCase()
            .includes(f.q.toLowerCase())) &&
        (!f.group_id ||
          this.state.groups
            .find((g) => g.id === f.group_id)
            ?.account_ids.some((id: number) =>
              (r.account_ids || [r.account_id]).includes(id),
            )) &&
        (!f.status || r.classification_status === f.status) &&
        (!f.ledger_status || r.ledger_status === f.ledger_status) &&
        (!f.category ||
          (
            r.category_paths ||
            (r.classification ? [r.classification.category_path] : [])
          ).some((path: string[]) =>
            BillCategoryTree.matches(path, f.category),
          )) &&
        (!f.tag ||
          new TagTree(this.state.tags).matches(
            r.classification?.tags || [],
            f.tag,
          )) &&
        (!f.start || r.facts.occurred_at.slice(0, 10) >= f.start) &&
        (!f.end || r.facts.occurred_at.slice(0, 10) <= f.end),
    );
  }
  setFilter(patch: Row) {
    this.setState({ filters: { ...this.state.filters, ...patch } });
  }
  render() {
    const { rows, filters, editing, detail } = this.state;
    const classified = rows.filter((r) => r.classification).length;
    const tags = [
      ...new Set([
        ...this.state.tags.map((tag) => tag.name),
        ...rows.flatMap((row) => row.classification?.tags || []),
      ]),
    ];
    return (
      <div className="bill-workspace">
        <div className="metrics">
          <div className="metric featured">
            <span>统一账单</span>
            <strong>
              {rows.length} <small>条</small>
            </strong>
            <small>已持久保存 · 全部记录</small>
          </div>
          <div className="metric">
            <span>已完成分类处理</span>
            <strong>{classified}</strong>
            <small>包括保留复核说明的记录</small>
          </div>
          <div className="metric">
            <span>待分类</span>
            <strong>{rows.length - classified}</strong>
            <small>可导出交给 Codex 处理</small>
          </div>
          <div className="metric">
            <span>分类需复核</span>
            <strong>
              {
                rows.filter((r) => r.classification_status === "NEEDS_REVIEW")
                  .length
              }
            </strong>
            <small>信息不足时保留原始含义</small>
          </div>
        </div>
        <Alert
          className="mb"
          type="info"
          showIcon
          message={`已入账 ${rows.filter((r) => r.ledger_status === "POSTED").length} 条 · 待核对 ${rows.filter((r) => r.ledger_status === "PENDING").length} 条 · 已撤销 ${rows.filter((r) => r.ledger_status === "REVERSED").length} 条。分类状态表示分类是否完成，入账状态表示资金是否已记账。待核对记录可点击“核对入账”确认。`}
        />
        <div className="filters">
          <Select
            allowClear
            aria-label="交易明细账户组"
            placeholder="全部账户组"
            style={{ width: 200 }}
            options={new AccountGroupTree(this.state.groups).options()}
            value={filters.group_id}
            onChange={(group_id) => this.setFilter({ group_id })}
          />
          <Input.Search
            allowClear
            placeholder="搜索对方、描述、流水号"
            style={{ width: 230 }}
            onSearch={(q) => this.setFilter({ q })}
          />
          <TreeSelect
            allowClear
            aria-label="分类树筛选"
            showSearch
            treeNodeFilterProp="title"
            placeholder="分类（包含子分类）"
            style={{ width: 220 }}
            treeData={new BillCategoryTree(
              this.state.categories,
              rows,
            ).options()}
            value={filters.category}
            onChange={(category) => this.setFilter({ category })}
          />
          <TreeSelect
            allowClear
            aria-label="标签树筛选"
            showSearch
            treeNodeFilterProp="title"
            placeholder="标签（包含子标签）"
            style={{ width: 200 }}
            treeDefaultExpandAll
            treeData={new TagTree([
              ...this.state.tags,
              ...[...new Set(rows.flatMap((r) => r.classification?.tags || []))]
                .filter((name) => !this.state.tags.some((t) => t.name === name))
                .map((name, index) => ({
                  id: -(index + 1),
                  name,
                  scope: "TRANSACTION",
                  parent_id: null,
                })),
            ]).options("TRANSACTION")}
            value={filters.tag}
            onChange={(tag) => this.setFilter({ tag })}
          />
          <Select
            allowClear
            placeholder="分类状态"
            aria-label="分类状态"
            style={{ width: 140 }}
            options={Object.entries(states).map(([value, v]) => ({
              value,
              label: v[0],
            }))}
            value={filters.status}
            onChange={(status) => this.setFilter({ status })}
          />
          <Select
            allowClear
            placeholder="入账状态"
            aria-label="入账状态"
            value={filters.ledger_status}
            style={{ width: 140 }}
            options={Object.entries(ledgerStates).map(([value, v]) => ({
              value,
              label: v[0],
            }))}
            onChange={(ledger_status) => this.setFilter({ ledger_status })}
          />
          <DatePicker.RangePicker
            onChange={(d) =>
              this.setFilter({
                start: d?.[0]?.format("YYYY-MM-DD"),
                end: d?.[1]?.format("YYYY-MM-DD"),
              })
            }
          />
        </div>
        <Card
          title={`交易明细 · ${this.filtered.length} 条`}
          extra={
            <Space>
              <Button
                href={"/api/bills/export?" + this.api.query(filters)}
                icon={<DownloadOutlined />}
              >
                导出 JSON
              </Button>
            </Space>
          }
        >
          <PagedTable
            rowKey="id"
            loading={this.state.loading}
            dataSource={this.filtered}
            scroll={{ x: 1170 }}
            defaultPageSize={15}
            pageResetKey={JSON.stringify(filters)}
            locale={{
              emptyText: (
                <Empty description="请在账单导入页完成分类并导入交易明细" />
              ),
            }}
            columns={[
              {
                title: "交易对方 / 时间",
                width: 190,
                render: (_: unknown, r: Row) => (
                  <>
                    <div className="cell-title">
                      {r.facts.counterparty || "—"}
                    </div>
                    <small className="muted">{r.facts.occurred_at}</small>
                    <div title={r.ledger_reason}>
                      <Tag color={ledgerStates[r.ledger_status]?.[1]}>
                        {ledgerStates[r.ledger_status]?.[0]}
                      </Tag>
                    </div>
                  </>
                ),
              },
              {
                title: "描述",
                width: 200,
                render: (_: unknown, r: Row) => (
                  <div className="bill-description">
                    {r.display_description || r.facts.description || "—"}
                  </div>
                ),
              },
              {
                title: "金额 / 方向",
                width: 120,
                align: "right",
                render: (_: unknown, r: Row) => (
                  <>
                    <strong>
                      ¥{" "}
                      {Money.format(
                        r.effective_amount_minor ?? r.facts.amount_minor,
                      )}
                    </strong>
                    <div>
                      <small className="muted">
                        {r.transaction_kind
                          ? (
                              {
                                EXPENSE: "记账支出",
                                INCOME: "记账收入",
                                TRANSFER: "账户转账",
                                REFUND: "记账退款",
                                OPENING: "期初余额",
                              } as Row
                            )[r.transaction_kind]
                          : flows[r.facts.flow]}
                      </small>
                    </div>
                  </>
                ),
              },
              {
                title: "资金账户",
                width: 150,
                render: (_: unknown, r: Row) => (
                  <>
                    {r.account_name || "待确认"}
                    {r.payment_channel && (
                      <div>
                        <Tag>{r.payment_channel}</Tag>
                      </div>
                    )}
                    {r.source_count > 1 && (
                      <small className="muted">
                        {r.source_count} 份账单凭证
                      </small>
                    )}
                  </>
                ),
              },
              {
                title: "分类 / 标签",
                width: 200,
                render: (_: unknown, r: Row) => (
                  <>
                    <div>
                      {(
                        r.display_category_path ||
                        r.classification?.category_path
                      )?.join(" / ") || "尚未分类"}
                    </div>
                    <div className="bill-tags">
                      {r.classification?.tags.map((t: string) => (
                        <Tag key={t}>{t}</Tag>
                      ))}
                    </div>
                  </>
                ),
              },
              {
                title: "分类状态",
                width: 110,
                render: (_: unknown, r: Row) => (
                  <>
                    <Tag color={states[r.classification_status][1]}>
                      {states[r.classification_status][0]}
                    </Tag>
                    <div>
                      <small className="muted">
                        {settlements[r.facts.settlement]}
                      </small>
                    </div>
                  </>
                ),
              },
              {
                title: "操作",
                width: 200,
                fixed: "right",
                render: (_: unknown, r: Row) => (
                  <Space wrap>
                    {r.id.startsWith("wechat:") &&
                      r.facts.flow === "OUT" &&
                      r.facts.payment_hint.includes("银行") &&
                      ["PENDING", "POSTED"].includes(r.ledger_status) && (
                        <Button
                          type="link"
                          size="small"
                          onClick={() => this.setState({ associating: r })}
                        >
                          关联银行凭证
                        </Button>
                      )}
                    {r.ledger_status === "PENDING" && (
                      <Button
                        size="small"
                        type="link"
                        onClick={() => this.review(r)}
                      >
                        核对入账
                      </Button>
                    )}
                    <Button
                      size="small"
                      type="link"
                      onClick={() => this.details(r)}
                    >
                      详情
                    </Button>
                    <Button
                      size="small"
                      type="link"
                      onClick={() => this.setState({ editing: r })}
                    >
                      修正分类
                    </Button>
                    {r.ledger_status !== "REVERSED" &&
                      r.transaction_kind !== "OPENING" && (
                        <Popconfirm
                          title="撤销这笔交易？"
                          description="已入账的资金将冲回，记录和文件保留。"
                          onConfirm={() => this.reverse(r)}
                        >
                          <Button
                            size="small"
                            type="link"
                            danger
                            disabled={this.state.busy}
                          >
                            撤销交易
                          </Button>
                        </Popconfirm>
                      )}
                  </Space>
                ),
              },
            ]}
          />
        </Card>
        <Modal
          open={!!this.state.reviewing}
          title="核对并入账"
          footer={null}
          destroyOnHidden
          onCancel={() => this.setState({ reviewing: undefined })}
        >
          {this.state.reviewing && (
            <Form
              layout="vertical"
              onFinish={(v) => this.resolve(v)}
              initialValues={{
                kind:
                  this.state.reviewing.facts.settlement === "REFUNDED"
                    ? this.state.reviewing.refund_income
                      ? "INCOME"
                      : "REFUND"
                    : this.state.reviewing.classification?.category_path[0] ===
                        "收入"
                      ? "INCOME"
                      : "EXPENSE",
                account_id: this.state.reviewing.account_id,
                amount: Money.input(
                  this.state.reviewing.effective_amount_minor ??
                    this.state.reviewing.facts.amount_minor,
                ),
              }}
            >
              <Alert
                className="mb"
                type="warning"
                message={this.state.reviewing.ledger_reason}
              />
              <Form.Item
                name="kind"
                label="交易类型"
                rules={[{ required: true }]}
              >
                <Select
                  options={[
                    { value: "EXPENSE", label: "支出" },
                    { value: "INCOME", label: "收入" },
                    { value: "TRANSFER", label: "内部转账" },
                    { value: "REFUND", label: "退款" },
                  ]}
                />
              </Form.Item>
              <Form.Item
                name="account_id"
                label="收付款账户（转账为转出账户）"
                rules={[{ required: true }]}
              >
                <Select
                  options={this.state.accounts
                    .filter((a) => a.active && a.role !== "SYSTEM")
                    .map((a) => ({ value: a.id, label: a.name }))}
                />
              </Form.Item>
              <Form.Item noStyle shouldUpdate>
                {({ getFieldValue }) =>
                  getFieldValue("kind") === "TRANSFER" ? (
                    <Form.Item
                      name="to_account_id"
                      label="转入账户"
                      rules={[{ required: true }]}
                    >
                      <Select
                        options={this.state.accounts
                          .filter((a) => a.active && a.role !== "SYSTEM")
                          .map((a) => ({ value: a.id, label: a.name }))}
                      />
                    </Form.Item>
                  ) : getFieldValue("kind") === "REFUND" ? (
                    <Alert
                      className="mb"
                      type="info"
                      message="退款统一使用“退款”分类"
                    />
                  ) : (
                    <Form.Item name="category_id" label="入账分类">
                      <Select
                        allowClear
                        placeholder="留空沿用明细分类"
                        options={this.state.categories
                          .filter(
                            (c) =>
                              c.active &&
                              c.kind ===
                                (getFieldValue("kind") === "INCOME"
                                  ? "INCOME"
                                  : "EXPENSE"),
                          )
                          .map((c) => ({
                            value: c.id,
                            label: new CategoryTree(this.state.categories).path(
                              c.id,
                            ),
                          }))}
                      />
                    </Form.Item>
                  )
                }
              </Form.Item>
              <Form.Item
                name="amount"
                label="实际资金变动金额（元）"
                rules={[{ required: true }]}
              >
                <InputNumber
                  stringMode
                  precision={2}
                  style={{ width: "100%" }}
                />
              </Form.Item>
              <Form.Item noStyle shouldUpdate>
                {({ getFieldValue }) =>
                  getFieldValue("kind") === "REFUND" && (
                    <Form.Item name="related_id" label="原支出流水编号（可选）">
                      <InputNumber
                        precision={0}
                        min={1}
                        style={{ width: "100%" }}
                      />
                    </Form.Item>
                  )
                }
              </Form.Item>
              <Button
                type="primary"
                htmlType="submit"
                loading={this.state.busy}
              >
                确认并入账
              </Button>
            </Form>
          )}
        </Modal>
        {this.state.associating && (
          <BillAssociationDialog
            source={this.state.associating}
            onClose={() => this.setState({ associating: undefined })}
            onChanged={async () => {
              await this.load();
              await this.props.onChanged();
            }}
          />
        )}
        <Modal
          open={!!editing}
          title="修正分类与标签"
          footer={null}
          destroyOnHidden
          onCancel={() => this.setState({ editing: undefined })}
        >
          {editing && (
            <Form
              layout="vertical"
              initialValues={{
                category:
                  editing.classification?.category_path.join(" / ") || "",
                tags: editing.classification?.tags || [],
                status: editing.classification?.status || "CLASSIFIED",
                review_scope:
                  editing.classification?.review_scope || "UNSPECIFIED",
                note: editing.classification?.note || "",
              }}
              onFinish={(v) => this.edit(v)}
            >
              <Form.Item
                name="category"
                label="分类路径"
                rules={[{ required: true }]}
              >
                <Input placeholder="例如：支出 / 餐饮 / 买菜" />
              </Form.Item>
              <Form.Item name="tags" label="标签">
                <Select
                  mode="tags"
                  options={tags.map((value) => ({ value, label: value }))}
                />
              </Form.Item>
              <Form.Item name="status" label="分类状态">
                <Select
                  options={[
                    { value: "CLASSIFIED", label: "已分类" },
                    { value: "NEEDS_REVIEW", label: "需复核" },
                  ]}
                />
              </Form.Item>
              <Form.Item name="review_scope" label="复核原因类型">
                <Select
                  options={[
                    { value: "CATEGORY", label: "仅细分类不明确" },
                    { value: "TRANSACTION", label: "资金性质待确认" },
                    { value: "ACCOUNT", label: "账户待确认" },
                    { value: "AMOUNT", label: "金额待确认" },
                    { value: "DUPLICATE", label: "可能重复" },
                    { value: "UNSPECIFIED", label: "尚未说明" },
                  ]}
                />
              </Form.Item>
              <Form.Item name="note" label="说明">
                <Input.TextArea />
              </Form.Item>
              <Button
                type="primary"
                htmlType="submit"
                loading={this.state.busy}
              >
                保存分类
              </Button>
            </Form>
          )}
        </Modal>
        <Modal
          open={!!detail}
          title="统一交易明细"
          width={720}
          footer={null}
          onCancel={() => this.setState({ detail: undefined })}
        >
          {detail && (
            <>
              <Descriptions bordered column={1} size="small">
                <Descriptions.Item label="交易流水号">
                  {detail.source_transaction_id || "原账单未提供"}
                </Descriptions.Item>
                <Descriptions.Item label="统一编号">
                  <span style={{ overflowWrap: "anywhere" }}>{detail.id}</span>
                </Descriptions.Item>
                <Descriptions.Item label="交易对方">
                  {detail.facts.counterparty}
                </Descriptions.Item>
                <Descriptions.Item label="描述">
                  {detail.facts.description}
                </Descriptions.Item>
                <Descriptions.Item label="金额">
                  ¥ {Money.format(detail.facts.amount_minor)}
                </Descriptions.Item>
                <Descriptions.Item label="资金账户">
                  {detail.account_name || "待确认"}
                </Descriptions.Item>
                <Descriptions.Item label="原账单收支方向">
                  {flows[detail.facts.flow]}
                </Descriptions.Item>
                <Descriptions.Item label="收付款线索">
                  {detail.facts.payment_hint || "未提供"}
                </Descriptions.Item>
                <Descriptions.Item label="分类">
                  {(
                    detail.display_category_path ||
                    detail.classification?.category_path
                  )?.join(" / ") || "未分类"}
                </Descriptions.Item>
                <Descriptions.Item label="分类说明">
                  {detail.classification?.note || "—"}
                </Descriptions.Item>
                <Descriptions.Item label="处理人 / 版本">
                  {detail.classification?.classified_by || "—"} /{" "}
                  {detail.revision}
                </Descriptions.Item>
                <Descriptions.Item label="入账状态">
                  {ledgerStates[detail.ledger_status]?.[0]}{" "}
                  {detail.ledger_reason}
                </Descriptions.Item>
                {detail.revoked_at && (
                  <Descriptions.Item label="撤销时间">
                    {detail.revoked_at}
                  </Descriptions.Item>
                )}
                {!!detail.refund_amount_minor && (
                  <Descriptions.Item label="退款抵扣 / 净支出">
                    ¥ {Money.format(detail.refund_amount_minor)} / ¥{" "}
                    {Money.format(detail.effective_amount_minor)}
                  </Descriptions.Item>
                )}
                {detail.posted_amount_minor != null && (
                  <Descriptions.Item label="实际入账金额">
                    ¥ {Money.format(detail.posted_amount_minor)}
                  </Descriptions.Item>
                )}
                <Descriptions.Item label="关联资金流水">
                  {detail.transaction_id
                    ? "#" + detail.transaction_id
                    : "尚未关联，未改变账户余额"}
                </Descriptions.Item>
              </Descriptions>
              <details className="mt">
                <summary>原始账单字段与关联凭证</summary>
                <pre
                  style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}
                >
                  {JSON.stringify(
                    {
                      original: detail.original_fields,
                      related: detail.related_sources,
                    },
                    null,
                    2,
                  )}
                </pre>
              </details>
              <h4>分类修改历史</h4>
              <Table
                size="small"
                pagination={false}
                rowKey="revision"
                dataSource={this.state.history}
                columns={[
                  { title: "版本", dataIndex: "revision" },
                  {
                    title: "分类",
                    render: (_: unknown, r: Row) =>
                      r.classification.category_path.join(" / "),
                  },
                  {
                    title: "处理人",
                    render: (_: unknown, r: Row) =>
                      r.classification.classified_by,
                  },
                  { title: "保存时间", dataIndex: "saved_at" },
                ]}
              />
            </>
          )}
        </Modal>
      </div>
    );
  }
}
