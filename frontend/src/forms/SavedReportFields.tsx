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
export function SavedReportFields({
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
    <Form.Item name="name" label="报表名称" rules={[{ required: true }]}>
      <Input placeholder="例如：家庭每月餐饮" />
    </Form.Item>
  );
}
