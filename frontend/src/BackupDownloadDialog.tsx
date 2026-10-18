import React from "react";
import { Alert, Form, Input, Modal } from "antd";
import { LedgerApi } from "./api";

export class BackupFileDownload {
  static save(blob: Blob, filename: string) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

/** Passwords stay only in this dialog and are discarded when it closes. */
export class BackupDownloadDialog extends React.Component<
  { path: string; onClose: () => void },
  { password: string; confirmation: string; busy: boolean; error?: string }
> {
  api = new LedgerApi();
  active = true;
  state = {
    password: "",
    confirmation: "",
    busy: false,
    error: undefined as string | undefined,
  };
  componentWillUnmount() {
    this.active = false;
  }
  async download() {
    const { password, confirmation, busy } = this.state;
    if (busy) return;
    if (password !== confirmation) {
      this.setState({ error: "两次输入的密码不一致" });
      return;
    }
    this.setState({ busy: true, error: undefined });
    try {
      const { blob, filename } = await this.api.download(this.props.path, {
        password,
      });
      if (!this.active) return;
      BackupFileDownload.save(blob, filename);
      this.setState({ password: "", confirmation: "", busy: false });
      this.props.onClose();
    } catch (error) {
      if (this.active)
        this.setState({
          busy: false,
          password: "",
          confirmation: "",
          error:
            error instanceof Error ? error.message : "备份下载失败，请重试",
        });
    }
  }
  render() {
    const { password, confirmation, busy, error } = this.state;
    return (
      <Modal
        open
        title="下载账本备份"
        okText={password ? "下载加密备份" : "下载未加密备份"}
        cancelText="取消"
        confirmLoading={busy}
        closable={!busy}
        maskClosable={!busy}
        cancelButtonProps={{ disabled: busy }}
        onCancel={() => {
          if (!busy) this.props.onClose();
        }}
        onOk={() => this.download()}
      >
        <p className="muted">
          可设置密码保护备份；留空则下载普通备份。建议使用至少 8 个字符。
        </p>
        <Form layout="vertical" disabled={busy}>
          <Form.Item label="备份密码（可选）">
            <Input.Password
              autoComplete="new-password"
              maxLength={80}
              value={password}
              placeholder="留空表示不加密"
              onChange={(event) =>
                this.setState({
                  password: event.target.value,
                  confirmation: event.target.value ? confirmation : "",
                  error: undefined,
                })
              }
            />
          </Form.Item>
          {password && (
            <Form.Item label="再次输入密码">
              <Input.Password
                autoComplete="new-password"
                maxLength={80}
                value={confirmation}
                onChange={(event) =>
                  this.setState({
                    confirmation: event.target.value,
                    error: undefined,
                  })
                }
                onPressEnter={() => this.download()}
              />
            </Form.Item>
          )}
        </Form>
        {password && (
          <Alert
            type="info"
            showIcon
            message="下载为标准 ZIP 压缩包，解压和上传恢复均需输入此密码。这里填写的密码不会保存，请自行保管。"
          />
        )}
        {error && (
          <Alert className="mt" type="error" showIcon message={error} />
        )}
      </Modal>
    );
  }
}
