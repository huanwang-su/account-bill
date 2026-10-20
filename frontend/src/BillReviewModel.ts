import { MoneyFormatter, type Row } from "./api";
import { AccountChoices } from "./AccountChoices";

export class BillAttention {
  static rows(rows: Row[]) {
    return rows.filter((row) => row.ledger_status === "PENDING");
  }
  static filters(): Row {
    return { ledger_status: "PENDING", period: "all" };
  }
}

/** Translate the two visible sides to the existing posting contract. */
export class BillReviewModel {
  constructor(
    public bill: Row,
    public accounts: Row[],
  ) {}
  get kind(): string {
    const facts = this.bill.facts;
    if (facts.settlement === "REFUNDED")
      return this.bill.refund_income ? "INCOME" : "REFUND";
    const root = this.bill.classification?.category_path?.[0];
    if (root === "内部转账" || root === "转账") return "TRANSFER";
    if (root === "收入") return "INCOME";
    if (root === "支出") return "EXPENSE";
    return facts.flow === "IN" ? "INCOME" : "EXPENSE";
  }
  initialValues(): Row {
    const incomingTransfer =
      this.kind === "TRANSFER" && this.bill.facts.flow === "IN";
    return {
      kind: this.kind,
      account_id: incomingTransfer ? undefined : this.bill.account_id,
      to_account_id: incomingTransfer
        ? this.bill.account_id
        : this.bill.to_account_id,
      amount: MoneyFormatter.input(
        this.bill.effective_amount_minor ?? this.bill.facts.amount_minor,
      ),
    };
  }
  choices() {
    return AccountChoices.rank(this.accounts)
      .filter(
        (account) =>
          account.active &&
          !account.merged_into_id &&
          ["ASSET", "LIABILITY"].includes(account.role),
      )
      .map((account) => ({ value: account.id, label: account.name }));
  }
  get counterparty(): string {
    return this.bill.facts.counterparty || "外部交易方";
  }
  static receiving(kind: string) {
    return kind === "INCOME" || kind === "REFUND";
  }
  static changeKind(
    previous: string,
    next: string,
    values: Row,
    originalFlow?: string,
  ): Row {
    const own =
      previous === "TRANSFER" && this.receiving(next)
        ? values.to_account_id
        : values.account_id;
    const incoming =
      originalFlow === "IN" ||
      (originalFlow !== "OUT" && this.receiving(previous));
    return {
      account_id: next === "TRANSFER" && incoming ? undefined : own,
      to_account_id: next === "TRANSFER" && incoming ? own : undefined,
      category_id: undefined,
      related_id: undefined,
    };
  }
  static payload(values: Row): Row {
    const payload: Row = {
      kind: values.kind,
      account_id: values.account_id,
      amount: values.amount,
    };
    if (values.kind === "TRANSFER")
      payload.to_account_id = values.to_account_id;
    else if (values.kind === "REFUND") payload.related_id = values.related_id;
    else payload.category_id = values.category_id;
    return payload;
  }
}
