import React from "react";

/** Reveal a committed local result without moving keyboard focus or report scope. */
export class AnalysisDetailFocus {
  ref = React.createRef<HTMLElement>();
  private frame?: number;
  private pending = false;
  private reducedMotion = false;
  private version = 0;

  request(reducedMotion = false) {
    this.cancel();
    this.pending = true;
    this.reducedMotion = reducedMotion;
  }

  cancel() {
    this.version++;
    this.pending = false;
    if (this.frame !== undefined && typeof cancelAnimationFrame === "function")
      cancelAnimationFrame(this.frame);
    this.frame = undefined;
  }

  /** Call after the selected table/tab or latest asynchronous response commits. */
  afterRender() {
    if (!this.pending || this.frame !== undefined) return;
    if (typeof window === "undefined") {
      this.cancel();
      return;
    }
    const version = this.version;
    const reveal = (attempt: number) => {
      this.frame = undefined;
      if (!this.pending || version !== this.version) return;
      const target = this.ref.current;
      if (
        !target ||
        target.isConnected === false ||
        target.closest?.(
          '[hidden], [aria-hidden="true"], .ant-tabs-tabpane-hidden',
        ) ||
        target.getBoundingClientRect().height === 0
      ) {
        if (attempt === 0 && typeof requestAnimationFrame === "function")
          this.frame = requestAnimationFrame(() => reveal(1));
        else this.pending = false;
        return;
      }
      this.pending = false;
      const viewport = window.innerHeight;
      const margin = 20;
      const topMargin = Math.max(
        margin,
        Number.parseFloat(
          window.getComputedStyle?.(target).scrollMarginTop || "",
        ) || 0,
      );
      const preview = Math.min(280, Math.max(0, viewport - topMargin - margin));
      const { top } = target.getBoundingClientRect();
      if (
        !viewport ||
        (top >= topMargin && top + preview <= viewport - margin) ||
        typeof target.scrollIntoView !== "function"
      )
        return;
      const reduced =
        this.reducedMotion ||
        target.dataset?.reducedMotion === "true" ||
        window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      target.scrollIntoView({
        block: "start",
        inline: "nearest",
        behavior: reduced ? "instant" : "smooth",
      });
    };
    if (typeof requestAnimationFrame === "function")
      this.frame = requestAnimationFrame(() => reveal(0));
    else reveal(0);
  }
}
