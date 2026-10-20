import { ExpenseTransactionPicker } from "./ExpenseTransactionPicker";
import React from "react";
import {
  Form,
  Input,
  Select,
  Switch,
  TreeSelect,
  DatePicker,
  Alert,
  Button,
} from "antd";
import { AmountInput as InputNumber } from "../AmountInput";
import {
  DisplayMoneyFormatter as Money,
  CategoryTree,
  AccountGroupTree,
  TagTree,
  Row,
} from "../api";
import type { LedgerFieldProps } from "./FieldProps";
const kindNames: Row = {
  EXPENSE: "支出",
  INCOME: "收入",
  TRANSFER: "转账",
  REFUND: "退款",
};
export function TransactionFields({
  modal,
  editing: e,
  formKind,
  groups,
  tags,
  transactions,
  tree,
  tagOptions,
  accountsOptions,
}: LedgerFieldProps) {
  return (
    <>
      {modal === "decision" && (
        <Alert
          className="mb"
          type="info"
          message={`${e!.counterparty} · ${e!.note}`}
          description={`原口径：${e!.direction}；原付款方式：${e!.method || "未提供"}。${e!.warning}`}
        />
      )}
      <Form.Item name="kind" label="业务类型" rules={[{ required: true }]}>
        <Select
          options={["EXPENSE", "INCOME", "TRANSFER", "REFUND"].map((x) => ({
            value: x,
            label: kindNames[x],
          }))}
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
          <Select options={accountsOptions} placeholder="请选择实际账户" />
        </Form.Item>
        {formKind === "TRANSFER" ? (
          <Form.Item
            name="to_account_id"
            label="转入账户"
            rules={[{ required: true }]}
          >
            <Select options={accountsOptions} />
          </Form.Item>
        ) : modal === "decision" ? (
          <Form.Item
            name="category_id"
            label="分类"
            rules={[{ required: true }]}
          >
            <TreeSelect
              treeData={tree.options(
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
      {(modal === "decision" || ["TRANSFER", "REFUND"].includes(formKind)) && (
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
        <Alert className="mb" type="info" message="退款统一使用“退款”分类" />
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
                        treeData={tree.options(
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
          <ExpenseTransactionPicker />
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
              options={tagOptions.filter(
                (t) =>
                  !tags.some(
                    (x) => x.name === t.value && x.scope === "ACCOUNT",
                  ),
              )}
            />
          </Form.Item>
        </>
      )}
    </>
  );
}
