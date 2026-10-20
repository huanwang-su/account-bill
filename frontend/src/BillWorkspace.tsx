import { MetricCard } from "./MetricCard";
import { ReportPeriodFilter } from "./ReportPeriodFilter";
import { LatestRequest } from "./LatestRequest";
import React from "react";
import { AmountPrivacy } from "./AmountPrivacy";
import {
  Alert,
  Button,
  Card,
  Descriptions,
  Empty,
  Form,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  TreeSelect,
  Tag,
  message,
} from "antd";
import { PagedTable } from "./PagedTable";
import { BillAssociationDialog } from "./BillAssociationDialog";
import { BillSorter, BillSortOrder } from "./BillSorter";
import { BillReviewForm } from "./BillReviewForm";
import { BillAttention } from "./BillReviewModel";
import { DownloadOutlined } from "@ant-design/icons";
import {
  LedgerApi,
  DisplayMoneyFormatter as Money,
  Row,
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
  sortField: string;
  sortOrder: BillSortOrder;
  current: number;
  pageSize: number;
  total?: number;
  statistics?: Row;
}
/** Reusable provider-independent bill viewer and offline classification workflow. */
export class BillWorkspace extends React.Component<Props, State> {
  api = new LedgerApi();
  loader = new LatestRequest(this.api);
  reviewVersion = 0;
  state: State = {
    rows: [],
    filters: this.props.initialFilters ?? ReportPeriodFilter.defaults(),
    busy: false,
    loading: true,
    history: [],
    accounts: [],
    groups: [],
    categories: [],
    tags: [],
    sortField: "occurred_at",
    sortOrder: "descend",
    current: 1,
    pageSize: 15,
  };
  componentDidMount() {
    this.load();
  }
  componentWillUnmount() {
    this.loader.dispose();
    this.reviewVersion++;
  }
  componentDidUpdate(previous: Props, state: State) {
    if (previous.initialFilters !== this.props.initialFilters)
      return this.setState({
        filters: this.props.initialFilters ?? ReportPeriodFilter.defaults(),
        current: 1,
      });
    if (
      previous.refreshKey !== this.props.refreshKey ||
      previous.mode !== this.props.mode ||
      state.filters !== this.state.filters ||
      state.current !== this.state.current ||
      state.pageSize !== this.state.pageSize ||
      state.sortField !== this.state.sortField ||
      state.sortOrder !== this.state.sortOrder
    )
      this.load();
  }
  async load() {
    const version = this.loader.begin();
    this.setState({ loading: true });
    try {
      const [result, groups, categories, tags] = await Promise.all([
        this.api.request(
          "/bills?" +
            this.api.query({
              ...this.state.filters,
              page: this.state.current,
              page_size: this.state.pageSize,
              sort: this.state.sortField,
              order: this.state.sortOrder,
            }),
        ),
        this.api.request("/account-groups"),
        this.api.request("/categories"),
        this.api.request("/tags"),
      ]);
      if (this.loader.current(version))
        this.setState({
          rows: Array.isArray(result) ? result : result.items,
          total: Array.isArray(result) ? undefined : result.total,
          statistics: result.statistics,
          groups,
          categories,
          tags,
          loading: false,
        });
    } catch (e) {
      if (this.loader.current(version)) this.fail(e);
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
    if (this.state.busy || row.ledger_status !== "PENDING") return;
    const version = ++this.reviewVersion;
    try {
      const [accounts, categories, policy] = await Promise.all([
        this.api.request("/accounts"),
        this.api.request("/categories"),
        this.api.request("/classification-policy"),
      ]);
      if (version !== this.reviewVersion) return;
      this.setState({
        reviewing: { ...row, refund_income: policy.unmatched_refund_income },
        accounts,
        categories,
      });
    } catch (e) {
      if (version === this.reviewVersion) this.fail(e);
    }
  }
  closeReview() {
    if (this.state.busy) return;
    this.reviewVersion++;
    this.setState({ reviewing: undefined });
  }
  async resolve(values: Row) {
    if (this.state.busy || !this.state.reviewing) return;
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
    if (this.state.total !== undefined) return this.state.rows;
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
  showPending() {
    this.setState({ filters: BillAttention.filters(), current: 1 });
  }
  setFilter(patch: Row) {
    this.setState({ filters: { ...this.state.filters, ...patch }, current: 1 });
  }
  render() {
    const { rows, filters, editing, detail } = this.state;
    const sorting = (key: string) => ({
      key,
      sorter: true,
      sortOrder: this.state.sortField === key ? this.state.sortOrder : null,
      sortDirections: ["ascend", "descend", "ascend"] as BillSortOrder[],
    });
    const stats = this.state.statistics;
    const total = stats?.total ?? rows.length;
    const classified =
      stats?.classified ?? rows.filter((r) => r.classification).length;
    const pending = BillAttention.rows(rows);
    const pendingCount = stats?.pending ?? pending.length;
    const nextPending = BillAttention.rows(
      BillSorter.sort(
        this.filtered,
        this.state.sortField,
        this.state.sortOrder,
      ),
    )[0];
    const tags = [
      ...new Set([
        ...this.state.tags.map((tag) => tag.name),
        ...rows.flatMap((row) => row.classification?.tags || []),
      ]),
    ];
    return (
      <div className="bill-workspace">
        <div className="metrics">
          <MetricCard className="metric featured">
            <span>统一账单</span>
            <strong>
              {total} <small>条</small>
            </strong>
            <small>已持久保存 · 全部记录</small>
          </MetricCard>
          <MetricCard className="metric">
            <span>已完成分类处理</span>
            <strong>{classified}</strong>
            <small>包括保留复核说明的记录</small>
          </MetricCard>
          <MetricCard className="metric">
            <span>待分类</span>
            <strong>{total - classified}</strong>
            <small>可导出交给 Codex 处理</small>
          </MetricCard>
          <MetricCard className="metric">
            <span>分类需复核</span>
            <strong>
              {stats?.review ??
                rows.filter((r) => r.classification_status === "NEEDS_REVIEW")
                  .length}
            </strong>
            <small>信息不足时保留原始含义</small>
          </MetricCard>
        </div>
        <Alert
          className="mb"
          type={pendingCount ? "warning" : "info"}
          showIcon
          action={
            pendingCount > 0 && (
              <Button size="small" onClick={() => this.showPending()}>
                处理待核对（{pendingCount}）
              </Button>
            )
          }
          message={`已入账 ${stats?.posted ?? rows.filter((r) => r.ledger_status === "POSTED").length} 条 · 待核对 ${stats?.pending ?? rows.filter((r) => r.ledger_status === "PENDING").length} 条 · 已撤销 ${stats?.reversed ?? rows.filter((r) => r.ledger_status === "REVERSED").length} 条。分类状态表示分类是否完成，入账状态表示资金是否已记账。待核对记录可点击“核对入账”确认。`}
        />
        {filters.ledger_status === "PENDING" && (
          <div className="bill-attention-toolbar" role="status">
            <div>
              <strong>
                待处理异常 · {this.state.total ?? this.filtered.length} 条
              </strong>
              <span>逐笔核对账户、类型和金额后入账；记录保留原始账单。</span>
            </div>
            <Space>
              <Button
                onClick={() =>
                  this.setState({ filters: ReportPeriodFilter.defaults() })
                }
              >
                返回交易列表
              </Button>
              <Button
                type="primary"
                disabled={!nextPending || this.state.busy || this.state.loading}
                onClick={() => this.review(nextPending)}
              >
                核对下一条
              </Button>
            </Space>
          </div>
        )}
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
            value={filters.q || ""}
            onChange={(event) => this.setFilter({ q: event.target.value })}
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
          <ReportPeriodFilter
            allowAll
            refreshKey={this.props.refreshKey}
            filters={filters}
            label="账单日期"
            onChange={(patch) => this.setFilter(patch)}
          />
        </div>
        <Card
          title={`交易明细 · ${this.state.total ?? this.filtered.length} 条`}
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
          <Space className="bill-sort-controls" wrap>
            <span className="muted">排序</span>
            <Select
              aria-label="交易排序字段"
              value={this.state.sortField}
              style={{ width: 150 }}
              options={BillSorter.fields}
              onChange={(sortField) => this.setState({ sortField, current: 1 })}
            />
            <Select
              aria-label="交易排序方向"
              value={this.state.sortOrder}
              style={{ width: 110 }}
              options={[
                { value: "descend", label: "降序" },
                { value: "ascend", label: "升序" },
              ]}
              onChange={(sortOrder) => this.setState({ sortOrder, current: 1 })}
            />
            <small className="muted">点击表头也可切换排序</small>
          </Space>
          <PagedTable
            rowKey="id"
            remote={
              this.state.total === undefined
                ? undefined
                : {
                    current: this.state.current,
                    pageSize: this.state.pageSize,
                    total: this.state.total,
                    onChange: (current, pageSize) =>
                      this.setState({ current, pageSize }),
                  }
            }
            loading={this.state.loading}
            dataSource={
              this.state.total !== undefined
                ? this.filtered
                : BillSorter.sort(
                    this.filtered,
                    this.state.sortField,
                    this.state.sortOrder,
                  )
            }
            scroll={{ x: 1170 }}
            defaultPageSize={15}
            pageResetKey={JSON.stringify([
              filters,
              this.state.sortField,
              this.state.sortOrder,
            ])}
            onChange={(_, __, sorter) => {
              const selected = Array.isArray(sorter) ? sorter[0] : sorter;
              if (selected.columnKey && selected.order)
                this.setState({
                  current: 1,
                  sortField: String(selected.columnKey),
                  sortOrder: selected.order,
                });
            }}
            locale={{
              emptyText: (
                <Empty description="请在账单导入页完成分类并导入交易明细" />
              ),
            }}
            columns={[
              {
                title: "交易对方 / 时间",
                ...sorting("occurred_at"),
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
                ...sorting("description"),
                width: 200,
                render: (_: unknown, r: Row) => (
                  <div className="bill-description">
                    {r.display_description || r.facts.description || "—"}
                  </div>
                ),
              },
              {
                title: "金额 / 方向",
                ...sorting("amount"),
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
                ...sorting("account"),
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
                ...sorting("category"),
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
                ...sorting("classification_status"),
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
          width={680}
          footer={null}
          closable={!this.state.busy}
          maskClosable={!this.state.busy}
          keyboard={!this.state.busy}
          destroyOnHidden
          onCancel={() => this.closeReview()}
        >
          {this.state.reviewing && (
            <BillReviewForm
              key={this.state.reviewing.id}
              bill={this.state.reviewing}
              accounts={this.state.accounts}
              categories={this.state.categories}
              busy={this.state.busy}
              onSubmit={(values) => this.resolve(values)}
            />
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
                    AmountPrivacy.fields({
                      original: detail.original_fields,
                      related: detail.related_sources,
                    }),
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
