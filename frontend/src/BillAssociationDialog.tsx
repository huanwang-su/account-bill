import React from "react";
import { Alert, Modal, Form, Select, Input, Button, message } from "antd";
import { LedgerApi, Row, MoneyFormatter } from "./api";

export class BillAssociationDialog extends React.Component<
  { source: Row; onClose: () => void; onChanged: () => Promise<void> },
  { candidates: Row[]; loading: boolean; busy: boolean }
> {
  state = { candidates: [] as Row[], loading: true, busy: false };
  api = new LedgerApi();
  componentDidMount() {
    this.load();
  }
  async load() {
    try {
      this.setState({
        candidates: await this.api.request(
          "/bills/association-candidates?bill_id=" +
            encodeURIComponent(this.props.source.id),
        ),
      });
    } catch (e) {
      message.error(String(e));
    } finally {
      this.setState({ loading: false });
    }
  }
  async save(values: Row) {
    this.setState({ busy: true });
    try {
      await this.api.request("/bills/associate", "POST", {
        source_id: this.props.source.id,
        ...values,
      });
      await this.props.onChanged();
      message.success("凭证已关联，同一交易只记账一次");
      this.props.onClose();
    } catch (e) {
      message.error(String(e));
    } finally {
      this.setState({ busy: false });
    }
  }
  render() {
    return (
      <Modal
        open
        title="关联银行凭证"
        onCancel={this.props.onClose}
        footer={null}
      >
        <Alert
          className="mb"
          type="info"
          showIcon
          message="两份账单关联到一笔交易"
          description="候选已核对银行卡、日期、币种及原金额和净金额；仍需结合商户、订单和用途确认。关联本身不会增加流水，已重复入账的部分会冲回。"
        />
        <Form layout="vertical" onFinish={(v) => this.save(v)}>
          <Form.Item
            name="target_id"
            label="银行账单对应记录"
            rules={[{ required: true }]}
          >
            <Select
              loading={this.state.loading}
              options={this.state.candidates.map((c) => ({
                value: c.bill_id,
                label: `${c.occurred_at.slice(0, 10)} · ${c.counterparty || c.description} · ¥ ${MoneyFormatter.format(c.amount_minor)} · ${c.ledger_status === "POSTED" ? "已入账" : "待核对"}`,
              }))}
              placeholder="选择确认属于同一笔付款的记录"
            />
          </Form.Item>
          {!this.state.loading && !this.state.candidates.length && (
            <Alert
              className="mb"
              type="warning"
              message="没有符合条件的银行记录，保留待核对"
            />
          )}
          <Form.Item name="note" label="关联依据" rules={[{ required: true }]}>
            <Input.TextArea
              maxLength={1000}
              placeholder="例如：银行卡和商户一致，订单退款也对应"
            />
          </Form.Item>
          <Button
            type="primary"
            htmlType="submit"
            loading={this.state.busy}
            disabled={!this.state.candidates.length}
          >
            确认关联
          </Button>
        </Form>
      </Modal>
    );
  }
}
