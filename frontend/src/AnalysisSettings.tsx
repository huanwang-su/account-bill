import React from "react";
import { AmountInput as InputNumber } from "./AmountInput";
import { Button, Card, Select, Space, Switch, Segmented, message } from "antd";
import { LedgerApi, Row } from "./api";
import { PagedTable } from "./PagedTable";
import { SingleAccountPresentation } from "./SingleAccountPresentation";
import { AnalysisAccountSelection } from "./AnalysisAccountScope";

export class AnalysisSettings extends React.Component<
  {
    accounts: Row[];
    onChanged: () => void;
    onSingleAccounts: () => void;
  },
  { config?: Row; busy: boolean; loading: boolean }
> {
  api = new LedgerApi();
  state: { config?: Row; busy: boolean; loading: boolean } = {
    busy: false,
    loading: true,
  };
  componentDidMount() {
    this.load();
  }
  async load() {
    this.setState({ loading: true });
    try {
      this.setState({ config: await this.api.request("/analysis-settings") });
    } catch (e) {
      message.error(e instanceof Error ? e.message : "分析配置加载失败");
    } finally {
      this.setState({ loading: false });
    }
  }
  change(patch: Row) {
    if (patch.single_account_ids)
      patch.single_account_modes = Object.fromEntries(
        patch.single_account_ids.map((id: number) => [
          String(id),
          this.state.config?.single_account_modes?.[id] || "both",
        ]),
      );
    this.setState({ config: { ...this.state.config, ...patch } });
  }
  async save() {
    this.setState({ busy: true });
    try {
      const config = this.state.config!;
      const payload = Object.fromEntries(
        [
          "revision",
          "exclude_investment_accounts",
          "exclude_single_accounts",
          "large_income_threshold_minor",
          "large_expense_threshold_minor",
          "income_excluded_account_ids",
          "expense_excluded_account_ids",
          "single_account_ids",
          "single_excluded_account_ids",
        ].map((k) => [k, config[k]]),
      );
      payload.single_account_modes = Object.fromEntries(
        config.single_account_ids.map((id: number) => [
          String(id),
          config.single_account_modes?.[id] || "both",
        ]),
      );
      this.setState({
        config: await this.api.request("/analysis-settings", "PUT", payload),
      });
      this.props.onChanged();
      message.success("分析配置已保存");
      return true;
    } catch (e) {
      message.error(e instanceof Error ? e.message : "保存失败");
      return false;
    } finally {
      this.setState({ busy: false });
    }
  }
  render() {
    const config = this.state.config;
    const options = new AnalysisAccountSelection(this.props.accounts)
      .choices()
      .map((a) => ({ value: a.id, label: a.name }));
    return (
      <div className="analysis-settings-workspace">
        <Card title="报表默认值" loading={this.state.loading} className="mb">
          {config && (
            <>
              <Space className="mb">
                <Switch
                  aria-label="默认屏蔽理财账户"
                  checked={config.exclude_investment_accounts}
                  disabled={this.state.busy}
                  onChange={(exclude_investment_accounts) =>
                    this.change({ exclude_investment_accounts })
                  }
                />
                <span>默认屏蔽证券、理财账户</span>
              </Space>
              <Space className="mb">
                <Switch
                  aria-label="默认屏蔽所选单账户"
                  checked={config.exclude_single_accounts}
                  disabled={this.state.busy}
                  onChange={(exclude_single_accounts) =>
                    this.change({ exclude_single_accounts })
                  }
                />
                <span>默认屏蔽所选单账户</span>
              </Space>
              <div className="analysis-config-fields mb">
                {[
                  ["large_income_threshold_minor", "大额收入默认门槛"],
                  ["large_expense_threshold_minor", "大额支出默认门槛"],
                ].map(([field, label]) => (
                  <label key={field}>
                    <span>{label}（元）</span>
                    <InputNumber
                      aria-label={label}
                      min={0.01}
                      max={1000000000000}
                      precision={2}
                      value={
                        config[field] == null ? undefined : config[field] / 100
                      }
                      disabled={this.state.busy}
                      onChange={(value) =>
                        value !== null &&
                        this.change({
                          [field]: Math.round(Number(value) * 100),
                        })
                      }
                    />
                  </label>
                ))}
              </div>
              <p className="muted">
                总览、收支分析、收入分析、支出分析及资金流转统一使用这些默认值。页面上的修改仅对当前查看临时生效，重置后恢复此处设置。资产负债表及独立账户、理财分析保留各自完整口径。
              </p>
              <p className="muted">
                理财屏蔽自动跟随账户类型，包括以后新增的理财账户；普通银行账户不受影响。以下名单可分别额外屏蔽账户。
              </p>
              <div className="analysis-config-fields">
                {[
                  ["income_excluded_account_ids", "收入分析额外屏蔽账户"],
                  ["expense_excluded_account_ids", "支出分析额外屏蔽账户"],
                ].map(([field, label]) => (
                  <label key={field}>
                    <span>{label}</span>
                    <Select<number[]>
                      aria-label={label}
                      mode="multiple"
                      allowClear
                      showSearch
                      optionFilterProp="label"
                      placeholder="不额外屏蔽账户"
                      options={options}
                      value={config[field]}
                      disabled={this.state.busy}
                      onChange={(value) => this.change({ [field]: value })}
                    />
                  </label>
                ))}
              </div>
            </>
          )}
        </Card>
        <Card
          title="默认屏蔽的单账户"
          loading={this.state.loading}
          className="mb"
        >
          {config && (
            <>
              <p>
                默认屏蔽开关开启时，仅排除这份名单；关注账户不会自动被屏蔽。
              </p>
              <Select<number[]>
                aria-label="默认屏蔽的单账户"
                mode="multiple"
                allowClear
                showSearch
                optionFilterProp="label"
                options={options}
                value={config.single_excluded_account_ids || []}
                style={{ width: "100%" }}
                disabled={this.state.busy}
                onChange={(single_excluded_account_ids) =>
                  this.change({ single_excluded_account_ids })
                }
              />
              <p className="muted">
                屏蔽账户仍可在单账户分析中独立核对；历史屏蔽名单会保留，其他账户可单独加入关注名单。
              </p>
            </>
          )}
        </Card>
        <Card title="关注账户" loading={this.state.loading} className="mb">
          {config && (
            <>
              <p>
                总览和单账户分析共用这份关注名单。可选择银行、支付、理财或负债账户，分别展示余额、收支及内部转入转出；关注本身不会使账户被屏蔽。
              </p>
              <Select<number[]>
                aria-label="关注账户"
                mode="multiple"
                maxTagCount={2}
                allowClear
                showSearch
                optionFilterProp="label"
                placeholder="选择要关注的账户"
                options={options}
                value={config.single_account_ids}
                style={{ width: "100%" }}
                disabled={this.state.busy}
                onChange={(single_account_ids) =>
                  this.change({ single_account_ids })
                }
              />
              <PagedTable<Row>
                className="mt"
                rowKey="id"
                dataSource={config.single_account_ids.map((id: number) => ({
                  id,
                  name:
                    this.props.accounts.find((a) => a.id === id)?.name ||
                    String(id),
                }))}
                pageResetKey={JSON.stringify(config.single_account_ids)}
                defaultPageSize={10}
                size="small"
                columns={[
                  { title: "账户", dataIndex: "name" },
                  {
                    title: "分析内容",
                    render: (_, account) => (
                      <Segmented
                        aria-label={account.name + "分析内容"}
                        options={SingleAccountPresentation.options}
                        value={
                          config.single_account_modes?.[account.id] || "both"
                        }
                        disabled={this.state.busy}
                        onChange={(mode) =>
                          this.change({
                            single_account_modes: {
                              ...config.single_account_modes,
                              [account.id]: mode,
                            },
                          })
                        }
                      />
                    ),
                  },
                ]}
              />
              <p className="muted">
                总览分别展示关注账户；“单账户分析”还可核对默认屏蔽名单中的账户。两份名单都为空时页面为空，不会自动添加账户。
              </p>
            </>
          )}
        </Card>
        <Space className="analysis-settings-actions" wrap>
          <Button
            type="primary"
            disabled={!config || this.state.loading}
            loading={this.state.busy}
            onClick={() => this.save()}
          >
            保存分析配置
          </Button>
          <Button disabled={this.state.busy} onClick={() => this.load()}>
            重新加载
          </Button>
          <Button
            disabled={!config || this.state.loading || this.state.busy}
            onClick={async () => {
              if (await this.save()) this.props.onSingleAccounts();
            }}
          >
            保存并查看单账户分析
          </Button>
        </Space>
      </div>
    );
  }
}
