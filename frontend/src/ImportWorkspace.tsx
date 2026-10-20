import React from "react";
import { AmountPrivacy } from "./AmountPrivacy";
import {
  Alert,
  Button,
  Card,
  Descriptions,
  Empty,
  Modal,
  Popconfirm,
  Select,
  Space,
  Steps,
  Table,
  Tag,
  Upload,
  message,
} from "antd";
import {
  CloudUploadOutlined,
  DownloadOutlined,
  FileDoneOutlined,
} from "@ant-design/icons";
import { PagedTable } from "./PagedTable";
import { LedgerApi, DisplayMoneyFormatter as Money, Row } from "./api";

const statuses: Row = {
  NORMALIZED: ["待分类", "blue"],
  CLASSIFIED: ["待导入明细", "gold"],
  IMPORTED: ["已导入明细", "green"],
  ERROR: ["转换失败", "red"],
  CANCELLED: ["已撤销", "red"],
};
const stages: Row = {
  ORIGINAL: "原始导入文件",
  ORIGINAL_ARCHIVE: "原始压缩包",
  ACCOUNT_MAPPING: "账户归属确认",
  SOURCE_OBSERVATIONS: "来源补充说明",
  NORMALIZED: "统一账单文件",
  CLASSIFIED: "AI 分类后账单",
  CLASSIFICATION_UPDATE: "AI 复核后账单",
  REFUND_CANDIDATES: "退款金额候选",
  REFUND_MATCHES: "AI 退款匹配结果",
  REFUND_NETTING: "退款净额计算",
  PROCESSING_RESULTS: "按用户规则处理结果",
  ASSOCIATION_RESULTS: "跨来源凭证关联结果",
  REFUND_PROCESSED: "退款处理后账单",
};
interface Props {
  onChanged: () => Promise<void>;
  refreshKey?: string;
}
interface State {
  runs: Row[];
  selected?: number;
  detail?: Row;
  busy: boolean;
  preview?: { name: string; text: string };
  billFilter?: string;
}

/** Batch audit UI; file storage and bill publication are independent explicit steps. */
export class ImportWorkspace extends React.Component<Props, State> {
  api = new LedgerApi();
  state: State = { runs: [], busy: false };
  componentDidMount() {
    this.load();
  }
  componentDidUpdate(previous: Props) {
    if (previous.refreshKey !== this.props.refreshKey) this.load();
  }
  fail(e: unknown) {
    message.error(e instanceof Error ? e.message : "操作失败");
  }
  async load(selected = this.state.selected) {
    try {
      const runs = await this.api.request("/import-runs");
      const id = selected ?? runs[0]?.id;
      const detail = id
        ? await this.api.request(`/import-runs/${id}`)
        : undefined;
      this.setState({ runs, selected: id, detail });
    } catch (e) {
      this.fail(e);
    }
  }
  async upload(
    file: File,
    stage: "ORIGINAL" | "CLASSIFIED" | "RECOVER" | "REFUND",
  ) {
    this.setState({ busy: true });
    try {
      const form = new FormData();
      form.append("file", file);
      const url =
        stage === "ORIGINAL"
          ? "/imports"
          : `/import-runs/${this.state.selected}/${stage === "RECOVER" ? "original" : stage === "REFUND" ? "refund-matches" : "classifications"}`;
      const result = await this.api.request(url, "POST", form);
      await this.load(result.run_id);
      await this.props.onChanged();
      if (result.error) message.warning("原文件已保存，转换问题见批次详情");
      else
        message.success(
          stage === "ORIGINAL"
            ? "原文件与统一账单已保存，请继续分类"
            : stage === "RECOVER"
              ? "原文件已校验并补存"
              : stage === "REFUND"
                ? `退款匹配已保存：新增 ${result.matched_pairs} 对，已匹配 ${result.already_matched_pairs} 对`
                : "分类文件已保存，可导入并入账",
        );
    } catch (e) {
      this.fail(e);
    } finally {
      this.setState({ busy: false });
    }
    return false;
  }
  async commit() {
    this.setState({ busy: true });
    try {
      const r = await this.api.request(
        `/import-runs/${this.state.selected}/commit`,
        "POST",
      );
      message.success(
        r.already_imported
          ? "该批次已导入，无需重复操作"
          : `新增明细 ${r.created} 条，入账 ${r.posted} 条，待核对 ${r.pending} 条，忽略账单 ${r.ignored_bills || 0} 条`,
      );
      await this.load();
      await this.props.onChanged();
    } catch (e) {
      this.fail(e);
      await this.load();
    } finally {
      this.setState({ busy: false });
    }
  }
  async cancel() {
    this.setState({ busy: true });
    try {
      await this.api.request(
        `/import-runs/${this.state.selected}/cancel`,
        "POST",
      );
      await this.load();
      await this.props.onChanged();
      message.success("批次已撤销，所属交易的余额变动已冲回");
    } catch (e) {
      this.fail(e);
    } finally {
      this.setState({ busy: false });
    }
  }
  async preview(artifact: Row) {
    try {
      const response = await fetch(`/api/import-artifacts/${artifact.id}`);
      if (!response.ok) throw Error("无法读取文件");
      const bytes = await response.arrayBuffer();
      let text: string;
      if (/\.(xlsx|pdf)$/i.test(artifact.filename))
        text =
          "这是 Excel 或 PDF 原始文件，请下载查看。转换后的记录见批次预览。";
      else {
        try {
          text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        } catch {
          text = new TextDecoder("gb18030").decode(bytes);
        }
      }
      this.setState({
        preview: {
          name: artifact.filename,
          text:
            text.length > 200000
              ? text.slice(0, 200000) + "\n…预览已截断，请下载完整文件。"
              : text,
        },
      });
    } catch (e) {
      this.fail(e);
    }
  }
  render() {
    const { runs, detail, busy, preview } = this.state;
    const artifacts: Row[] = detail?.artifacts || [];
    const normalized =
      [...artifacts]
        .reverse()
        .find((a) => a.stage === "CLASSIFICATION_UPDATE") ||
      [...artifacts].reverse().find((a) => a.stage === "REFUND_PROCESSED") ||
      artifacts.find((a) => a.stage === "NORMALIZED");
    const original = artifacts.find((a) => a.stage === "ORIGINAL");
    const editable =
      detail &&
      !detail.files_omitted &&
      ["NORMALIZED", "CLASSIFIED"].includes(detail.status);
    const duplicateCount = (detail?.rows || []).filter(
      (r: Row) => r.duplicate,
    ).length;
    const conflictCount = (detail?.rows || []).filter(
      (r: Row) => r.conflict,
    ).length;
    return (
      <div className="import-workspace">
        <div className="import-layout">
          <Card title="1. 上传原始账单">
            <Upload.Dragger
              accept=".csv,.xlsx,.pdf"
              showUploadList={false}
              disabled={busy}
              beforeUpload={(f) => this.upload(f, "ORIGINAL")}
            >
              <p className="upload-icon">
                <CloudUploadOutlined />
              </p>
              <p>导入账单 CSV / Excel / PDF</p>
              <p className="muted">
                支持支付宝、微信、小荷包、招商银行、中国银行；自动识别来源
              </p>
            </Upload.Dragger>
          </Card>
          <Card title="2. 分类后导入明细">
            <p>
              下载本批次统一账单，在 Codex
              中分类打标，保存处理后的文件，再导入并入账。
            </p>
            <p className="muted">
              支付宝“不计收支”默认忽略，不转交易明细。其余正常交易自动入账，特殊记录保留待核对。
            </p>
            <Space wrap>
              <Button
                disabled={!normalized || normalized.available === false || busy}
                href={
                  normalized && normalized.available !== false
                    ? `/api/import-artifacts/${normalized.id}`
                    : undefined
                }
                icon={<DownloadOutlined />}
              >
                下载统一账单
              </Button>
              <Upload
                accept=".json"
                className="classification-upload"
                showUploadList={false}
                disabled={!editable || busy}
                beforeUpload={(f) => this.upload(f, "CLASSIFIED")}
              >
                <Button
                  disabled={!editable || busy}
                  icon={<FileDoneOutlined />}
                >
                  保存 AI 分类文件
                </Button>
              </Upload>
              <Button
                type="primary"
                loading={busy}
                disabled={
                  !!detail?.files_omitted ||
                  (detail?.status !== "CLASSIFIED" &&
                    !(
                      detail?.status === "NORMALIZED" &&
                      detail?.active_bill_count === 0
                    ))
                }
                onClick={() => this.commit()}
              >
                导入并入账
              </Button>
              {detail && detail.status !== "CANCELLED" && (
                <Popconfirm
                  title="撤销这个账单批次？"
                  description={`将撤销本批次负责的 ${detail.owned_count || 0} 条明细并冲回资金。重复记录不受影响，文件保留。`}
                  onConfirm={() => this.cancel()}
                >
                  <Button danger disabled={busy}>
                    撤销账单
                  </Button>
                </Popconfirm>
              )}
            </Space>
          </Card>
        </div>
        <Card
          className="mt"
          title={`导入批次 · ${runs.length} 次`}
          extra={
            <Button onClick={() => this.load()} disabled={busy}>
              刷新记录
            </Button>
          }
        >
          <Select
            aria-label="导入批次"
            style={{ width: "100%", marginBottom: 20 }}
            placeholder="上传后在这里查看批次"
            value={this.state.selected}
            disabled={busy}
            options={runs.map((r) => ({
              value: r.id,
              label: `#${r.id} · ${r.filename} · ${r.created_at} · ${statuses[r.status][0]}`,
            }))}
            onChange={(id) => this.load(id)}
          />
          {!detail ? (
            <Empty description="还没有导入记录" />
          ) : (
            <>
              {detail.files_omitted && (
                <Alert
                  className="mb"
                  type="info"
                  showIcon
                  message="此账本从不含历史文件的备份恢复"
                  description="账单、流水与关联历史仍保留；历史文件不可下载。未完成的导入请重新上传原账单。"
                />
              )}
              <Steps
                size="small"
                className="mb"
                current={
                  {
                    IMPORTED: 4,
                    CLASSIFIED: 3,
                    NORMALIZED: 2,
                    ERROR: 1,
                    CANCELLED: 0,
                  }[detail.status as string]
                }
                status={detail.status === "ERROR" ? "error" : undefined}
                items={[
                  { title: "原文件存档" },
                  { title: "统一账单" },
                  { title: "分类文件" },
                  { title: "交易明细" },
                ]}
              />
              <Descriptions
                column={{ xs: 1, sm: 2, lg: 3 }}
                size="small"
                className="mb"
              >
                <Descriptions.Item label="账单来源">
                  {detail.summary?.provider_label || "支付宝"}
                </Descriptions.Item>
                <Descriptions.Item label="导入阶段">
                  <Tag color={statuses[detail.status][1]}>
                    {statuses[detail.status][0]}
                  </Tag>
                </Descriptions.Item>
                <Descriptions.Item label="原记录 / 统一记录">
                  {detail.summary.source_count ?? "—"} /{" "}
                  {detail.summary.normalized_count ?? "—"} 条
                </Descriptions.Item>
                <Descriptions.Item label="文件内重复">
                  {detail.summary.repeated_in_file ?? 0} 条
                </Descriptions.Item>
                <Descriptions.Item label="创建时间">
                  {detail.created_at}
                </Descriptions.Item>
                <Descriptions.Item label="历史导入结果">
                  {detail.status === "CANCELLED"
                    ? `已撤销 ${detail.result.cancellation?.reversed_details || 0} 条明细`
                    : detail.status === "IMPORTED"
                      ? detail.result.legacy
                        ? "历史已导入记录"
                        : `新增 ${detail.result.created} 条，跳过 ${detail.result.duplicates} 条；入账 ${detail.result.posted || 0} 条，待核对 ${detail.result.pending || 0} 条`
                      : `与已有明细重复 ${duplicateCount} 条，冲突 ${conflictCount} 条`}
                </Descriptions.Item>
                <Descriptions.Item label="明细导入时间">
                  {detail.committed_at || "—"}
                </Descriptions.Item>
              </Descriptions>
              <Alert
                className="mb"
                type="info"
                showIcon
                message={`账单状态：正常 ${detail.active_bill_count} 条 · 忽略 ${detail.ignored_bill_count} 条${detail.linked_bill_count ? " · 已关联交易 " + detail.linked_bill_count + " 条" : ""}。忽略记录仅保留在账单中，不转入交易明细。${detail.linked_bill_count ? "已关联记录作为主交易凭证，不重复入账。" : ""}`}
              />
              {detail.error && (
                <Alert
                  className="mb"
                  type="error"
                  showIcon
                  message={detail.error}
                />
              )}
              {(detail.summary.warnings || []).map((w: string, i: number) => (
                <Alert
                  key={i}
                  className="mb"
                  type="warning"
                  showIcon
                  message={w}
                />
              ))}
              {!!detail.summary.missing_transaction_ids && (
                <Alert
                  className="mb"
                  type="warning"
                  message={`${detail.summary.missing_transaction_ids} 条缺少流水号，只能保证同一原文件重复上传幂等，请人工核对跨文件重复。`}
                />
              )}
              {!original && detail.summary.legacy && (
                <Upload
                  accept=".csv,.xlsx,.pdf"
                  showUploadList={false}
                  disabled={busy}
                  beforeUpload={(f) => this.upload(f, "RECOVER")}
                >
                  <Button className="mb">补存历史原文件</Button>
                </Upload>
              )}
              <Table
                rowKey="id"
                size="small"
                pagination={false}
                scroll={{ x: 860 }}
                dataSource={artifacts}
                columns={[
                  {
                    title: "文件阶段",
                    dataIndex: "stage",
                    width: 160,
                    render: (s: string) => stages[s],
                  },
                  {
                    title: "保存的文件",
                    dataIndex: "filename",
                    render: (name: string, a: Row) => (
                      <>
                        <div>{name}</div>
                        <small className="muted">
                          {a.available === false
                            ? "文件未包含在备份中"
                            : `${(a.size / 1024).toFixed(1)} KB`}{" "}
                          · {a.created_at}
                        </small>
                      </>
                    ),
                  },
                  {
                    title: "校验值 SHA-256",
                    dataIndex: "digest",
                    width: 180,
                    render: (d: string) => (
                      <span title={d} style={{ fontFamily: "monospace" }}>
                        {d.slice(0, 16)}…
                      </span>
                    ),
                  },
                  {
                    title: "操作",
                    width: 160,
                    render: (_: unknown, a: Row) => (
                      <Space>
                        <Button
                          type="link"
                          disabled={a.available === false}
                          onClick={() => this.preview(a)}
                        >
                          查看文件
                        </Button>
                        <Button
                          type="link"
                          disabled={a.available === false}
                          href={
                            a.available === false
                              ? undefined
                              : `/api/import-artifacts/${a.id}`
                          }
                        >
                          下载
                        </Button>
                      </Space>
                    ),
                  },
                ]}
              />
              <p className="muted small">
                可用文件按原内容保存，可查看或下载。数据管理下载的账本备份保留记录及文件信息，不包含文件内容。再次保存分类文件会保留新版本。
              </p>
              <Card title="退款匹配" className="mt mb">
                <p>
                  批量筛选本文件里金额不小于退款的付款候选，交给 Codex
                  匹配，再保存匹配结果。全额退款双方忽略；部分退款按付款减累计退款记一笔净支出，并忽略退款。只有证据明确的关联才会处理。
                </p>
                <Space wrap>
                  <Button
                    href={`/api/import-runs/${detail.id}/refund-candidates`}
                    disabled={
                      !!detail.files_omitted ||
                      ["ERROR", "CANCELLED"].includes(detail.status)
                    }
                  >
                    下载退款候选
                  </Button>
                  <Upload
                    accept=".json"
                    className="refund-match-upload"
                    showUploadList={false}
                    disabled={
                      busy ||
                      !!detail.files_omitted ||
                      ["ERROR", "CANCELLED"].includes(detail.status)
                    }
                    beforeUpload={(f) => this.upload(f, "REFUND")}
                  >
                    <Button
                      loading={busy}
                      disabled={
                        !!detail.files_omitted ||
                        ["ERROR", "CANCELLED"].includes(detail.status)
                      }
                    >
                      保存 AI 退款匹配
                    </Button>
                  </Upload>
                  <Tag>退款 {detail.refund_matches?.length || 0} 条</Tag>
                  <Tag>
                    已匹配 {detail.matched_refund_pairs?.length || 0} 对
                  </Tag>
                </Space>
                {(detail.matched_refund_pairs || []).length > 0 && (
                  <PagedTable
                    className="mt"
                    size="small"
                    rowKey="refund_id"
                    scroll={{ x: 700 }}
                    defaultPageSize={5}
                    pageResetKey={String(detail.id)}
                    dataSource={detail.matched_refund_pairs}
                    columns={[
                      {
                        title: "退款统一编号",
                        dataIndex: "refund_id",
                        render: (v: string) => (
                          <span style={{ overflowWrap: "anywhere" }}>{v}</span>
                        ),
                      },
                      {
                        title: "付款统一编号",
                        dataIndex: "payment_id",
                        render: (v: string) => (
                          <span style={{ overflowWrap: "anywhere" }}>{v}</span>
                        ),
                      },
                      { title: "匹配依据", dataIndex: "note" },
                    ]}
                  />
                )}
              </Card>
              <Select
                className="mt mb"
                aria-label="账单状态筛选"
                style={{ width: 200 }}
                value={this.state.billFilter || "ALL"}
                onChange={(billFilter) => this.setState({ billFilter })}
                options={[
                  { value: "ALL", label: "全部账单状态" },
                  { value: "NORMAL", label: "正常" },
                  { value: "IGNORED", label: "忽略" },
                  { value: "LINKED", label: "已关联交易" },
                ]}
              />
              <PagedTable
                className="mt"
                rowKey="id"
                size="small"
                dataSource={detail.rows.filter(
                  (r: Row) =>
                    !this.state.billFilter ||
                    this.state.billFilter === "ALL" ||
                    r.bill_status === this.state.billFilter,
                )}
                scroll={{ x: 1100 }}
                defaultPageSize={10}
                pageResetKey={JSON.stringify([
                  detail.id,
                  this.state.billFilter,
                ])}
                columns={[
                  {
                    title: "账单状态",
                    width: 110,
                    render: (_: unknown, r: Row) => (
                      <Tag
                        color={r.bill_status === "IGNORED" ? "default" : "blue"}
                        title={r.bill_status_reason}
                      >
                        {r.bill_status === "LINKED"
                          ? "已关联交易"
                          : r.bill_status === "IGNORED"
                            ? "忽略"
                            : "正常"}
                      </Tag>
                    ),
                  },
                  {
                    title: "交易流水号",
                    dataIndex: "source_transaction_id",
                    width: 245,
                    render: (v: string) => (
                      <span style={{ overflowWrap: "anywhere" }}>
                        {v || "原账单未提供"}
                      </span>
                    ),
                  },
                  {
                    title: "时间 / 交易对方",
                    width: 220,
                    render: (_: unknown, r: Row) => (
                      <>
                        <div>
                          {r.facts.counterparty ||
                            r.facts.description ||
                            "未提供交易对方"}
                        </div>
                        <small className="muted">{r.facts.occurred_at}</small>
                      </>
                    ),
                  },
                  {
                    title: "金额",
                    width: 100,
                    render: (_: unknown, r: Row) =>
                      `¥ ${Money.format(r.facts.amount_minor)}${r.refund_amount_minor ? " → 净支出 ¥ " + Money.format(r.effective_amount_minor) : ""}`,
                  },
                  {
                    title: "分类 / 标签",
                    width: 270,
                    render: (_: unknown, r: Row) => (
                      <>
                        <div>
                          {r.classification?.category_path.join(" / ") ||
                            (r.bill_status !== "NORMAL"
                              ? "无需重复分类"
                              : "待分类")}
                        </div>
                        {r.classification?.tags.map((t: string) => (
                          <Tag key={t}>{t}</Tag>
                        ))}
                        {r.classification?.status === "NEEDS_REVIEW" && (
                          <Tag color="orange">需复核</Tag>
                        )}
                      </>
                    ),
                  },
                  {
                    title: "明细核对",
                    width: 130,
                    render: (_: unknown, r: Row) => (
                      <Tag
                        color={
                          r.conflict ? "red" : r.duplicate ? "default" : "blue"
                        }
                      >
                        {r.bill_status === "LINKED"
                          ? "关联到已有明细"
                          : r.bill_status === "IGNORED"
                            ? "不转明细"
                            : r.ledger_status === "REVERSED"
                              ? "已撤销"
                              : r.conflict
                                ? "同号内容冲突"
                                : r.duplicate
                                  ? "明细已存在"
                                  : "待导入"}
                      </Tag>
                    ),
                  },
                ]}
              />
            </>
          )}
        </Card>
        <Modal
          title={preview?.name}
          open={!!preview}
          width={1000}
          footer={null}
          onCancel={() => this.setState({ preview: undefined })}
        >
          <pre
            style={{
              whiteSpace: "pre-wrap",
              overflowWrap: "anywhere",
              maxHeight: "65vh",
              overflow: "auto",
              fontSize: 12,
            }}
          >
            {AmountPrivacy.hidden()
              ? "金额已隐藏，显示金额后可预览账单文件。"
              : preview?.text}
          </pre>
        </Modal>
      </div>
    );
  }
}
