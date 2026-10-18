import { ReportPeriodFilter } from "./ReportPeriodFilter";
import "@ant-design/v5-patch-for-react-19";
import React from "react";
import { createRoot } from "react-dom/client";
import {
  Collapse,
  Button,
  Card,
  Table,
  Tag,
  Space,
  Select,
  Input,
  InputNumber,
  Modal,
  Form,
  TreeSelect,
  DatePicker,
  Switch,
  Alert,
  Empty,
  Popconfirm,
  Descriptions,
  message,
  Tooltip,
} from "antd";
import {
  PlusOutlined,
  ArrowUpOutlined,
  ArrowDownOutlined,
  DownloadOutlined,
  SearchOutlined,
  ArrowRightOutlined,
} from "@ant-design/icons";
import dayjs from "dayjs";
import {
  LedgerApi,
  MoneyFormatter as Money,
  CategoryTree,
  AccountGroupTree,
  TagTree,
  Row,
} from "./api";
import "./style.css";
import { PagedTable } from "./PagedTable";
import { BillWorkspace } from "./BillWorkspace";
import { BillAttention } from "./BillReviewModel";
import { DataBackupPanel } from "./DataBackupPanel";
import { ImportWorkspace } from "./ImportWorkspace";
import { CatalogWorkspace } from "./CatalogWorkspace";
import { AccountWorkspace } from "./AccountWorkspace";
import { AccountSettings } from "./AccountSettings";
import { ClassificationSettings } from "./ClassificationSettings";
import { BalanceSheetWorkspace } from "./BalanceSheetWorkspace";
import { FinancialAnalysisWorkspace } from "./FinancialAnalysisWorkspace";
import { FundFlowWorkspace } from "./FundFlowWorkspace";
import {
  AppearanceProvider,
  AppearanceSettings,
  Appearance,
} from "./Appearance";
import { ReportCharts } from "./ReportCharts";
import { CounterpartyWorkspace } from "./CounterpartyWorkspace";
import { InvestmentWorkspace } from "./InvestmentWorkspace";
import { AnalysisSettings } from "./AnalysisSettings";
import { SingleAccountWorkspace } from "./SingleAccountWorkspace";
import { IncomeWorkspace } from "./IncomeWorkspace";
import { ExpenseWorkspace } from "./ExpenseWorkspace";
import { Navigation } from "./Navigation";
import { WorkspaceHeader } from "./WorkspaceHeader";
import { WorkspaceContent } from "./WorkspaceContent";
import { SidebarNavigation } from "./SidebarNavigation";
import { OverviewWorkspace } from "./OverviewWorkspace";

import { ReportDetailReading } from "./ReportDetailReading";

const kindNames: Row = {
  EXPENSE: "支出",
  INCOME: "收入",
  TRANSFER: "转账",
  REFUND: "退款",
  OPENING: "期初",
  REVERSAL: "冲销",
};
const states: Row = {
  READY: ["可入账", "green"],
  REVIEW: ["待确认", "orange"],
  POSTED: ["已入账", "blue"],
  DUPLICATE: ["重复", "default"],
  IGNORED: ["已忽略", "default"],
  LINKED: ["已关联交易", "cyan"],
  ERROR: ["解析错误", "red"],
  REVERSED: ["已撤销", "red"],
};
interface State {
  page: string;
  reportTab: string;
  counterpartyAccountId?: number;
  singleAccountId?: number;
  singleAccountFilters?: Row;
  accounts: Row[];
  groups: Row[];
  categories: Row[];
  tags: Row[];
  transactions: Row[];
  summary: Row;
  reportScopeKey: string;
  reportRefreshing: boolean;
  batches: Row[];
  rows: Row[];
  batch?: number;
  filters: Row;
  modal?: string;
  editing?: Row;
  formKind: string;
  busy: boolean;
  loading: boolean;
  saved: Row[];
  importFilter: string;
  billFilters: Row;
  pendingBillCount: number;
  newAccountGroup?: number;
  catalogInitial?: Row;
  integrity?: Row;
}
class LedgerApp extends React.Component<{}, State> {
  api = new LedgerApi();
  refreshVersion = 0;
  form = React.createRef<any>();
  state: State = {
    page: "overview",
    reportTab: "balance-sheet",
    accounts: [],
    groups: [],
    categories: [],
    tags: [],
    transactions: [],
    summary: {},
    reportScopeKey: "",
    reportRefreshing: true,
    batches: [],
    rows: [],
    filters: ReportPeriodFilter.defaults(),
    formKind: "EXPENSE",
    busy: false,
    loading: true,
    saved: [],
    importFilter: "ALL",
    billFilters: ReportPeriodFilter.defaults(),
    pendingBillCount: 0,
  };
  async componentDidMount() {
    await this.refresh();
  }
  componentWillUnmount() {
    this.refreshVersion++;
  }
  async refresh() {
    const version = ++this.refreshVersion;
    this.setState({ reportRefreshing: true });
    try {
      const query = this.api.query(this.state.filters);
      const [
        accounts,
        groups,
        categories,
        tags,
        transactions,
        summary,
        batches,
        saved,
        pendingBills,
      ] = await Promise.all(
        [
          "/accounts",
          "/account-groups",
          "/categories",
          "/tags",
          "/transactions?" + query,
          "/reports/summary?" + query,
          "/imports",
          "/reports/saved",
          "/bills?ledger_status=PENDING",
        ].map((p) => this.api.request(p)),
      );
      if (version !== this.refreshVersion) return;
      this.setState({
        reportScopeKey: query,
        reportRefreshing: false,
        accounts,
        groups,
        categories,
        tags,
        transactions,
        summary,
        batches,
        saved,
        pendingBillCount: pendingBills.length,
        loading: false,
      });
      if (this.state.batch) await this.loadBatch(this.state.batch);
    } catch (e) {
      if (version !== this.refreshVersion) return;
      this.fail(e);
      this.setState({ loading: false, reportRefreshing: false });
    }
  }
  fail(e: unknown) {
    message.error(e instanceof Error ? e.message : "操作失败，请重试");
  }
  async loadBatch(id: number) {
    try {
      const rows = await this.api.request(`/imports/${id}/rows`);
      this.setState({ rows, batch: id });
    } catch (e) {
      this.fail(e);
    }
  }
  setFilter(update: Row) {
    this.setState({ filters: { ...this.state.filters, ...update } }, () =>
      this.refresh(),
    );
  }
  open(modal: string, editing?: Row, kind = "EXPENSE", catalogInitial?: Row) {
    if (modal === "valuation")
      this.valuationSubmissionKey = crypto.randomUUID();
    this.setState({
      modal,
      editing,
      newAccountGroup: undefined,
      catalogInitial,
      formKind: editing?.kind || editing?.decision?.kind || kind,
    });
  }
  get tree() {
    return new CategoryTree(this.state.categories);
  }
  valuationSubmissionKey = "";
  get accountsOptions() {
    return this.state.accounts
      .filter((a) => a.role !== "SYSTEM" && a.active)
      .map((a) => ({ value: a.id, label: a.name }));
  }
  get tagOptions() {
    return [
      ...new Set([
        ...this.state.tags.map((t) => t.name),
        ...this.state.accounts.flatMap((a) => a.tags),
        ...this.state.transactions.flatMap((t) => t.tags),
      ]),
    ]
      .filter(
        (name) =>
          !this.state.tags.some((t) => t.name === name && t.active === false),
      )
      .map((name) => ({ label: name, value: name }));
  }
  async submit(values: Row) {
    this.setState({ busy: true });
    try {
      const { modal, editing, formKind } = this.state;
      let path = "",
        method = "POST",
        data = { ...values };
      if (modal === "account") {
        path = "/accounts" + (editing ? "/" + editing.id : "");
        method = editing ? "PUT" : "POST";
      }
      if (modal === "category") {
        path = "/categories" + (editing ? "/" + editing.id : "");
        method = editing ? "PUT" : "POST";
        data.parent_id = data.parent_id || null;
      }
      if (modal === "tag") {
        path = "/tags" + (editing ? "/" + editing.id : "");
        method = editing ? "PUT" : "POST";
      }
      if (modal === "transaction") {
        path = editing
          ? `/transactions/${editing.id}/replace`
          : "/transactions";
        data.kind = formKind;
        if (formKind === "REFUND") {
          delete data.items;
          delete data.category_id;
        }
        data.occurred_at = values.occurred_at.format("YYYY-MM-DD HH:mm:ss");
        data.idempotency_key = crypto.randomUUID();
      }
      if (modal === "opening") {
        path = `/accounts/${editing!.id}/opening`;
        data.occurred_at = values.occurred_at.format("YYYY-MM-DD HH:mm:ss");
      }
      if (modal === "reconcile") {
        path = `/accounts/${editing!.id}/reconcile`;
        data.at = values.at.format("YYYY-MM-DD HH:mm:ss");
      }
      if (modal === "valuation") {
        path = `/accounts/${editing!.id}/valuations`;
        data.occurred_at = values.occurred_at.format("YYYY-MM-DD HH:mm:ss");
        data.idempotency_key = this.valuationSubmissionKey;
      }
      if (modal === "decision") {
        path = `/import-rows/${editing!.id}`;
        method = "PUT";
        data.kind = formKind;
      }
      if (modal === "saveReport") {
        path = "/reports/saved";
        data.filters = this.state.filters;
      }
      const result = await this.api.request(path, method, data);
      this.setState({ modal: undefined });
      if (modal === "reconcile")
        Modal.info({
          title: result.difference === 0 ? "余额核对一致" : "发现余额差额",
          content: (
            <Descriptions column={1}>
              <Descriptions.Item label="系统余额">
                ¥ {Money.format(result.calculated)}
              </Descriptions.Item>
              <Descriptions.Item label="实际余额">
                ¥ {Money.format(result.actual)}
              </Descriptions.Item>
              <Descriptions.Item label="差额">
                ¥ {Money.format(result.difference)}
              </Descriptions.Item>
            </Descriptions>
          ),
        });
      else if (modal === "valuation")
        message.success(
          result.baseline
            ? "首次余额已记为期初基准"
            : result.change === 0
              ? "余额已记录，无盈亏变动"
              : `已生成${result.change > 0 ? "收益" : "亏损"}交易 ¥ ${Money.format(Math.abs(result.change))}`,
        );
      else message.success("已保存");
      await this.refresh();
    } catch (e) {
      this.fail(e);
    } finally {
      this.setState({ busy: false });
    }
  }
  async action(path: string, body: Row = {}) {
    try {
      this.setState({ busy: true });
      const result = await this.api.request(path, "POST", body);
      await this.refresh();
      return result;
    } catch (e) {
      this.fail(e);
    } finally {
      this.setState({ busy: false });
    }
  }
  renderFilters() {
    return (
      <div className="filters">
        <ReportPeriodFilter
          refreshKey={String(this.state.transactions[0]?.occurred_at || "")}
          filters={this.state.filters}
          label="筛选日期"
          onChange={(patch) => this.setFilter(patch)}
        />
        <Select
          allowClear
          aria-label="报表账户组"
          placeholder="全部账户组"
          style={{ width: 200 }}
          options={new AccountGroupTree(this.state.groups).options()}
          value={this.state.filters.group_id}
          onChange={(group_id) => this.setFilter({ group_id })}
        />
        <Select
          allowClear
          placeholder="全部账户"
          style={{ width: 150 }}
          options={this.accountsOptions}
          value={this.state.filters.account_id}
          onChange={(v) => this.setFilter({ account_id: v })}
        />
        <TreeSelect
          allowClear
          placeholder="全部分类"
          style={{ width: 170 }}
          treeData={this.tree.options()}
          value={this.state.filters.category_id}
          onChange={(v) => this.setFilter({ category_id: v })}
        />
        <TreeSelect
          allowClear
          placeholder="流水标签"
          treeDefaultExpandAll
          treeData={new TagTree(this.state.tags).options("TRANSACTION")}
          style={{ width: 135 }}
          value={this.state.filters.tag}
          onChange={(v) => this.setFilter({ tag: v })}
        />
        <Input.Search
          placeholder="搜索交易对方、备注"
          allowClear
          style={{ width: 220 }}
          onSearch={(v) => this.setFilter({ q: v })}
        />
        <Button
          onClick={() =>
            this.setState({ filters: ReportPeriodFilter.defaults() }, () =>
              this.refresh(),
            )
          }
        >
          重置
        </Button>
      </div>
    );
  }
  renderMetrics() {
    const { summary, transactions } = this.state;
    const reading = new ReportDetailReading(summary, transactions);
    return (
      <div className="metrics">
        <div className="metric featured">
          <span>当前范围收支结余</span>
          <strong>¥ {Money.format(summary.net)}</strong>
          <small>收入 − 净支出，不代表账户余额</small>
        </div>
        <div className="metric">
          <span>
            <ArrowDownOutlined /> 收入
          </span>
          <strong className="income">¥ {Money.format(summary.income)}</strong>
          <small>当前筛选范围，含筛选内的证券盈利</small>
        </div>
        <div className="metric">
          <span>
            <ArrowUpOutlined /> 净支出
          </span>
          <strong>¥ {Money.format(summary.expense)}</strong>
          <small>已扣除退款，含筛选内的证券亏损</small>
        </div>
        <div className="metric">
          <span>其中：独立退款抵减</span>
          <strong>¥ {Money.format(reading.refunds)}</strong>
          <small>{reading.count("REFUND")} 笔退款，已在净支出中扣除</small>
        </div>
      </div>
    );
  }
  renderCharts() {
    const scopeKey = this.api.query(this.state.filters);
    return (
      <ReportCharts
        summary={this.state.summary}
        transactions={this.state.transactions}
        scopeKey={scopeKey}
        loading={
          this.state.loading ||
          this.state.reportRefreshing ||
          this.state.reportScopeKey !== scopeKey
        }
        onDetail={(row) => this.open("detail", row)}
      />
    );
  }
  transactionColumns: any[] = [
    {
      title: "时间 / 交易",
      dataIndex: "occurred_at",
      width: 230,
      render: (v: string, r: Row) => (
        <>
          <div className="cell-title">
            {r.counterparty || kindNames[r.kind]}
          </div>
          <small className="muted">{v}</small>
        </>
      ),
    },
    {
      title: "类型",
      dataIndex: "kind",
      width: 85,
      render: (v: string) => (
        <Tag
          color={
            v === "INCOME" ? "green" : v === "EXPENSE" ? "default" : "blue"
          }
        >
          {kindNames[v]}
        </Tag>
      ),
    },
    {
      title: "账户 / 分类",
      render: (_: any, r: Row) => (
        <>
          <div>
            {r.entries
              .filter((e: Row) => e.role !== "SYSTEM")
              .map((e: Row) => e.account)
              .join(" → ")}
          </div>
          <small className="muted">
            {r.entries
              .filter((e: Row) => e.category_id)
              .map((e: Row) => this.tree.path(e.category_id))
              .join("、") || "—"}
          </small>
        </>
      ),
    },
    {
      title: "金额",
      dataIndex: "amount",
      align: "right",
      width: 140,
      render: (v: number, r: Row) => (
        <strong
          className={["INCOME", "REFUND"].includes(r.kind) ? "income" : ""}
        >
          {r.kind === "EXPENSE"
            ? "-"
            : ["INCOME", "REFUND"].includes(r.kind)
              ? "+"
              : ""}
          {Money.format(v)}
        </strong>
      ),
    },
    {
      title: "标签 / 来源",
      render: (_: any, r: Row) => (
        <>
          <div>
            {r.tags.map((t: string) => (
              <Tag key={t}>{t}</Tag>
            ))}
          </div>
          <small className="muted">{r.source}</small>
        </>
      ),
    },
    {
      title: "操作",
      width: 150,
      render: (_: any, r: Row) => (
        <Space>
          <Button
            type="link"
            size="small"
            onClick={() => this.open("detail", r)}
          >
            详情
          </Button>
          {!["OPENING", "REVERSAL"].includes(r.kind) && (
            <>
              <Button
                type="link"
                size="small"
                onClick={() => this.open("transaction", r)}
              >
                修改
              </Button>
              <Popconfirm
                title="撤销这笔交易？"
                description="将保留原记录并冲销金额。"
                onConfirm={() => this.action(`/transactions/${r.id}/reverse`)}
              >
                <Button type="link" danger size="small">
                  撤销
                </Button>
              </Popconfirm>
            </>
          )}
        </Space>
      ),
    },
  ];
  renderOverview() {
    return (
      <OverviewWorkspace
        onSingleAccount={(accountId, filters) =>
          this.setState({
            page: "reports",
            reportTab: "single-accounts",
            singleAccountId: accountId,
            singleAccountFilters: filters,
          })
        }
        onConfigure={() => this.setState({ page: "analysis-settings" })}
        refreshKey={JSON.stringify([
          this.state.accounts,
          this.state.groups,
          this.state.transactions,
          this.state.batches,
          this.state.pendingBillCount,
        ])}
        onReport={(reportTab) => {
          if (reportTab === "details")
            this.setState(
              {
                page: "reports",
                reportTab,
                filters: ReportPeriodFilter.defaults(),
              },
              () => this.refresh(),
            );
          else this.setState({ page: "reports", reportTab });
        }}
        onAccounts={() => this.setState({ page: "accounts" })}
        onPending={() =>
          this.setState({
            page: "bills",
            billFilters: BillAttention.filters(),
          })
        }
        onImport={() => {
          this.setState({ page: "imports" });
          if (!this.state.batch && this.state.batches[0])
            this.loadBatch(this.state.batches[0].id);
        }}
        onDetail={(row) => this.open("detail", row)}
      />
    );
  }
  renderAccounts() {
    return (
      <AccountWorkspace
        accounts={this.state.accounts}
        groups={this.state.groups}
        onAdd={(group) =>
          this.setState({
            modal: "account",
            editing: undefined,
            newAccountGroup: group,
            formKind: "EXPENSE",
          })
        }
        onEdit={(kind, account) => this.open(kind, account)}
        onAnalyse={(account) =>
          this.setState({
            page: "reports",
            reportTab: "counterparties",
            counterpartyAccountId: account.id,
          })
        }
        onTransactions={(filters) =>
          this.setState({ page: "transactions", filters }, () => this.refresh())
        }
        onConfigure={() =>
          this.setState({ page: "settings" }, () =>
            requestAnimationFrame(() =>
              document
                .getElementById("account-group-settings")
                ?.scrollIntoView({
                  behavior: "smooth",
                  block: "start",
                }),
            ),
          )
        }
      />
    );
  }
  renderTransactions() {
    return (
      <>
        {this.renderFilters()}
        <Card
          title={`${this.state.transactions.length} 笔流水`}
          extra={
            <Space>
              <Button
                icon={<DownloadOutlined />}
                href={"/api/export?" + this.api.query(this.state.filters)}
              >
                导出 CSV
              </Button>
              <Button
                type="primary"
                icon={<PlusOutlined />}
                onClick={() => this.open("transaction")}
              >
                记一笔
              </Button>
            </Space>
          }
        >
          <PagedTable
            rowKey="id"
            columns={this.transactionColumns}
            dataSource={this.state.transactions}
            scroll={{ x: 1050 }}
            defaultPageSize={15}
            pageResetKey={JSON.stringify(this.state.filters)}
          />
        </Card>
      </>
    );
  }
  renderImports() {
    return (
      <>
        <ImportWorkspace
          onChanged={() => this.refresh()}
          refreshKey={JSON.stringify([
            this.state.batches.map((b) => [b.id, b.counts]),
            this.state.transactions.map((t) => [t.id, t.status]),
          ])}
        />
        <Collapse
          className="mt"
          items={[
            {
              key: "sources",
              label: "原始账单记录（只读）",
              children: this.renderRawImports(),
            },
          ]}
        />
      </>
    );
  }
  renderRawImports() {
    const { rows, batch, batches } = this.state;
    const current = batches.find((b) => b.id === batch);
    return (
      <div className="raw-import-records">
        <Alert
          className="mb"
          type="info"
          showIcon
          message="原始账单记录仅供查看和追溯"
          description="原文件合计包含转存、退款等记录，不等于实际收入或支出。核对入账请前往交易明细，实际统计请查看统计报表。"
          action={
            <Button onClick={() => this.setState({ page: "bills" })}>
              前往交易明细
            </Button>
          }
        />
        <Card title="原文件记录">
          <Select
            aria-label="原始账单文件"
            placeholder="选择已上传的原始账单"
            style={{ width: "100%" }}
            value={batch}
            onChange={(id) => this.loadBatch(id)}
            options={batches.map((b) => ({ value: b.id, label: b.filename }))}
          />
          {current ? (
            <>
              <div className="source-totals">
                {Object.entries(current.metadata.totals || {}).map(([k, v]) => (
                  <div key={k}>
                    <span>原文件{k}合计</span>
                    <strong>¥ {Money.format((v as Row).amount)}</strong>
                    <small>{(v as Row).count} 笔</small>
                  </div>
                ))}
              </div>
              {Object.keys(current.metadata.declared_totals || {}).length >
                0 && (
                <div className="source-declared">
                  原文件摘要：
                  {Object.entries(current.metadata.declared_totals).map(
                    ([k, v]) => (
                      <span key={k}>
                        {k} ¥ {Money.format((v as Row).amount)}（
                        {(v as Row).count} 笔）　
                      </span>
                    ),
                  )}
                </div>
              )}
              {current.metadata.warnings?.map((w: string) => (
                <Alert key={w} message={w} type="warning" />
              ))}
              <div className="mt">
                <Space wrap className="mb">
                  <span>
                    原始记录 <Tag>{rows.length} 条</Tag>
                  </span>
                  <Select
                    aria-label="原始记录状态"
                    value={this.state.importFilter}
                    onChange={(v) => this.setState({ importFilter: v })}
                    style={{ width: 140 }}
                    options={[
                      { value: "ALL", label: "全部状态" },
                      ...Object.entries(states).map(([value, v]) => ({
                        value,
                        label: v[0],
                      })),
                    ]}
                  />
                </Space>
                <PagedTable
                  rowKey="id"
                  dataSource={rows.filter(
                    (r) =>
                      this.state.importFilter === "ALL" ||
                      r.status === this.state.importFilter,
                  )}
                  defaultPageSize={12}
                  pageResetKey={JSON.stringify([
                    this.state.batch,
                    this.state.importFilter,
                  ])}
                  scroll={{ x: 1100 }}
                  columns={[
                    {
                      title: "原交易时间 / 对方",
                      width: 220,
                      render: (_: unknown, r: Row) => (
                        <>
                          <div className="cell-title">
                            {r.counterparty || "—"}
                          </div>
                          <small className="muted">{r.occurred_at}</small>
                        </>
                      ),
                    },
                    {
                      title: "原说明 / 付款方式",
                      width: 280,
                      render: (_: unknown, r: Row) => (
                        <>
                          <Tooltip title={r.note}>
                            <div className="ellipsis">{r.note}</div>
                          </Tooltip>
                          <small className="muted">
                            {r.method || "未提供付款方式"}
                          </small>
                        </>
                      ),
                    },
                    { title: "原收支", dataIndex: "direction", width: 90 },
                    {
                      title: "原金额",
                      dataIndex: "amount",
                      align: "right",
                      width: 110,
                      render: (v: number) => Money.format(v),
                    },
                    {
                      title: "记录状态",
                      width: 105,
                      render: (_: unknown, r: Row) => (
                        <Tag color={states[r.status][1]}>
                          {states[r.status][0]}
                        </Tag>
                      ),
                    },
                    {
                      title: "关联账户 / 处理说明",
                      width: 220,
                      render: (_: unknown, r: Row) => (
                        <>
                          <div>
                            {this.state.accounts.find(
                              (a) => a.id === r.decision.account_id,
                            )?.name || "尚未关联账户"}
                          </div>
                          <small className="muted">{r.warning || "—"}</small>
                        </>
                      ),
                    },
                    {
                      title: "查看",
                      width: 120,
                      render: (_: unknown, r: Row) => (
                        <Button
                          size="small"
                          type="link"
                          onClick={() => this.open("raw", r)}
                        >
                          原始字段
                        </Button>
                      ),
                    },
                  ]}
                />
              </div>
            </>
          ) : (
            <Empty
              description="尚无原始账单，请在上方上传"
              image={Empty.PRESENTED_IMAGE_SIMPLE}
            />
          )}
        </Card>
      </div>
    );
  }
  renderCatalog() {
    return (
      <CatalogWorkspace
        categories={this.state.categories}
        tags={this.state.tags}
        onTagActivation={async (row, active) => {
          try {
            await this.api.request(`/tags/${row.id}/activation`, "POST", {
              active,
            });
            await this.refresh();
            message.success(
              active
                ? "标签及子标签已恢复"
                : "标签及子标签已归档，历史记录保留",
            );
          } catch (error) {
            this.fail(error);
          }
        }}
        onOpen={(kind, row, initial) =>
          this.open(kind, row, "EXPENSE", initial)
        }
      />
    );
  }
  renderReportDetails() {
    return (
      <>
        <div className="section-top">
          <Space>
            <Select
              allowClear
              placeholder="打开保存的报表"
              style={{ width: 220 }}
              options={this.state.saved.map((r) => ({
                value: r.id,
                label: r.name,
              }))}
              onChange={(id) => {
                const r = this.state.saved.find((r) => r.id === id);
                if (r)
                  this.setState({ filters: r.filters }, () => this.refresh());
              }}
            />
            <Button onClick={() => this.open("saveReport")}>
              保存当前条件
            </Button>
          </Space>
          <Button
            href={"/api/export?" + this.api.query(this.state.filters)}
            icon={<DownloadOutlined />}
          >
            导出明细
          </Button>
        </div>
        {this.renderFilters()}
        {this.renderMetrics()}

        {this.renderCharts()}
        <Card
          title="统计明细"
          extra={
            <span className="muted">
              分类筛选包含全部子分类；拆分交易只累计匹配的金额
            </span>
          }
        >
          <PagedTable
            rowKey="id"
            columns={this.transactionColumns}
            dataSource={this.state.transactions}
            defaultPageSize={10}
            pageResetKey={JSON.stringify(this.state.filters)}
            scroll={{ x: 1000 }}
          />
        </Card>
      </>
    );
  }
  renderReports() {
    const refreshKey = JSON.stringify([
      this.state.accounts,
      this.state.groups,
      this.state.categories,
      this.state.tags,
      this.state.transactions,
    ]);
    const items = [
      {
        key: "income",
        label: "收入分析",
        children: (
          <IncomeWorkspace
            accounts={this.state.accounts}
            groups={this.state.groups}
            categories={this.state.categories}
            refreshKey={refreshKey}
            onConfigure={() => this.setState({ page: "analysis-settings" })}
            onDetail={(row) => this.open("detail", row)}
          />
        ),
      },
      {
        key: "expenses",
        label: "支出分析",
        children: (
          <ExpenseWorkspace
            groups={this.state.groups}
            accounts={this.state.accounts}
            categories={this.state.categories}
            refreshKey={refreshKey}
            onConfigure={() => this.setState({ page: "analysis-settings" })}
            onDetail={(row) => this.open("detail", row)}
          />
        ),
      },
      {
        key: "analysis",
        label: "收支分析",
        children: (
          <FinancialAnalysisWorkspace
            accounts={this.state.accounts}
            groups={this.state.groups}
            categories={this.state.categories}
            tags={this.state.tags}
            refreshKey={refreshKey}
            onDetail={(row) => this.open("detail", row)}
          />
        ),
      },
      {
        key: "single-accounts",
        label: "单账户分析",
        children: (
          <SingleAccountWorkspace
            initialAccountId={this.state.singleAccountId}
            initialFilters={this.state.singleAccountFilters}
            refreshKey={refreshKey}
            onConfigure={() => this.setState({ page: "analysis-settings" })}
            onDetail={(row) => this.open("detail", row)}
          />
        ),
      },
      {
        key: "counterparties",
        label: "交易方分析",
        children: (
          <CounterpartyWorkspace
            accounts={this.state.accounts}
            initialAccountId={this.state.counterpartyAccountId}
            refreshKey={refreshKey}
            onDetail={(row) => this.open("detail", row)}
            onValuation={(account) => this.open("valuation", account)}
          />
        ),
      },
      {
        key: "investments",
        label: "理财分析",
        children: (
          <InvestmentWorkspace
            groups={this.state.groups}
            accounts={this.state.accounts}
            refreshKey={refreshKey}
            onDetail={(row) => this.open("detail", row)}
            onUpdate={(account) => this.open("valuation", account)}
            onAccounts={() => this.setState({ page: "accounts" })}
          />
        ),
      },
      {
        key: "fund-flow",
        label: "资金流转",
        children: (
          <FundFlowWorkspace
            accounts={this.state.accounts}
            groups={this.state.groups}
            refreshKey={refreshKey}
            onDetail={(row) => this.open("detail", row)}
          />
        ),
      },
      {
        key: "details",
        label: "统计明细",
        children: this.renderReportDetails(),
      },
      {
        key: "balance-sheet",
        label: "资产负债表",
        children: (
          <BalanceSheetWorkspace
            groups={this.state.groups}
            refreshKey={refreshKey}
            onAccounts={() => this.setState({ page: "accounts" })}
          />
        ),
      },
    ];
    return (
      items.find((item) => item.key === this.state.reportTab)?.children ||
      items.find((item) => item.key === "balance-sheet")!.children
    );
  }
  renderSettings() {
    return (
      <>
        <AppearanceSettings />
        <ClassificationSettings onChanged={() => this.refresh()} />
        <AccountSettings
          accounts={this.state.accounts}
          groups={this.state.groups}
          onChanged={() => this.refresh()}
        />
      </>
    );
  }
  async restoredData() {
    await new Promise<void>((resolve) =>
      this.setState(
        {
          filters: ReportPeriodFilter.defaults(),
          billFilters: ReportPeriodFilter.defaults(),
          batch: undefined,
          rows: [],
          integrity: undefined,
          modal: undefined,
          editing: undefined,
          singleAccountId: undefined,
          singleAccountFilters: undefined,
          counterpartyAccountId: undefined,
        },
        resolve,
      ),
    );
    await this.refresh();
  }
  renderData() {
    return (
      <>
        <div className="settings-grid">
          <DataBackupPanel onRestored={() => this.restoredData()} />
          <Card title="账目一致性">
            <p>逐笔检查流水是否平衡。账户余额实时由流水累计计算。</p>
            <Button
              onClick={async () => {
                try {
                  this.setState({
                    integrity: await this.api.request("/integrity"),
                  });
                } catch (e) {
                  this.fail(e);
                }
              }}
            >
              检查账目
            </Button>
            {this.state.integrity && (
              <Alert
                className="mt"
                showIcon
                type={this.state.integrity.ok ? "success" : "error"}
                message={
                  this.state.integrity.ok ? "所有交易均平衡" : "发现异常交易"
                }
                description={`${this.state.integrity.transactions} 笔交易 · ${this.state.integrity.entries} 条流水`}
              />
            )}
          </Card>
          <Card title="关于这个账本">
            <Descriptions column={1}>
              <Descriptions.Item label="版本">
                0.18.0 · 本地单用户版
              </Descriptions.Item>
              <Descriptions.Item label="币种">人民币 CNY</Descriptions.Item>
              <Descriptions.Item label="时间">
                北京时间（Asia/Shanghai）
              </Descriptions.Item>
              <Descriptions.Item label="数据位置">
                项目 data 文件夹 · SQLite
              </Descriptions.Item>
            </Descriptions>
            <p className="muted">
              支持支付宝、微信、小荷包、招商银行和中国银行账单。退款匹配由 Codex
              离线处理；金额按分精确保存。
            </p>
          </Card>
        </div>
      </>
    );
  }
  renderForm() {
    const { modal, editing: e, formKind } = this.state;
    if (modal === "detail")
      return (
        <>
          <Descriptions bordered size="small" column={1}>
            <Descriptions.Item label="时间">{e!.occurred_at}</Descriptions.Item>
            <Descriptions.Item label="备注">{e!.note || "—"}</Descriptions.Item>
            <Descriptions.Item label="来源">{e!.source}</Descriptions.Item>
            <Descriptions.Item label="记录编号">#{e!.id}</Descriptions.Item>
            <Descriptions.Item label="来源交易明细">
              <span style={{ overflowWrap: "anywhere" }}>
                {e!.bill_id || "历史记录"}
              </span>
            </Descriptions.Item>
          </Descriptions>
          <h3>账户变动</h3>
          <Table
            rowKey={(_, i) => String(i)}
            pagination={false}
            dataSource={e!.entries.filter((row: Row) => row.role !== "SYSTEM")}
            columns={[
              { title: "资金账户", dataIndex: "account" },
              {
                title: "余额变动",
                dataIndex: "amount",
                render: (value: number) => (
                  <span>
                    {value > 0 ? "+" : ""}
                    {Money.format(value)}
                  </span>
                ),
              },
            ]}
          />
          <p className="muted">
            消费只扣减实际付款账户；内部转账分别减少转出账户、增加转入账户。关联的账单凭证不增加账户变动。
          </p>
          <details>
            <summary>记账分录（用于平衡账目）</summary>
            <Table
              className="mt"
              rowKey={(_, i) => String(i)}
              pagination={false}
              dataSource={e!.entries}
              columns={[
                { title: "账户", dataIndex: "account" },
                { title: "分类", dataIndex: "category" },
                {
                  title: "金额",
                  dataIndex: "amount",
                  align: "right",
                  render: (v: number) => Money.format(v),
                },
              ]}
            />
            <p className="muted">
              所有分录合计：¥{" "}
              {Money.format(
                e!.entries.reduce((n: number, x: Row) => n + x.amount, 0),
              )}
            </p>
          </details>
        </>
      );
    if (modal === "raw")
      return (
        <Descriptions bordered column={1} size="small">
          {Object.entries(e!.raw).map(([k, v]) => (
            <Descriptions.Item key={k} label={k}>
              {String(v) || "—"}
            </Descriptions.Item>
          ))}
        </Descriptions>
      );
    let initial: Row = {
      active: true,
      role: "ASSET",
      kind: "EXPENSE",
      tags: [],
      ...e,
    };
    if (modal === "transaction") {
      const actual = e?.entries.find(
        (x: Row) =>
          x.role !== "SYSTEM" && (e.kind !== "TRANSFER" || x.amount < 0),
      );
      initial = {
        kind: formKind,
        occurred_at: e ? dayjs(e.occurred_at) : dayjs(),
        amount: e ? Money.input(e.amount) : undefined,
        account_id: actual?.account_id,
        to_account_id: e?.entries.find(
          (x: Row) => x.role !== "SYSTEM" && x.amount > 0,
        )?.account_id,
        category_id: e?.entries.find((x: Row) => x.category_id)?.category_id,
        counterparty: e?.counterparty,
        note: e?.note,
        tags: e?.tags || [],
        related_id: e?.related_id,
        items: e?.entries
          .filter((x: Row) => x.category_id)
          .map((x: Row) => ({
            category_id: x.category_id,
            amount: Money.input(Math.abs(x.amount)),
          })) || [{ amount: undefined, category_id: undefined }],
      };
    }
    if (modal === "opening")
      initial = { amount: "0.00", occurred_at: dayjs().startOf("month") };
    if (modal === "reconcile")
      initial = { at: dayjs(), actual: Money.input(e!.balance) };
    if (modal === "valuation")
      initial = {
        occurred_at: dayjs(),
        actual: Money.input(e!.balance),
        note: "",
      };
    if (modal === "decision")
      initial = {
        ...e!.decision,
        kind: formKind,
        amount: e!.decision.amount || Money.input(e!.amount),
      };
    if (modal === "tag") initial = { scope: "BOTH", ...e };
    if (!e) initial = { ...initial, ...this.state.catalogInitial };
    if (modal === "account" && !e)
      initial = {
        role: "ASSET",
        kind: "其他",
        active: true,
        tags: [],
        group_id: this.state.newAccountGroup,
      };
    return (
      <Form
        ref={this.form}
        key={modal + "-" + (e?.id || "new")}
        layout="vertical"
        initialValues={initial}
        onFinish={(v) => this.submit(v)}
        onValuesChange={(v) => {
          if (v.kind && ["transaction", "decision"].includes(modal || "")) {
            this.setState({ formKind: v.kind });
            this.form.current?.setFieldsValue({
              category_id: undefined,
              items: [{}],
            });
          }
        }}
      >
        {modal === "account" && (
          <>
            <div className="form-grid">
              <Form.Item
                name="name"
                label="账户名称"
                rules={[{ required: true }]}
              >
                <Input placeholder="例如：招商银行储蓄卡" />
              </Form.Item>
              <Form.Item name="role" label="账户角色">
                <Select
                  options={[
                    { value: "ASSET", label: "自有资产" },
                    { value: "LIABILITY", label: "自有负债" },
                    { value: "EXTERNAL", label: "外部往来" },
                  ]}
                />
              </Form.Item>
            </div>
            <div className="form-grid">
              <Form.Item name="number" label="账号 / 卡号">
                <Input />
              </Form.Item>
              <Form.Item name="kind" label="账户类型">
                <Select
                  options={[
                    "支付宝",
                    "微信",
                    "银行卡",
                    "现金",
                    "信用卡",
                    "公司贷款",
                    "房贷",
                    "理财",
                    "证券",
                    "其他",
                  ].map((x) => ({ value: x, label: x }))}
                />
              </Form.Item>
            </div>
            <Form.Item name="group_id" label="所属账户组">
              <Select
                allowClear
                options={new AccountGroupTree(this.state.groups).options()}
                placeholder="选择个人或家庭账户组"
              />
            </Form.Item>
            <Form.Item name="tags" label="账户标签">
              <Select
                mode="tags"
                options={this.tagOptions.filter(
                  (t) =>
                    !this.state.tags.some(
                      (x) => x.name === t.value && x.scope === "TRANSACTION",
                    ),
                )}
              />
            </Form.Item>
            <Form.Item name="note" label="账户备注">
              <Input.TextArea
                rows={3}
                maxLength={2000}
                showCount
                placeholder="例如：每月还款金额、还款截止月份等"
              />
            </Form.Item>
            <Form.Item name="active" label="启用账户" valuePropName="checked">
              <Switch />
            </Form.Item>
          </>
        )}
        {modal === "category" && (
          <>
            <Form.Item
              name="name"
              label="分类名称"
              rules={[{ required: true }]}
            >
              <Input />
            </Form.Item>
            <Form.Item name="kind" label="类型">
              <Select
                options={[
                  { value: "EXPENSE", label: "支出" },
                  { value: "INCOME", label: "收入" },
                ]}
              />
            </Form.Item>
            <Form.Item name="parent_id" label="父分类（留空为顶级）">
              <TreeSelect allowClear treeData={this.tree.options()} />
            </Form.Item>
            <Form.Item name="active" label="启用" valuePropName="checked">
              <Switch />
            </Form.Item>
            <p className="muted">移动分类会改变历史报表的分类归属。</p>
          </>
        )}
        {modal === "tag" && (
          <>
            <Form.Item
              name="name"
              label="标签名称"
              rules={[{ required: true }]}
            >
              <Input />
            </Form.Item>
            <Form.Item name="parent_id" label="父标签">
              <TreeSelect
                allowClear
                placeholder="留空为一级标签"
                treeDefaultExpandAll
                treeData={new TagTree(this.state.tags).options(
                  undefined,
                  null,
                  true,
                  e?.id
                    ? new TagTree(this.state.tags).descendants(e.id)
                    : new Set(),
                )}
              />
            </Form.Item>
            <Form.Item name="scope" label="适用范围">
              <Select
                options={[
                  { value: "BOTH", label: "账户与流水" },
                  { value: "ACCOUNT", label: "账户" },
                  { value: "TRANSACTION", label: "流水" },
                ]}
              />
            </Form.Item>
          </>
        )}
        {["transaction", "decision"].includes(modal || "") && (
          <>
            {modal === "decision" && (
              <Alert
                className="mb"
                type="info"
                message={`${e!.counterparty} · ${e!.note}`}
                description={`原口径：${e!.direction}；原付款方式：${e!.method || "未提供"}。${e!.warning}`}
              />
            )}
            <Form.Item
              name="kind"
              label="业务类型"
              rules={[{ required: true }]}
            >
              <Select
                options={["EXPENSE", "INCOME", "TRANSFER", "REFUND"].map(
                  (x) => ({ value: x, label: kindNames[x] }),
                )}
              />
            </Form.Item>
            <div className="form-grid">
              <Form.Item
                name="account_id"
                label={
                  formKind === "TRANSFER"
                    ? "转出账户"
                    : ["INCOME", "REFUND"].includes(formKind)
                      ? "收款账户"
                      : "付款账户"
                }
                rules={[{ required: true }]}
              >
                <Select
                  options={this.accountsOptions}
                  placeholder="请选择实际账户"
                />
              </Form.Item>
              {formKind === "TRANSFER" ? (
                <Form.Item
                  name="to_account_id"
                  label="转入账户"
                  rules={[{ required: true }]}
                >
                  <Select options={this.accountsOptions} />
                </Form.Item>
              ) : modal === "decision" ? (
                <Form.Item
                  name="category_id"
                  label="分类"
                  rules={[{ required: true }]}
                >
                  <TreeSelect
                    treeData={this.tree.options(
                      formKind === "INCOME" ? "INCOME" : "EXPENSE",
                    )}
                  />
                </Form.Item>
              ) : (
                <Form.Item
                  name="occurred_at"
                  label="交易时间"
                  rules={[{ required: true }]}
                >
                  <DatePicker showTime style={{ width: "100%" }} />
                </Form.Item>
              )}
            </div>
            {(modal === "decision" ||
              ["TRANSFER", "REFUND"].includes(formKind)) && (
              <Form.Item
                name="amount"
                label="实际金额（元）"
                rules={[{ required: true }]}
              >
                <InputNumber
                  stringMode
                  min="0.01"
                  precision={2}
                  style={{ width: "100%" }}
                />
              </Form.Item>
            )}
            {modal === "transaction" && formKind === "REFUND" && (
              <Alert
                className="mb"
                type="info"
                message="退款统一使用“退款”分类"
              />
            )}
            {modal === "transaction" &&
              !["TRANSFER", "REFUND"].includes(formKind) && (
                <Form.List name="items">
                  {(fields, { add, remove }) => (
                    <>
                      <label className="form-label">金额与分类（可拆分）</label>
                      {fields.map(({ key, name, ...rest }) => (
                        <div key={key} className="split-row">
                          <Form.Item
                            {...rest}
                            name={[name, "category_id"]}
                            rules={[{ required: true, message: "请选择分类" }]}
                          >
                            <TreeSelect
                              placeholder="分类"
                              treeData={this.tree.options(
                                formKind === "INCOME" ? "INCOME" : "EXPENSE",
                              )}
                            />
                          </Form.Item>
                          <Form.Item
                            {...rest}
                            name={[name, "amount"]}
                            rules={[{ required: true, message: "请填写金额" }]}
                          >
                            <InputNumber
                              stringMode
                              min="0.01"
                              precision={2}
                              placeholder="金额（元）"
                              style={{ width: "100%" }}
                            />
                          </Form.Item>
                          {fields.length > 1 && (
                            <Button onClick={() => remove(name)}>移除</Button>
                          )}
                        </div>
                      ))}
                      <Button type="dashed" onClick={() => add({})} block>
                        添加一项分类
                      </Button>
                    </>
                  )}
                </Form.List>
              )}
            {modal === "transaction" && formKind === "TRANSFER" && (
              <Form.Item
                name="occurred_at"
                label="交易时间"
                rules={[{ required: true }]}
              >
                <DatePicker showTime style={{ width: "100%" }} />
              </Form.Item>
            )}
            {formKind === "REFUND" && (
              <Form.Item name="related_id" label="关联原支出（可选）">
                <Select
                  allowClear
                  showSearch
                  optionFilterProp="label"
                  options={this.state.transactions
                    .filter((t) => t.kind === "EXPENSE")
                    .map((t) => ({
                      value: t.id,
                      label: `#${t.id} ${t.counterparty} ¥${Money.format(t.amount)}`,
                    }))}
                />
              </Form.Item>
            )}
            {modal === "transaction" && (
              <>
                <Form.Item className="mt" name="counterparty" label="交易对方">
                  <Input placeholder="商户名称，仅保存在交易中" />
                </Form.Item>
                <Form.Item name="note" label="备注">
                  <Input.TextArea rows={2} />
                </Form.Item>
                <Form.Item name="tags" label="流水标签">
                  <Select
                    mode="tags"
                    options={this.tagOptions.filter(
                      (t) =>
                        !this.state.tags.some(
                          (x) => x.name === t.value && x.scope === "ACCOUNT",
                        ),
                    )}
                  />
                </Form.Item>
              </>
            )}
          </>
        )}
        {modal === "opening" && (
          <>
            <Alert
              className="mb"
              type="info"
              message="填写最早一笔流水发生前的真实余额。负债账户欠款请填写负数。"
            />
            <Form.Item
              name="amount"
              label="期初余额（元）"
              rules={[{ required: true }]}
            >
              <InputNumber stringMode precision={2} style={{ width: "100%" }} />
            </Form.Item>
            <Form.Item
              name="occurred_at"
              label="期初时间"
              rules={[{ required: true }]}
            >
              <DatePicker showTime style={{ width: "100%" }} />
            </Form.Item>
          </>
        )}
        {modal === "valuation" && (
          <>
            <Alert
              className="mb"
              type="info"
              message={
                e!.opening_set
                  ? "按新总资产与已记账余额的差额，生成估值盈亏交易。"
                  : "首次余额作为期初基准，不计算收益。已有流水时，请先补全期初。"
              }
              description="填写证券账户总资产（资金余额 + 持仓市值），不要只填可用资金。充值、提现先记内部转账，再更新余额；更新时间不能早于已有流水。"
            />
            <p>当前已记录余额：¥ {Money.format(e!.balance)}</p>
            <Form.Item
              name="actual"
              label="证券账户总资产（元）"
              rules={[{ required: true }]}
            >
              <InputNumber
                stringMode
                min="0"
                precision={2}
                style={{ width: "100%" }}
              />
            </Form.Item>
            <Form.Item
              name="occurred_at"
              label="余额更新时间"
              rules={[{ required: true }]}
            >
              <DatePicker
                showTime
                style={{ width: "100%" }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.preventDefault();
                }}
              />
            </Form.Item>
            <Form.Item name="note" label="更新备注">
              <Input placeholder="例如：月末资产估值" />
            </Form.Item>
          </>
        )}
        {modal === "reconcile" && (
          <>
            <Form.Item
              name="at"
              label="核对截止时间"
              rules={[{ required: true }]}
            >
              <DatePicker showTime style={{ width: "100%" }} />
            </Form.Item>
            <Form.Item
              name="actual"
              label="外部实际余额（元，欠款填负数）"
              rules={[{ required: true }]}
            >
              <InputNumber stringMode precision={2} style={{ width: "100%" }} />
            </Form.Item>
            <Form.Item name="note" label="核对备注">
              <Input />
            </Form.Item>
          </>
        )}
        {modal === "saveReport" && (
          <Form.Item name="name" label="报表名称" rules={[{ required: true }]}>
            <Input placeholder="例如：家庭每月餐饮" />
          </Form.Item>
        )}
        <div className="modal-footer">
          <Button onClick={() => this.setState({ modal: undefined })}>
            取消
          </Button>
          <Button type="primary" htmlType="submit" loading={this.state.busy}>
            {modal === "decision" ? "确认，可入账" : "保存"}
          </Button>
        </div>
      </Form>
    );
  }
  render() {
    const subtitles: Row = {
      bills: "已导入的统一账单，按流水号追溯。",
      overview: "家庭资产、本月生活收支、理财表现与待办，一屏掌握。",
      accounts: "按家庭和个人分组，查看账户归属与余额。",
      transactions: "每一笔变动，都有迹可循。",
      imports: "从一份账单，整理你的日常。",
      catalog: "用分类和标签，建立自己的记账习惯。",
      reports: "分析家庭开支、收支与理财，查看资产负债分布。",
      data: "备份与检查你的本地账本。",
      settings: "管理账户配置和 AI 分类参考。",
      "analysis-settings": "统一管理报表默认值、屏蔽名单与关注账户。",
    };
    const titles: Row = {
      account: "账户信息",
      category: "分类信息",
      tag: this.state.editing ? "编辑标签" : "新建标签",
      transaction: this.state.editing ? "修改交易" : "记一笔",
      opening: "设置期初余额",
      reconcile: "账户对账",
      valuation: "更新证券余额",
      decision: "确认账单记录",
      saveReport: "保存报表",
      detail: "交易详情",
      raw: "原始账单记录",
    };
    return (
      <div className="app-shell">
        <aside>
          <div className="brand">
            <span className="brand-mark">有</span>
            <div>
              有数<small>家庭财务</small>
            </div>
          </div>
          <div className="ledger-label">我的本地账本</div>
          <SidebarNavigation
            page={this.state.page}
            reportTab={this.state.reportTab}
            pendingBillCount={this.state.pendingBillCount}
            onPending={() =>
              this.setState({
                page: "bills",
                billFilters: BillAttention.filters(),
              })
            }
            onNavigate={(page, reportTab) =>
              this.setState(
                {
                  page,
                  reportTab: reportTab || this.state.reportTab,
                  billFilters: ReportPeriodFilter.defaults(),
                },
                () => {
                  if (
                    page === "imports" &&
                    !this.state.batch &&
                    this.state.batches[0]
                  )
                    this.loadBatch(this.state.batches[0].id);
                },
              )
            }
          />
          <div className="sidebar-foot">
            <span className="status-dot" /> 本地存储 · 人民币
            <small>数据留在你的电脑</small>
          </div>
        </aside>
        <main data-page={this.state.page}>
          <WorkspaceHeader
            title={
              Navigation.target(this.state.page, this.state.reportTab).label
            }
            section={
              Navigation.sections.find(
                (section) =>
                  section.key ===
                  Navigation.parent(
                    Navigation.target(this.state.page, this.state.reportTab)
                      .key,
                  ),
              )?.label
            }
            description={
              ["reports", "accounts"].includes(this.state.page)
                ? undefined
                : subtitles[this.state.page]
            }
            actions={
              <Space size={12}>
                <span className="today">
                  {dayjs().format("YYYY 年 M 月 D 日")}
                </span>
                <Button
                  type={this.state.page === "accounts" ? "default" : "primary"}
                  icon={<PlusOutlined />}
                  onClick={() => this.open("transaction")}
                >
                  记一笔
                </Button>
              </Space>
            }
          />
          <WorkspaceContent
            route={Navigation.target(this.state.page, this.state.reportTab).key}
          >
            {this.state.loading ? (
              <Card loading />
            ) : this.state.page === "bills" ? (
              <BillWorkspace
                mode="list"
                initialFilters={this.state.billFilters}
                onChanged={() => this.refresh()}
                refreshKey={JSON.stringify([
                  this.state.batches.map((b) => [b.id, b.counts]),
                  this.state.transactions.map((t) => [t.id, t.status]),
                ])}
              />
            ) : this.state.page === "overview" ? (
              this.renderOverview()
            ) : this.state.page === "accounts" ? (
              this.renderAccounts()
            ) : this.state.page === "transactions" ? (
              this.renderTransactions()
            ) : this.state.page === "imports" ? (
              this.renderImports()
            ) : this.state.page === "catalog" ? (
              this.renderCatalog()
            ) : this.state.page === "reports" ? (
              this.renderReports()
            ) : this.state.page === "analysis-settings" ? (
              <AnalysisSettings
                accounts={this.state.accounts}
                onChanged={() => this.refresh()}
                onSingleAccounts={() =>
                  this.setState({
                    page: "reports",
                    reportTab: "single-accounts",
                  })
                }
              />
            ) : this.state.page === "data" ? (
              this.renderData()
            ) : (
              this.renderSettings()
            )}
          </WorkspaceContent>
          <footer>
            有数 · 每一笔，都算数 <span>本地账本 v0.18</span>
          </footer>
        </main>
        <Modal
          open={!!this.state.modal}
          title={titles[this.state.modal || ""]}
          onCancel={() => this.setState({ modal: undefined })}
          footer={null}
          width={680}
          destroyOnHidden
        >
          {this.state.modal && this.renderForm()}
        </Modal>
      </div>
    );
  }
}
Appearance.apply(
  Appearance.resolve(
    Appearance.read(),
    window.matchMedia("(prefers-color-scheme: dark)").matches,
  ),
);
createRoot(document.getElementById("root")!).render(
  <AppearanceProvider>
    <LedgerApp />
  </AppearanceProvider>,
);
