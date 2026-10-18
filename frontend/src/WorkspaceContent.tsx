import React from "react";
import { AppearanceContext } from "./Appearance";

interface MotionPlan {
  ready: string;
  regions: string;
}

const metricsPlan = (scope: string, extra: string[]): MotionPlan => ({
  ready: `${scope} .analysis-metrics`,
  regions: [`${scope} .analysis-metrics > .metric`, ...extra].join(", "),
});

/** These anchors appear after the first report, rather than with its filters. */
const plans: Record<string, MotionPlan> = {
  overview: {
    ready: ".family-overview",
    regions:
      ".overview-hero, .overview-cashflow > .ant-card, .overview-main-grid",
  },
  accounts: {
    ready: ".account-directory",
    regions:
      ".account-page-toolbar, .account-group-navigation, .account-scope-summary, .account-list-panel",
  },
  "report:income": metricsPlan(".income-workspace", [
    ".income-workspace .balance-flow-card",
    ".income-workspace .analysis-category-grid",
  ]),
  "report:expenses": metricsPlan(".expense-workspace", [
    ".expense-workspace .spending-insights",
    ".expense-workspace .balance-flow-card",
  ]),
  "report:analysis": metricsPlan(".financial-analysis-workspace", [
    ".financial-analysis-workspace .analysis-trend",
    ".financial-analysis-workspace .analysis-category-grid",
  ]),
  "report:investments": metricsPlan(".investment-workspace", [
    ".investment-charts > .ant-card",
  ]),
  "report:counterparties": metricsPlan(".counterparty-workspace", [
    ".counterparty-charts > .ant-card",
  ]),
  "report:balance-sheet": {
    ready: ".balance-sheet-metrics",
    regions:
      ".balance-sheet-metrics > .metric, .balance-sheet-distributions > *, .balance-sheet-grid > .ant-card",
  },
  "report:single-accounts": {
    ready: ".single-account-layout",
    regions:
      ".single-account-list, .single-account-heading, .single-account-main .metrics > .metric",
  },
};

const hidden =
  '[hidden], [aria-hidden="true"], .ant-tabs-tabpane-hidden, .ant-collapse-content-hidden';
const pending = ".ant-card-loading, .ant-skeleton, .ant-spin-spinning";
const fallback =
  ".metric, .ant-card, .ant-alert, .ant-empty, .ant-table-wrapper, .ant-collapse";

/** Reveal each route's first settled regions without remounting its children. */
export class WorkspaceContent extends React.Component<{
  route: string;
  children: React.ReactNode;
}> {
  static contextType = AppearanceContext;
  declare context: React.ContextType<typeof AppearanceContext>;
  element = React.createRef<HTMLDivElement>();
  transitions: Animation[] = [];
  observer?: MutationObserver;
  frame?: number;
  timeout?: ReturnType<typeof setTimeout>;
  waiting = false;
  visit = 0;

  componentDidMount() {
    this.arm();
  }

  componentDidUpdate(previous: Readonly<typeof this.props>) {
    if (this.context.reducedMotion) {
      // Returning to normal motion must not replay the route we just skipped.
      this.cancel();
    } else if (previous.route !== this.props.route) {
      this.arm();
    }
  }

  componentWillUnmount() {
    this.cancel();
  }

  stopWaiting() {
    this.waiting = false;
    this.observer?.disconnect();
    this.observer = undefined;
    if (this.frame !== undefined) cancelAnimationFrame(this.frame);
    this.frame = undefined;
    if (this.timeout !== undefined) clearTimeout(this.timeout);
    this.timeout = undefined;
  }

  cancel() {
    this.visit++;
    this.stopWaiting();
    this.transitions.forEach((animation) => animation.cancel());
    this.transitions = [];
  }

  arm() {
    this.cancel();
    const root = this.element.current;
    if (!root || this.context.reducedMotion) return;
    const visit = this.visit;
    this.waiting = true;
    if (typeof MutationObserver !== "undefined") {
      this.observer = new MutationObserver(() => {
        if (visit === this.visit) this.schedule();
      });
      this.observer.observe(root, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["class", "hidden", "aria-hidden", "aria-busy"],
      });
    }
    // A failed or indefinitely pending request must not leave a live observer.
    this.timeout = setTimeout(() => {
      if (visit === this.visit) this.stopWaiting();
    }, 10000);
    this.schedule();
  }

  schedule() {
    if (!this.waiting || this.frame !== undefined) return;
    const visit = this.visit;
    this.frame = requestAnimationFrame(() => {
      if (visit !== this.visit || !this.waiting) return;
      this.frame = undefined;
      this.reveal();
    });
  }

  reveal() {
    const root = this.element.current;
    if (!root || this.context.reducedMotion) {
      this.cancel();
      return;
    }
    if (
      Array.from(root.querySelectorAll(pending)).some(
        (node) => !node.closest(hidden),
      )
    )
      return;

    const plan = plans[this.props.route];
    const ready = plan && root.querySelector(plan.ready);
    let candidates = Array.from(
      root.querySelectorAll<HTMLElement>(
        ready ? `${plan.regions}, ${fallback}` : fallback,
      ),
    );
    // Empty/error reports may have only their settled controls left on screen.
    if (!candidates.length) {
      const workspace = root.firstElementChild;
      if (!workspace) return;
      candidates = Array.from(workspace.children) as HTMLElement[];
      if (!candidates.length) candidates = [workspace as HTMLElement];
    }
    const separate: HTMLElement[] = [];
    for (const candidate of candidates) {
      if (
        !candidate.closest(hidden) &&
        !separate.some((parent) => parent.contains(candidate))
      )
        separate.push(candidate);
    }
    const view = root.ownerDocument?.defaultView;
    const inView = (region: HTMLElement) => {
      if (!view || !region.getBoundingClientRect) return true;
      const box = region.getBoundingClientRect();
      return (
        box.bottom > 0 &&
        box.top < view.innerHeight &&
        box.right > 0 &&
        box.left < view.innerWidth
      );
    };
    const visible = separate.filter(inView);
    const regions = [
      ...visible,
      ...separate.filter((region) => !visible.includes(region)),
    ].slice(0, 6);
    // Disconnect before charts, filters or later data refreshes mutate the DOM.
    this.stopWaiting();
    regions.forEach((region, index) => {
      const animation = region.animate?.(
        [
          { opacity: 0.25, transform: "translateY(12px)" },
          { opacity: 1, transform: "translateY(0)" },
        ],
        {
          duration: 380,
          delay: Math.min(index * 50, 200),
          easing: "cubic-bezier(0.2, 0.7, 0.25, 1)",
          // Hold the first frame during stagger delays; restore normal CSS after.
          fill: "backwards",
        },
      );
      if (animation) {
        this.transitions.push(animation);
        animation.onfinish = () => {
          this.transitions = this.transitions.filter(
            (item) => item !== animation,
          );
        };
      }
    });
  }

  render() {
    return (
      <div ref={this.element} className="page-content">
        {this.props.children}
      </div>
    );
  }
}
