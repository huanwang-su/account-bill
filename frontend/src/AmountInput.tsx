import React from "react";
import { InputNumber } from "antd";
import { AmountPrivacy } from "./AmountPrivacy";

/** Keep the numeric value/parser intact while masking monetary form inputs. */
export const AmountInput = React.forwardRef<
  React.ComponentRef<typeof InputNumber>,
  React.ComponentProps<typeof InputNumber>
>(function AmountInput(props, ref) {
  const hidden = React.useSyncExternalStore(
    AmountPrivacy.subscribe,
    AmountPrivacy.hidden,
    AmountPrivacy.hidden,
  );
  return (
    <InputNumber
      {...props}
      ref={ref}
      type={hidden ? "password" : props.type}
      autoComplete={hidden ? "off" : props.autoComplete}
    />
  );
});
