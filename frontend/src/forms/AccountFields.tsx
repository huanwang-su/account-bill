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
export function AccountFields({
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
      <div className="form-grid">
        <Form.Item name="name" label="账户名称" rules={[{ required: true }]}>
          <Input placeholder="例如：招商银行储蓄卡" />
        </Form.Item>
        <Form.Item name="role" label="账户角色">
          <Select
            options={[
              { value: "ASSET", label: "自有资产" },
              { value: "LIABILITY", label: "自有负债" },
              { value: "EXTERNAL", label: "外部往来" },
            ]}
          />
        </Form.Item>
      </div>
      <div className="form-grid">
        <Form.Item name="number" label="账号 / 卡号">
          <Input />
        </Form.Item>
        <Form.Item name="kind" label="账户类型">
          <Select
            options={[
              "支付宝",
              "微信",
              "银行卡",
              "现金",
              "信用卡",
              "公司贷款",
              "房贷",
              "理财",
              "证券",
              "其他",
            ].map((x) => ({ value: x, label: x }))}
          />
        </Form.Item>
      </div>
      <Form.Item name="group_id" label="所属账户组">
        <Select
          allowClear
          options={new AccountGroupTree(groups).options()}
          placeholder="选择个人或家庭账户组"
        />
      </Form.Item>
      <Form.Item name="tags" label="账户标签">
        <Select
          mode="tags"
          options={tagOptions.filter(
            (t) =>
              !tags.some(
                (x) => x.name === t.value && x.scope === "TRANSACTION",
              ),
          )}
        />
      </Form.Item>
      <Form.Item name="note" label="账户备注">
        <Input.TextArea
          rows={3}
          maxLength={2000}
          showCount
          placeholder="例如：每月还款金额、还款截止月份等"
        />
      </Form.Item>
      <Form.Item name="active" label="启用账户" valuePropName="checked">
        <Switch />
      </Form.Item>
    </>
  );
}
