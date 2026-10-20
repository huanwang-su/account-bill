import type { Row } from "./api";

/** Order choices without changing eligibility, identities or the source list. */
export class AccountChoices {
  static rank<T extends Row>(rows: T[], followedIds?: number[]): T[] {
    const followed = followedIds === undefined ? undefined : new Set(followedIds);
    const priority = (row: Row) =>
      Number(
        followed
          ? followed.has(Number(row.id ?? row.account_id))
          : row.is_followed === true,
      );
    return [...rows].sort((a, b) => priority(b) - priority(a));
  }
}
