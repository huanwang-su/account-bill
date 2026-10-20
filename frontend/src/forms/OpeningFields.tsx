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
export function OpeningFields({
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
        message="填写最早一笔流水发生前的真实余额。负债账户欠款请填写负数。"
      />
      <Form.Item
        name="amount"
        label="期初余额（元）"
        rules={[{ required: true }]}
      >
        <InputNumber stringMode precision={2} style={{ width: "100%" }} />
      </Form.Item>
      <Form.Item
        name="occurred_at"
        label="期初时间"
        rules={[{ required: true }]}
      >
        <DatePicker showTime style={{ width: "100%" }} />
      </Form.Item>
    </>
  );
}
