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
export function ValuationFields({
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
      <Alert
        className="mb"
        type="info"
        message={
          e!.opening_set
            ? "按新总资产与已记账余额的差额，生成估值盈亏交易。"
            : "首次余额作为期初基准，不计算收益。已有流水时，请先补全期初。"
        }
        description="填写证券账户总资产（资金余额 + 持仓市值），不要只填可用资金。充值、提现先记内部转账，再更新余额；补录历史交易前先撤销后续估值，再按时间重新更新余额。"
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
  );
}
