/** Browser-only display preference; never changes ledger values or exports. */
export class AmountPrivacy {
  static readonly key = "ledger.hide-amounts";
  static readonly mask = "****";
  private static value: boolean | undefined;
  private static listeners = new Set<() => void>();

  static read() {
    try {
      return localStorage.getItem(this.key) === "true";
    } catch {
      return false;
    }
  }
  static hidden = () => (this.value ??= this.read());
  static apply() {
    if (typeof document !== "undefined")
      document.documentElement.dataset.amountsHidden = String(this.hidden());
  }
  static set(hidden: boolean) {
    this.value = hidden;
    try {
      localStorage.setItem(this.key, String(hidden));
    } catch {
      // The preference still works if browser storage is unavailable.
    }
    this.notify();
  }
  private static notify() {
    this.apply();
    for (const listener of this.listeners) listener();
  }
  private static onStorage = (event: StorageEvent) => {
    if (event.key !== null && event.key !== this.key) return;
    this.value = event.key === null ? this.read() : event.newValue === "true";
    this.notify();
  };
  static subscribe = (listener: () => void) => {
    if (!this.listeners.size && typeof window !== "undefined")
      window.addEventListener("storage", this.onStorage);
    this.listeners.add(listener);
    this.apply();
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size && typeof window !== "undefined")
        window.removeEventListener("storage", this.onStorage);
    };
  };
  /** Redact structured source amount fields without hiding dates, IDs or counts. */
  static fields(value: any, key = ""): any {
    if (!this.hidden()) return value;
    if (
      /金额|余额|本金|利息|手续费|收益|盈亏|(?:^|_)(?:amount|balance|income|expense|profit|loss|refund|fee)(?:_|$)/i.test(
        key,
      )
    )
      return this.mask;
    if (Array.isArray(value)) return value.map((item) => this.fields(item));
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([name, item]) => [
          name,
          this.fields(item, name),
        ]),
      );
    return value;
  }
}
