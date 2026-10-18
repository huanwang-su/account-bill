import React from "react";
import {
  Alert,
  Button,
  Form,
  Input,
  InputNumber,
  Select,
  type FormInstance,
} from "antd";
import { CategoryTree, type Row } from "./api";
import { BillReviewModel } from "./BillReviewModel";

export class BillReviewForm extends React.Component<
  {
    bill: Row;
    accounts: Row[];
    categories: Row[];
    busy: boolean;
    onSubmit: (values: Row) => void;
  },
  { kind: string }
> {
  form = React.createRef<FormInstance>();
  model = new BillReviewModel(this.props.bill, this.props.accounts);
  state = { kind: this.model.kind };
  changeKind(next: string) {
    const patch = BillReviewModel.changeKind(
      this.state.kind,
      next,
      this.form.current?.getFieldsValue() || {},
      this.props.bill.facts.flow,
    );
    this.form.current?.setFieldsValue(patch);
    this.setState({ kind: next });
  }
  renderAccounts(getFieldValue: (key: string) => any) {
    const kind = this.state.kind;
    const receiving = BillReviewModel.receiving(kind);
    const transfer = kind === "TRANSFER";
    const field = (side: "payment" | "receipt") => {
      const external = !transfer && (side === "payment") === receiving;
      const name =
        transfer && side === "receipt" ? "to_account_id" : "account_id";
      const label = side === "payment" ? "付款账户" : "收款账户";
      return (
        <Form.Item
          key={side}
          name={external ? undefined : name}
          label={
            label +
            (transfer ? (side === "payment" ? "（转出）" : "（转入）") : "")
          }
          dependencies={
            external
              ? undefined
              : [name === "account_id" ? "to_account_id" : "account_id"]
          }
          rules={
            external
              ? undefined
              : [
                  { required: true, message: `请选择${label}` },
                  {
                    validator: (_, value) =>
                      transfer &&
                      value &&
                      value ===
                        getFieldValue(
                          name === "account_id"
                            ? "to_account_id"
                            : "account_id",
                        )
                        ? Promise.reject(new Error("转出与转入账户不能相同"))
                        : Promise.resolve(),
                  },
                ]
          }
        >
          {external ? (
            <Input
              aria-label={label}
              value={`外部交易方 · ${this.model.counterparty}`}
              disabled
            />
          ) : (
            <Select
              aria-label={label}
              showSearch
              optionFilterProp="label"
              placeholder={`选择${label}`}
              options={this.model.choices().map((option) => ({
                ...option,
                disabled:
                  transfer &&
                  option.value ===
                    getFieldValue(
                      name === "account_id" ? "to_account_id" : "account_id",
                    ),
              }))}
            />
          )}
        </Form.Item>
      );
    };
    return (
      <div className="bill-review-account-grid">
        {field("payment")}
        {field("receipt")}
      </div>
    );
  }
  render() {
    const { bill, categories, busy } = this.props;
    const { kind } = this.state;
    return (
      <Form
        ref={this.form}
        layout="vertical"
        disabled={busy}
        initialValues={this.model.initialValues()}
        onFinish={(values) =>
          this.props.onSubmit(BillReviewModel.payload(values))
        }
      >
        <Alert
          className="mb"
          type="warning"
          showIcon
          message={bill.ledger_reason || "请核对实际资金账户及金额"}
        />
        <Form.Item name="kind" label="交易类型" rules={[{ required: true }]}>
          <Select
            onChange={(next) => this.changeKind(next)}
            options={[
              { value: "EXPENSE", label: "支出" },
              { value: "INCOME", label: "收入" },
              { value: "TRANSFER", label: "内部转账" },
              { value: "REFUND", label: "退款" },
            ]}
          />
        </Form.Item>
        <Form.Item noStyle shouldUpdate>
          {({ getFieldValue }) => this.renderAccounts(getFieldValue)}
        </Form.Item>
        {kind === "REFUND" ? (
          <Alert className="mb" type="info" message="退款统一使用“退款”分类" />
        ) : (
          kind !== "TRANSFER" && (
            <Form.Item name="category_id" label="入账分类">
              <Select
                allowClear
                placeholder="留空沿用明细分类"
                options={categories
                  .filter(
                    (category) =>
                      category.active &&
                      category.kind ===
                        (kind === "INCOME" ? "INCOME" : "EXPENSE"),
                  )
                  .map((category) => ({
                    value: category.id,
                    label: new CategoryTree(categories).path(category.id),
                  }))}
              />
            </Form.Item>
          )
        )}
        <Form.Item
          name="amount"
          label="实际资金变动金额（元）"
          rules={[{ required: true }]}
        >
          <InputNumber
            stringMode
            precision={2}
            min={0.01}
            style={{ width: "100%" }}
          />
        </Form.Item>
        {kind === "REFUND" && (
          <Form.Item name="related_id" label="原支出流水编号（可选）">
            <InputNumber precision={0} min={1} style={{ width: "100%" }} />
          </Form.Item>
        )}
        <Button type="primary" htmlType="submit" loading={busy}>
          确认并入账
        </Button>
      </Form>
    );
  }
}
