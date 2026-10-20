import { TransactionSemantics } from "./TransactionSemantics";
import type { Row } from "./api";

/** The reconciliation view follows its transaction filters, including valuation. */
export class ReportDetailReading {
  constructor(
    public summary: Row,
    public transactions: Row[],
  ) {}

  count(kind: string) {
    return this.transactions.filter((row) => row.kind === kind).length;
  }

  get refunds() {
    return this.transactions
      .filter((row) => row.kind === "REFUND")
      .reduce((sum, row) => sum + row.amount, 0);
  }

  get valuationCount() {
    return this.transactions.filter((row) =>
      TransactionSemantics.isValuation(row),
    ).length;
  }

  get categoriesByImpact(): Row[] {
    return [...(this.summary.categories || [])]
      .filter((row) => row.value !== 0)
      .sort((a, b) => Math.abs(b.value) - Math.abs(a.value) || a.id - b.id);
  }
}
