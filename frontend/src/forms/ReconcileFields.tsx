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
export function ReconcileFields({
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
      <Form.Item name="at" label="核对截止时间" rules={[{ required: true }]}>
        <DatePicker showTime style={{ width: "100%" }} />
      </Form.Item>
      <Form.Item
        name="actual"
        label="外部实际余额（元，欠款填负数）"
        rules={[{ required: true }]}
      >
        <InputNumber stringMode precision={2} style={{ width: "100%" }} />
      </Form.Item>
      <Form.Item name="note" label="核对备注">
        <Input />
      </Form.Item>
    </>
  );
}
