import React from "react";
import {
  Alert,
  Button,
  Card,
  Input,
  Switch,
  Space,
  message,
  Popconfirm,
} from "antd";
import { LedgerApi, Row } from "./api";

export class ClassificationSettings extends React.Component<
  { onChanged: () => void },
  { policy?: Row; busy: boolean }
> {
  state: { policy?: Row; busy: boolean } = { busy: false };
  api = new LedgerApi();
  componentDidMount() {
    this.load();
  }
  async load() {
    try {
      this.setState({
        policy: await this.api.request("/classification-policy"),
      });
    } catch (e) {
      message.error(String(e));
    }
  }
  async save() {
    this.setState({ busy: true });
    try {
      const {
        reference,
        allow_broad_categories,
        unmatched_refund_income,
        allow_new_categories,
        revision,
      } = this.state.policy!;
      this.setState({
        policy: await this.api.request("/classification-policy", "PUT", {
          reference,
          allow_broad_categories,
          unmatched_refund_income,
          allow_new_categories,
          revision,
        }),
      });
      message.success("分类参考已保存，新导出的账单会附带这份配置");
    } catch (e) {
      message.error(String(e));
    } finally {
      this.setState({ busy: false });
    }
  }
  async process(path: string) {
    this.setState({ busy: true });
    try {
      const result = await this.api.request(path, "POST", {});
      message.success(
        result.matched !== undefined
          ? `已匹配 ${result.matched} 笔内部转账`
          : `新增入账 ${result.posted} 笔，仍待核对 ${result.pending} 笔`,
      );
      this.props.onChanged();
    } catch (e) {
      message.error(String(e));
    } finally {
      this.setState({ busy: false });
    }
  }
  render() {
    const p = this.state.policy;
    return (
      <Card title="AI 分类与复核参考" className="mb" loading={!p}>
        <Alert
          type="info"
          showIcon
          message="由 Codex 在应用外处理账单"
          description="配置随统一账单导出，也可单独下载交给 Codex。保存参考不会调用 AI 或改动已有账目；账户、金额、交易状态和重复记录的校验始终生效。"
          className="mb"
        />
        {p && (
          <>
            <Space className="mb">
              <Switch
                aria-label="允许宽泛分类入账"
                checked={p.allow_broad_categories}
                onChange={(value) =>
                  this.setState({
                    policy: { ...p, allow_broad_categories: value },
                  })
                }
              />
              <span>仅细分类需复核时，允许先入账</span>
            </Space>
            <Space className="mb" style={{ display: "flex" }}>
              <Switch
                aria-label="未匹配退款记为收入"
                checked={p.unmatched_refund_income}
                onChange={(value) =>
                  this.setState({
                    policy: { ...p, unmatched_refund_income: value },
                  })
                }
              />
              <span>未匹配退款记为退款收入，已匹配退款仍按净支出处理</span>
            </Space>
            <Space className="mb" style={{ display: "flex" }}>
              <Switch
                aria-label="允许账单新增分类"
                checked={p.allow_new_categories}
                onChange={(value) =>
                  this.setState({
                    policy: { ...p, allow_new_categories: value },
                  })
                }
              />
              <span>允许账单新增分类（默认关闭，分类最多两级）</span>
            </Space>
            <label
              htmlFor="classification-reference"
              style={{ display: "block", marginBottom: 8 }}
            >
              分类和需复核说明
            </label>
            <Input.TextArea
              id="classification-reference"
              value={p.reference}
              maxLength={20000}
              autoSize={{ minRows: 12, maxRows: 24 }}
              onChange={(e) =>
                this.setState({ policy: { ...p, reference: e.target.value } })
              }
            />
            <Space wrap className="mt">
              <Button
                type="primary"
                loading={this.state.busy}
                onClick={() => this.save()}
              >
                保存分类参考
              </Button>
              <Button href="/api/classification-policy/reference">
                下载 AI 分类参考
              </Button>
              <Popconfirm
                title="按已保存配置重新检查待核对交易？"
                description="符合入账条件的记录将生成账户流水。"
                onConfirm={() =>
                  this.process("/classification-policy/reprocess")
                }
              >
                <Button loading={this.state.busy}>重新检查待核对记录</Button>
              </Popconfirm>
              <Popconfirm
                title="匹配自有账户间的转账？"
                description="仅匹配完整账号互相对应、同日同额且唯一的两侧记录。"
                onConfirm={() => this.process("/internal-transfers/match")}
              >
                <Button loading={this.state.busy}>识别内部转账</Button>
              </Popconfirm>
            </Space>
          </>
        )}
      </Card>
    );
  }
}
