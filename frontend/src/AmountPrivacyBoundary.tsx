import React from "react";
import { AmountPrivacy } from "./AmountPrivacy";

/** Refresh the visible money-bearing content without updating navigation or data. */
export function AmountPrivacyBoundary({
  children,
}: {
  children: () => React.ReactNode;
}) {
  React.useSyncExternalStore(
    AmountPrivacy.subscribe,
    AmountPrivacy.hidden,
    AmountPrivacy.hidden,
  );
  return <>{children()}</>;
}
