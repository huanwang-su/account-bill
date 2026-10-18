import React from "react";
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Descriptions,
  Input,
  Modal,
  Space,
  Table,
  Tag,
  Upload,
  message,
} from "antd";
import {
  CloudUploadOutlined,
  DownloadOutlined,
  SafetyCertificateOutlined,
} from "@ant-design/icons";
import { LedgerApi, type Row } from "./api";
import { BackupDownloadDialog } from "./BackupDownloadDialog";

type Phase = "idle" | "validating" | "ready" | "restoring" | "done";
type BackupState = {
  phase: Phase;
  preview?: Row;
  result?: Row;
  confirmed: boolean;
  error?: string;
  downloadPath?: string;
  uploadFile?: File;
  uploadPassword: string;
};

/** A selected file is only staged; replacing data requires a reviewed confirmation. */
export class DataBackupPanel extends React.Component<
  { onRestored: () => Promise<void> },
  BackupState
> {
  api = new LedgerApi();
  version = 0;
  state: BackupState = { phase: "idle", confirmed: false, uploadPassword: "" };
  componentWillUnmount() {
    this.version++;
    if (this.state.preview && this.state.phase !== "restoring")
      this.discard(this.state.preview.token);
  }
  async discard(token: string) {
    await this.api
      .request(`/data-backup/validation/${token}`, "DELETE")
      .catch(() => {});
  }
  async selectBackup(file: File) {
    if (["validating", "restoring"].includes(this.state.phase)) return false;
    if (file.size > 64 * 1024 * 1024) return this.validate(file);
    const version = ++this.version;
    if (this.state.preview) this.discard(this.state.preview.token);
    this.setState({
      phase: "idle",
      preview: undefined,
      result: undefined,
      confirmed: false,
      uploadFile: undefined,
      uploadPassword: "",
      error: undefined,
    });
    try {
      const header = new Uint8Array(await file.slice(0, 14).arrayBuffer());
      const prefix = new TextDecoder().decode(header);
      const encryptedZip =
        header[0] === 0x50 &&
        header[1] === 0x4b &&
        header[2] === 3 &&
        header[3] === 4 &&
        (header[6] & 1) !== 0;
      if (version !== this.version) return false;
      if (
        file.name.toLowerCase().endsWith(".enc") ||
        encryptedZip ||
        prefix.startsWith("YOUSHU-BACKUP\0")
      ) {
        this.setState({
          uploadFile: file,
          uploadPassword: "",
          error: undefined,
        });
      } else await this.validate(file);
    } catch {
      if (version === this.version)
        this.setState({ error: "无法读取备份文件，请重新选择" });
    }
    return false;
  }
  async validate(file: File, password = "") {
    if (["validating", "restoring"].includes(this.state.phase)) return false;
    const version = ++this.version;
    if (this.state.preview) this.discard(this.state.preview.token);
    this.setState({
      phase: "validating",
      preview: undefined,
      result: undefined,
      confirmed: false,
      error: undefined,
    });
    try {
      if (file.size > 64 * 1024 * 1024)
        throw new Error("备份文件不能超过 64 MB");
      const body = new FormData();
      body.append("file", file);
      if (password) body.append("password", password);
      const preview = await this.api.request(
        "/data-backup/validate",
        "POST",
        body,
      );
      if (version !== this.version) {
        this.discard(preview.token);
        return false;
      }
      this.setState({
        phase: "ready",
        preview,
        uploadFile: undefined,
        uploadPassword: "",
      });
    } catch (error) {
      if (version === this.version)
        this.setState({
          phase: "idle",
          uploadPassword: "",
          error: error instanceof Error ? error.message : "备份校验失败",
        });
    }
    return false;
  }
  cancel() {
    if (["validating", "restoring"].includes(this.state.phase)) return;
    this.version++;
    if (this.state.preview) this.discard(this.state.preview.token);
    this.setState({
      phase: "idle",
      preview: undefined,
      result: undefined,
      confirmed: false,
      error: undefined,
    });
  }
  async restore() {
    const { phase, preview, confirmed } = this.state;
    if (phase !== "ready" || !preview || !confirmed) return;
    const version = this.version;
    this.setState({ phase: "restoring", error: undefined });
    try {
      const result = await this.api.request("/data-backup/restore", "POST", {
        token: preview.token,
        confirmation: "OVERWRITE_LEDGER",
      });
      if (version === this.version)
        this.setState({
          phase: "done",
          preview: undefined,
          result,
          confirmed: false,
        });
    } catch (error) {
      if (version === this.version)
        this.setState({
          phase: "ready",
          confirmed: false,
          error:
            error instanceof Error ? error.message : "恢复失败，请重新上传校验",
        });
      return;
    }
    try {
      await this.props.onRestored();
      message.success("账本数据已恢复，页面数据已更新");
    } catch {
      message.warning("账本已恢复，请刷新页面加载最新数据");
    }
  }
  renderPreview(preview: Row) {
    const restoring = this.state.phase === "restoring";
    const rows = [
      ["accounts", "账户"],
      ["account_groups", "账户组"],
      ["categories", "分类"],
      ["tags", "标签"],
      ["bills", "账单 / 交易明细"],
      ["transactions", "记账交易"],
      ["entries", "账户流水"],
      ["account_valuations", "证券估值"],
      ["import_batches", "导入批次"],
    ].map(([key, name]) => ({
      key,
      name,
      current: preview.current[key],
      incoming: preview.incoming[key],
    }));
    return (
      <div className="data-restore-preview">
        <Space className="mb">
          <Tag color="green" icon={<SafetyCertificateOutlined />}>
            校验通过
          </Tag>
          <strong>{preview.filename}</strong>
        </Space>
        <Descriptions size="small" column={1}>
          <Descriptions.Item label="密码保护">
            {preview.encrypted ? "已解密并通过备份校验" : "未加密备份"}
          </Descriptions.Item>
          <Descriptions.Item label="备份时间">
            {preview.created_at}
          </Descriptions.Item>
          <Descriptions.Item label="通过的检查">
            {preview.checks.join("、")}
          </Descriptions.Item>
        </Descriptions>
        <Table
          size="small"
          rowKey="key"
          pagination={false}
          dataSource={rows}
          columns={[
            { title: "数据类型", dataIndex: "name" },
            { title: "当前账本", dataIndex: "current", align: "right" },
            { title: "恢复后", dataIndex: "incoming", align: "right" },
          ]}
        />
        <Alert
          className="mt mb"
          type="warning"
          showIcon
          message="恢复将覆盖整个工程的全部账本数据和业务设置"
          description="当前账户、账单、交易、流水、关联历史和业务配置会全部替换为此备份，不会与现有数据合并。恢复前自动保存当前账本；程序代码不属于恢复范围。"
        />
        {preview.unfinished_imports > 0 && (
          <Alert
            className="mb"
            type="info"
            showIcon
            message={`${preview.unfinished_imports} 个未完成导入批次未携带历史文件，恢复后需重新上传原账单继续处理。`}
          />
        )}
        <Checkbox
          disabled={restoring}
          checked={this.state.confirmed}
          onChange={(event) =>
            this.setState({ confirmed: event.target.checked })
          }
        >
          我确认覆盖当前工程的全部账本数据和业务设置
        </Checkbox>
        <Space className="mt">
          <Button
            type="primary"
            danger
            disabled={!this.state.confirmed || restoring}
            loading={restoring}
            onClick={() => this.restore()}
          >
            确认覆盖并恢复
          </Button>
          <Button disabled={restoring} onClick={() => this.cancel()}>
            取消恢复
          </Button>
        </Space>
      </div>
    );
  }
  render() {
    const { phase, preview, result, error } = this.state;
    const busy = phase === "validating" || phase === "restoring";
    return (
      <Card className="data-backup-panel" title="数据备份与恢复">
        <p>
          备份基础资料、账单、交易、账户流水、证券估值、关联历史和业务设置。程序代码由
          Git 管理。
        </p>
        <div className="data-backup-actions">
          <Button
            type="primary"
            icon={<DownloadOutlined />}
            onClick={() => this.setState({ downloadPath: "/data-backup" })}
            disabled={busy}
          >
            下载账本备份
          </Button>
          <Upload
            accept=".ledger.zip,.zip,.ledger.enc,.enc"
            showUploadList={false}
            disabled={busy}
            beforeUpload={(file) => this.selectBackup(file)}
          >
            <Button
              icon={<CloudUploadOutlined />}
              loading={phase === "validating"}
              disabled={busy}
            >
              上传备份并校验
            </Button>
          </Upload>
        </div>
        <p className="muted small">
          下载文件为 .ledger.zip，可设置 ZIP
          解压密码。不包含原始、统一或分类后账单的文件内容。恢复后历史记录仍可查询，历史文件不可下载；未完成的导入需重新上传。主题外观保存在当前浏览器中。
        </p>
        {!preview && !result && (
          <Alert
            className="mt"
            type="warning"
            showIcon
            message="上传恢复会覆盖当前工程的全部账本数据和业务设置"
            description="选择文件只会执行校验。请核对数据数量，确认覆盖后才会恢复。"
          />
        )}
        {error && !this.state.uploadFile && (
          <Alert
            className="mt"
            type="error"
            showIcon
            message="操作未完成"
            description={error}
          />
        )}
        {preview && this.renderPreview(preview)}
        {result && (
          <Alert
            className="mt"
            type="success"
            showIcon
            message="账本已恢复，当前页面数据已更新"
            description={
              <Space wrap>
                <span>恢复前的账本已自动备份。</span>
                <Button
                  onClick={() =>
                    this.setState({
                      downloadPath: result.rollback_download_url.replace(
                        /^\/api/,
                        "",
                      ),
                    })
                  }
                  icon={<DownloadOutlined />}
                >
                  下载恢复前备份
                </Button>
              </Space>
            }
          />
        )}
        {this.state.downloadPath && (
          <BackupDownloadDialog
            path={this.state.downloadPath}
            onClose={() => this.setState({ downloadPath: undefined })}
          />
        )}
        <Modal
          open={!!this.state.uploadFile}
          title="输入备份密码"
          okText="解密并校验"
          cancelText="取消"
          confirmLoading={phase === "validating"}
          closable={!busy}
          maskClosable={!busy}
          cancelButtonProps={{ disabled: busy }}
          onCancel={() => {
            if (!busy)
              this.setState({
                uploadFile: undefined,
                uploadPassword: "",
                error: undefined,
              });
          }}
          onOk={() => {
            if (this.state.uploadFile)
              this.validate(this.state.uploadFile, this.state.uploadPassword);
          }}
        >
          <p>{this.state.uploadFile?.name}</p>
          <p className="muted">
            输入下载此备份时设置的密码。解密校验不会修改当前账本。
          </p>
          <Input.Password
            aria-label="恢复密码"
            autoComplete="off"
            maxLength={256}
            disabled={busy}
            value={this.state.uploadPassword}
            onChange={(event) =>
              this.setState({
                uploadPassword: event.target.value,
                error: undefined,
              })
            }
            onPressEnter={() => {
              if (this.state.uploadFile)
                this.validate(this.state.uploadFile, this.state.uploadPassword);
            }}
          />
          {error && (
            <Alert className="mt" type="error" showIcon message={error} />
          )}
        </Modal>
      </Card>
    );
  }
}
