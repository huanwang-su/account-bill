import React from "react";
import { AccountChoices } from "./AccountChoices";
import {
  Alert,
  Button,
  Card,
  Descriptions,
  Form,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
  message,
} from "antd";
import {
  LedgerApi,
  DisplayMoneyFormatter as Money,
  AccountGroupTree,
  Row,
} from "./api";
interface Props {
  accounts: Row[];
  groups: Row[];
  onChanged: () => Promise<void>;
}
interface State {
  source?: number;
  target?: number;
  preview?: Row;
  editing?: Row;
  groupModal: boolean;
  assignGroup?: number;
  assignAccounts: number[];
  busy: boolean;
}
/** Generic configuration; merges preserve entry identities and groups only aggregate. */
export class AccountSettings extends React.Component<Props, State> {
  api = new LedgerApi();
  state: State = { groupModal: false, assignAccounts: [], busy: false };
  fail(e: unknown) {
    message.error(e instanceof Error ? e.message : "操作失败");
  }
  async action(path: string, data: Row, method = "POST") {
    this.setState({ busy: true });
    try {
      await this.api.request(path, method, data);
      await this.props.onChanged();
      message.success("配置已保存");
      return true;
    } catch (e) {
      this.fail(e);
      return false;
    } finally {
      this.setState({ busy: false });
    }
  }
  render() {
    const { accounts, groups } = this.props;
    const options = AccountChoices.rank(accounts)
      .filter((a) => a.role !== "SYSTEM" && !a.merged_into_id && a.active)
      .map((a) => ({ value: a.id, label: a.name }));
    const tree = new AccountGroupTree(groups);
    return (
      <div className="account-settings">
        <Card title="账户合并" className="mb">
          <p>
            余额和历史流水统一到目标账户。信用卡等负债可并入资产账户，欠款抵减账户余额；资产负债表保留资产与负债明细，理财分析保留基金部分。
          </p>
          <Space wrap>
            <Select
              aria-label="合并来源账户"
              placeholder="选择来源账户"
              style={{ width: 220 }}
              value={this.state.source}
              options={options}
              onChange={(source) =>
                this.setState({ source, preview: undefined })
              }
            />
            <span>合并到</span>
            <Select
              aria-label="合并目标账户"
              placeholder="选择目标账户"
              style={{ width: 220 }}
              value={this.state.target}
              options={options.filter((a) => a.value !== this.state.source)}
              onChange={(target) =>
                this.setState({ target, preview: undefined })
              }
            />
            <Button
              disabled={!this.state.source || !this.state.target}
              onClick={async () => {
                try {
                  this.setState({
                    preview: await this.api.request(
                      "/account-merges/preview",
                      "POST",
                      {
                        source_id: this.state.source,
                        target_id: this.state.target,
                      },
                    ),
                  });
                } catch (e) {
                  this.fail(e);
                }
              }}
            >
              预览合并
            </Button>
          </Space>
          {this.state.preview && (
            <div className="mt">
              <Descriptions bordered size="small" column={3}>
                <Descriptions.Item label="来源余额">
                  ¥ {Money.format(this.state.preview.source_balance)}
                </Descriptions.Item>
                <Descriptions.Item label="目标余额">
                  ¥ {Money.format(this.state.preview.target_balance)}
                </Descriptions.Item>
                <Descriptions.Item label="合并后余额">
                  ¥ {Money.format(this.state.preview.combined_balance)}
                </Descriptions.Item>
              </Descriptions>
              <p className="muted">
                使用目标账户的所属组。原账户与历史分录保留，合并后来源账户不再单独计入资产。
              </p>
              <Popconfirm
                title={`将 ${this.state.preview.source_name} 合并到 ${this.state.preview.target_name}？`}
                onConfirm={async () => {
                  if (
                    await this.action("/account-merges", {
                      source_id: this.state.source,
                      target_id: this.state.target,
                    })
                  )
                    this.setState({
                      source: undefined,
                      target: undefined,
                      preview: undefined,
                    });
                }}
              >
                <Button type="primary" loading={this.state.busy}>
                  确认合并
                </Button>
              </Popconfirm>
            </div>
          )}
          {accounts.some((a) => a.merged_into_id) && (
            <Table
              className="mt"
              size="small"
              rowKey="id"
              pagination={false}
              dataSource={accounts.filter((a) => a.merged_into_id)}
              columns={[
                { title: "来源账户", dataIndex: "name" },
                { title: "目标账户", dataIndex: "merged_into_name" },
                {
                  title: "配置",
                  render: (_: unknown, a: Row) => (
                    <Popconfirm
                      title="解除账户合并？"
                      description="历史分录恢复按原账户汇总，合并后新增的流水仍留在目标账户。"
                      onConfirm={() =>
                        this.action(`/account-merges/${a.id}/undo`, {})
                      }
                    >
                      <Button size="small">解除合并</Button>
                    </Popconfirm>
                  ),
                },
              ]}
            />
          )}
        </Card>
        <Card
          id="account-group-settings"
          title="账户组"
          className="mb"
          extra={
            <Button
              onClick={() =>
                this.setState({ groupModal: true, editing: undefined })
              }
            >
              新建账户组
            </Button>
          }
        >
          <p>
            每个资金账户属于一个组，父组汇总所有子组。例如家庭下面包含我的账户和老婆的账户。组余额仅累计资产与负债。
          </p>
          <Table
            size="small"
            rowKey="id"
            pagination={false}
            scroll={{ x: 600 }}
            dataSource={groups}
            columns={[
              {
                title: "账户组",
                render: (_: unknown, g: Row) => tree.path(g.id),
              },
              { title: "资金账户数", dataIndex: "account_count" },
              {
                title: "汇总余额",
                render: (_: unknown, g: Row) => `¥ ${Money.format(g.balance)}`,
              },
              {
                title: "配置",
                render: (_: unknown, g: Row) => (
                  <Button
                    size="small"
                    onClick={() =>
                      this.setState({ editing: g, groupModal: true })
                    }
                  >
                    编辑组
                  </Button>
                ),
              },
            ]}
          />
          <div className="mt">
            <Space wrap>
              <Select
                aria-label="分配所属账户组"
                allowClear
                placeholder="所属账户组（留空为未分组）"
                style={{ width: 250 }}
                options={tree.options()}
                value={this.state.assignGroup}
                onChange={(assignGroup) => this.setState({ assignGroup })}
              />
              <Select
                aria-label="分配资金账户"
                mode="multiple"
                placeholder="选择资金账户"
                style={{ width: 320 }}
                options={accounts
                  .filter((a) => a.role !== "SYSTEM" && !a.merged_into_id)
                  .map((a) => ({ value: a.id, label: a.name }))}
                value={this.state.assignAccounts}
                onChange={(assignAccounts) => this.setState({ assignAccounts })}
              />
              <Button
                disabled={!this.state.assignAccounts.length}
                loading={this.state.busy}
                onClick={async () => {
                  if (
                    await this.action("/account-groups/assign", {
                      group_id: this.state.assignGroup || null,
                      account_ids: this.state.assignAccounts,
                    })
                  )
                    this.setState({ assignAccounts: [] });
                }}
              >
                保存所属组
              </Button>
            </Space>
          </div>
        </Card>
        <Modal
          title={this.state.editing ? "编辑账户组" : "新建账户组"}
          open={this.state.groupModal}
          footer={null}
          destroyOnHidden
          onCancel={() => this.setState({ groupModal: false })}
        >
          <Form
            layout="vertical"
            initialValues={this.state.editing || {}}
            key={this.state.editing?.id || "new"}
            onFinish={async (values) => {
              const editing = this.state.editing;
              if (
                await this.action(
                  "/account-groups" + (editing ? `/${editing.id}` : ""),
                  { ...values, parent_id: values.parent_id || null },
                  editing ? "PUT" : "POST",
                )
              )
                this.setState({ groupModal: false });
            }}
          >
            <Form.Item
              name="name"
              label="账户组名称"
              rules={[{ required: true }]}
            >
              <Input placeholder="例如：家庭、我的账户、老婆的账户" />
            </Form.Item>
            <Form.Item name="parent_id" label="父账户组">
              <Select
                allowClear
                options={tree
                  .options()
                  .filter((g) => g.value !== this.state.editing?.id)}
                placeholder="留空为顶层组"
              />
            </Form.Item>
            <Button type="primary" htmlType="submit" loading={this.state.busy}>
              保存账户组
            </Button>
          </Form>
        </Modal>
      </div>
    );
  }
}
