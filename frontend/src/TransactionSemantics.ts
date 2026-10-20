import type { Row } from "./api";

export class TransactionSemantics {
  static isValuation(row?: Row) {
    // The fallback accepts old exported report fixtures without a purpose field.
    return (
      !!row &&
      (row.purpose
        ? row.purpose === "VALUATION"
        : row.source === "证券余额更新")
    );
  }
}
