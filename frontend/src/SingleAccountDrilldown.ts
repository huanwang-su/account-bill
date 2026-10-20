import { TransactionSemantics } from "./TransactionSemantics";
import type { Row } from "./api";
import { SingleAccountPresentation as Presentation } from "./SingleAccountPresentation";

export type AccountFlow =
  | "income"
  | "payments"
  | "expense"
  | "refunds"
  | "transfer-in"
  | "transfer-out"
  | "adjustments";

export interface SingleAccountSelection {
  day?: string;
  flow?: AccountFlow;
  category?: { id: number; kind: string; name: string };
  party?: { key: string; name: string };
  movement?: {
    key: string;
    label: string;
    transaction_ids: number[];
    mode?: "cashflow" | "counterparties";
  };
}

/** Local detail scope never changes the reconciled account or its balances. */
export class SingleAccountDrilldown {
  static flowLabels: Record<AccountFlow, string> = {
    income: "收入",
    payments: "付款原额（不含退款）",
    expense: "净支出（付款与退款）",
    refunds: "退款",
    "transfer-in": "内部转入",
    "transfer-out": "内部转出",
    adjustments: "期初录入等调整",
  };

  static sanitize(account: Row, selection: SingleAccountSelection) {
    const scope = { ...selection };
    if (!Presentation.cashflow(account)) {
      delete scope.category;
      delete scope.flow;
    }
    if (!Presentation.counterparties(account)) delete scope.party;
    const movementMode =
      scope.movement?.mode ||
      (scope.movement?.key.includes(":cashflow:")
        ? "cashflow"
        : scope.movement?.key.includes(":counterparties:")
          ? "counterparties"
          : undefined);
    if (
      scope.movement &&
      ((movementMode === "cashflow" && !Presentation.cashflow(account)) ||
        (movementMode === "counterparties" &&
          !Presentation.counterparties(account)))
    )
      delete scope.movement;
    return scope;
  }

  static rows(account: Row, selection: SingleAccountSelection): Row[] {
    const scope = this.sanitize(account, selection);
    const category = scope.category
      ? account.categories?.find(
          (row: Row) =>
            row.id === scope.category!.id && row.kind === scope.category!.kind,
        )
      : undefined;
    const categoryIds = new Set<number>(category?.transaction_ids || []);
    const party = scope.party
      ? account.counterparties?.parties?.find(
          (row: Row) => row.key === scope.party!.key,
        )
      : undefined;
    const partyIds = new Set<number>(
      party?.transactions?.map((row: Row) => row.id) || [],
    );
    const movementIds = new Set<number>(scope.movement?.transaction_ids || []);
    return (account.transactions || []).filter((row: Row) => {
      if (scope.day && row.occurred_at?.slice(0, 10) !== scope.day)
        return false;
      if (
        scope.category &&
        (!categoryIds.has(row.id) || row.kind !== scope.category.kind)
      )
        return false;
      if (scope.party && !partyIds.has(row.id)) return false;
      if (scope.movement && !movementIds.has(row.id)) return false;
      if (!scope.flow) return true;
      const valuation = TransactionSemantics.isValuation(row);
      switch (scope.flow) {
        case "income":
          return row.kind === "INCOME" && !valuation;
        case "expense":
          return ["EXPENSE", "REFUND"].includes(row.kind) && !valuation;
        case "payments":
          return row.kind === "EXPENSE" && !valuation;
        case "refunds":
          return row.kind === "REFUND" && !valuation;
        case "transfer-in":
          return (
            row.kind === "TRANSFER" && row.account_change > 0 && !valuation
          );
        case "transfer-out":
          return (
            row.kind === "TRANSFER" && row.account_change < 0 && !valuation
          );
        case "adjustments":
          return (
            row.kind === "OPENING" ||
            (!valuation &&
              !["INCOME", "EXPENSE", "REFUND", "TRANSFER"].includes(row.kind))
          );
      }
    });
  }

  static day(params: any, trend: Row[]): string | undefined {
    if (params.componentType === "xAxis" && params.targetType === "axisLabel")
      return trend.find((row) => row.day === params.value)?.day;
    if (params.componentType && params.componentType !== "series") return;
    return Number.isInteger(params.dataIndex)
      ? trend[params.dataIndex]?.day
      : undefined;
  }
}

/** Every total is calculated from the returned account movements, once per row. */
export class PartyMovement {
  static summary(rows: Row[]) {
    const incoming = rows.reduce(
      (sum, row) => sum + Math.max(0, row.account_change),
      0,
    );
    const outgoing = rows.reduce(
      (sum, row) => sum + Math.max(0, -row.account_change),
      0,
    );
    return { incoming, outgoing, net: incoming - outgoing, count: rows.length };
  }

  static daily(rows: Row[]): Row[] {
    const days = new Map<string, Row[]>();
    for (const row of rows) {
      const day = row.occurred_at.slice(0, 10);
      if (!days.has(day)) days.set(day, []);
      days.get(day)!.push(row);
    }
    return [...days]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([day, transactions]) => ({
        day,
        ...this.summary(transactions),
      }));
  }

  static all(report: Row): Row {
    const transactions: Row[] = (report.parties || []).flatMap(
      (party: Row) => party.transactions || [],
    );
    return {
      key: "all-parties",
      counterparty: "全部交易方",
      aggregate: true,
      valuation: false,
      transactions,
      ...this.summary(transactions),
    };
  }
}
