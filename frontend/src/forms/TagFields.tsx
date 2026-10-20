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
export function TagFields({
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
      <Form.Item name="name" label="标签名称" rules={[{ required: true }]}>
        <Input />
      </Form.Item>
      <Form.Item name="parent_id" label="父标签">
        <TreeSelect
          allowClear
          placeholder="留空为一级标签"
          treeDefaultExpandAll
          treeData={new TagTree(tags).options(
            undefined,
            null,
            true,
            e?.id ? new TagTree(tags).descendants(e.id) : new Set(),
          )}
        />
      </Form.Item>
      <Form.Item name="scope" label="适用范围">
        <Select
          options={[
            { value: "BOTH", label: "账户与流水" },
            { value: "ACCOUNT", label: "账户" },
            { value: "TRANSACTION", label: "流水" },
          ]}
        />
      </Form.Item>
    </>
  );
}
