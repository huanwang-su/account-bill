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
export function CategoryFields({
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
      <Form.Item name="name" label="分类名称" rules={[{ required: true }]}>
        <Input />
      </Form.Item>
      <Form.Item name="kind" label="类型">
        <Select
          options={[
            { value: "EXPENSE", label: "支出" },
            { value: "INCOME", label: "收入" },
          ]}
        />
      </Form.Item>
      <Form.Item name="parent_id" label="父分类（留空为顶级）">
        <TreeSelect allowClear treeData={tree.options()} />
      </Form.Item>
      <Form.Item name="active" label="启用" valuePropName="checked">
        <Switch />
      </Form.Item>
      <p className="muted">移动分类会改变历史报表的分类归属。</p>
    </>
  );
}
