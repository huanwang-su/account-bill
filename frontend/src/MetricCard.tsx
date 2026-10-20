import React from "react";

/** Shared summary surface; tone communicates the amount's financial meaning. */
export function MetricCard({
  className = "",
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      {...props}
      className={
        className.includes("metric") ? className : `metric ${className}`
      }
    />
  );
}
