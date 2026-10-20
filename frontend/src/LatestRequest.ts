import type { LedgerApi } from "./api";

/** Shared cancellation and stale-response guard for report/filter loaders. */
export class LatestRequest {
  private version = 0;
  constructor(private api?: LedgerApi) {}
  begin() {
    this.api?.cancelReads?.();
    return ++this.version;
  }
  current(version: number) {
    return version === this.version;
  }
  dispose() {
    ++this.version;
    this.api?.cancelReads?.();
  }
}
