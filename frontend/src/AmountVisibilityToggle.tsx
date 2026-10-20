import React from "react";
import { Button, Tooltip } from "antd";
import { EyeOutlined, EyeInvisibleOutlined } from "@ant-design/icons";
import { AmountPrivacy } from "./AmountPrivacy";

export class AmountVisibilityToggle extends React.Component<
  {},
  { hidden: boolean }
> {
  state = { hidden: AmountPrivacy.hidden() };
  unsubscribe?: () => void;
  componentDidMount() {
    this.unsubscribe = AmountPrivacy.subscribe(() =>
      this.setState({ hidden: AmountPrivacy.hidden() }),
    );
  }
  componentWillUnmount() {
    this.unsubscribe?.();
  }
  render() {
    const { hidden } = this.state;
    return (
      <Tooltip
        title={hidden ? "显示页面中的金额" : "隐藏页面、表格和图表中的金额"}
      >
        <Button
          className="amount-visibility-toggle"
          icon={hidden ? <EyeInvisibleOutlined /> : <EyeOutlined />}
          aria-label="隐藏金额"
          aria-pressed={hidden}
          onClick={() => AmountPrivacy.set(!AmountPrivacy.hidden())}
        >
          {hidden ? "显示金额" : "隐藏金额"}
        </Button>
      </Tooltip>
    );
  }
}
