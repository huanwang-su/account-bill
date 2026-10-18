import type { Row } from "./api";

const number = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value !== 0
    ? value
    : 0;

export interface BalanceContribution {
  key: "cashflow" | "transfers" | "valuation" | "adjustments";
  label: string;
  amount: number;
  transaction_ids: number[];
}

/** Explain the reported balance bridge without reclassifying household spending. */
export class AccountReadoutData {
  cashflow: number;
  netExpense: number;
  transfers: number;
  components: BalanceContribution[];
  leading?: BalanceContribution;
  reconciled: boolean;

  constructor(public account: Row) {
    this.netExpense = number(account.expense) - number(account.refunds);
    this.cashflow = number(account.income) - this.netExpense;
    this.transfers = number(account.transfer_in) - number(account.transfer_out);
    this.components = [
      {
        key: "cashflow",
        label: "已记收支净额",
        amount: this.cashflow,
        transaction_ids: [],
      },
      {
        key: "transfers",
        label: "内部转账净额",
        amount: this.transfers,
        transaction_ids: [],
      },
      {
        key: "valuation",
        label: "证券估值",
        amount: number(account.valuation_profit),
        transaction_ids: [],
      },
      {
        key: "adjustments",
        label: "期初及其他调整",
        amount: number(account.adjustments),
        transaction_ids: [],
      },
    ];
    for (const row of account.transactions || []) {
      const key =
        row.kind === "OPENING"
          ? "adjustments"
          : row.source === "证券余额更新"
            ? "valuation"
            : ["INCOME", "EXPENSE", "REFUND"].includes(row.kind)
              ? "cashflow"
              : row.kind === "TRANSFER"
                ? "transfers"
                : "adjustments";
      if (Number.isInteger(row.id))
        this.components
          .find((component) => component.key === key)!
          .transaction_ids.push(row.id);
    }
    this.leading = [...this.components]
      .filter((component) => component.amount !== 0)
      .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount))[0];
    const fields = [
      "change",
      "income",
      "expense",
      "refunds",
      "transfer_in",
      "transfer_out",
      "valuation_profit",
      "adjustments",
    ];
    this.reconciled =
      account.reconciled !== false &&
      fields.every(
        (field) =>
          typeof account[field] === "number" && Number.isFinite(account[field]),
      ) &&
      this.components.reduce((sum, component) => sum + component.amount, 0) ===
        account.change;
  }
}

/** Compare gross and signed movements separately, retaining original party rows. */
export class PartyReadoutData {
  static gross(row: Row) {
    return number(row.incoming) + number(row.outgoing);
  }

  static rank(rows: Row[]) {
    return [...rows].sort(
      (a, b) =>
        this.gross(b) - this.gross(a) ||
        Math.abs(number(b.incoming) - number(b.outgoing)) -
          Math.abs(number(a.incoming) - number(a.outgoing)) ||
        number(b.count) - number(a.count) ||
        String(a.counterparty || "").localeCompare(
          String(b.counterparty || ""),
        ),
    );
  }

  incoming: number;
  outgoing: number;
  net: number;
  topIncoming?: Row;
  topOutgoing?: Row;
  mostFrequent?: Row;
  twoWay: Row[];

  constructor(public parties: Row[]) {
    this.incoming = parties.reduce((sum, row) => sum + number(row.incoming), 0);
    this.outgoing = parties.reduce((sum, row) => sum + number(row.outgoing), 0);
    this.net = this.incoming - this.outgoing;
    this.topIncoming = PartyReadoutData.rank(
      parties.filter((row) => number(row.incoming) > 0),
    ).sort((a, b) => number(b.incoming) - number(a.incoming))[0];
    this.topOutgoing = PartyReadoutData.rank(
      parties.filter((row) => number(row.outgoing) > 0),
    ).sort((a, b) => number(b.outgoing) - number(a.outgoing))[0];
    this.mostFrequent = PartyReadoutData.rank(
      parties.filter((row) => number(row.count) > 0),
    ).sort((a, b) => number(b.count) - number(a.count))[0];
    this.twoWay = PartyReadoutData.rank(
      parties.filter(
        (row) => number(row.incoming) > 0 && number(row.outgoing) > 0,
      ),
    );
  }

  static share(value: number, total: number) {
    return total > 0 ? `${((100 * value) / total).toFixed(1)}%` : "—";
  }
}
