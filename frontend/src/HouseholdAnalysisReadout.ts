import { MoneyFormatter as Money, type Row } from "./api";

export type HouseholdFindingTarget =
  | { kind: "category"; id: number }
  | { kind: "tab"; key: string }
  | { kind: "transaction"; id: number };

export interface HouseholdFinding {
  key: string;
  label: string;
  value: string;
  detail: string;
  tone?: "neutral" | "positive" | "negative" | "warning";
  target?: HouseholdFindingTarget;
  actionLabel?: string;
}

/** Evidence from the active report only; net amounts and gross activity stay separate. */
export class HouseholdAnalysisReadout {
  static number(value: unknown) {
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
  }

  static percentage(
    numerator: number,
    denominator: number,
  ): string | undefined {
    if (
      !Number.isFinite(numerator) ||
      !Number.isFinite(denominator) ||
      !(denominator > 0) ||
      numerator < 0 ||
      numerator > denominator
    )
      return undefined;
    const percent = (numerator / denominator) * 100;
    if (percent > 0 && percent < 0.1) return "<0.1%";
    if (percent > 99.9 && numerator < denominator) return ">99.9%";
    return `${percent.toFixed(1)}%`;
  }

  private static positive(rows: Row[] = []) {
    return rows
      .filter((row) => this.number(row.amount) > 0)
      .slice()
      .sort(
        (a, b) =>
          b.amount - a.amount ||
          String(a.name || "").localeCompare(String(b.name || "")),
      );
  }

  private static sum(rows: Row[], field = "amount") {
    return rows.reduce((total, row) => total + this.number(row[field]), 0);
  }

  private static category(
    rows: Row[],
    label: string,
    key: string,
  ): HouseholdFinding | undefined {
    const positive = this.positive(rows);
    const top = positive[0];
    if (!top) return undefined;
    const total = this.sum(positive);
    const share = this.percentage(top.amount, total);
    const expense = key === "expense-category";
    return {
      key,
      label,
      value: `${top.name}${share ? ` · ${share}` : ""}`,
      detail: expense
        ? `该分类净支出 ¥ ${Money.format(top.amount)}，占正额分类合计 ¥ ${Money.format(total)} 的${share || "主要部分"}；负额退款抵减另列。`
        : `该分类收入 ¥ ${Money.format(top.amount)}，占正额收入分类合计的${share || "主要部分"}。`,
      target: top.id > 0 ? { kind: "category", id: top.id } : undefined,
      actionLabel: "查看该分类明细",
    };
  }

  static income(report: Row): HouseholdFinding[] {
    if (!(this.number(report.income) > 0)) return [];
    const findings: HouseholdFinding[] = [];
    const category = this.category(
      report.categories || [],
      "收入主要来自哪一类",
      "income-category",
    );
    if (category) findings.push(category);
    const sources = this.positive(report.sources || []);
    if (sources.length) {
      const top = sources.slice(0, 2);
      const total = this.sum(top);
      const share = this.percentage(total, report.income);
      const unnamed = sources.find((row) => row.name === "未填写交易方");
      findings.push({
        key: "income-concentration",
        label: top.length === 1 ? "记录中的交易方集中度" : "前两交易方贡献多少",
        value: `${top.length === 1 ? "1 组交易方记录" : "前 2 组交易方记录"}${share ? `贡献 ${share}` : `合计 ¥ ${Money.format(total)}`}`,
        detail: `合计收入 ¥ ${Money.format(total)}，按当前填写的交易方归并，空白合并列示。${unnamed ? `全期“未填写交易方”合计 ¥ ${Money.format(unnamed.amount)}，实际来源仍需补充。` : `本期共记录 ${sources.length} 个有收入的交易方。`}`,
        tone: unnamed ? "warning" : "neutral",
        target: { kind: "tab", key: "sources" },
        actionLabel: "核对收入交易方",
      });
    }
    const large = this.number(report.large_income);
    if (large > 0) {
      const share = this.percentage(large, report.income);
      findings.push({
        key: "income-large-share",
        label: "大额收入影响有多大",
        value: share
          ? `贡献本期收入的 ${share}`
          : `合计 ¥ ${Money.format(large)}`,
        detail: `${this.number(report.large_count)} 笔收入达到 ¥ ${Money.format(report.large_amount_minor)} 门槛，合计 ¥ ${Money.format(large)}；占比按本期收入总额计算。`,
        target: { kind: "tab", key: "large" },
        actionLabel: "查看大额收入",
      });
    }
    return findings.slice(0, 3);
  }

  static expense(report: Row): HouseholdFinding[] {
    const findings: HouseholdFinding[] = [];
    const parents: Row[] = report.parents || [];
    const category = this.category(
      parents,
      "主要花在哪一类",
      "expense-category",
    );
    if (category) findings.push(category);
    if (report.previous_start && report.previous_end) {
      const changes = parents
        .filter(
          (row) =>
            typeof row.previous_amount === "number" &&
            Number.isFinite(row.previous_amount) &&
            typeof row.change === "number" &&
            Number.isFinite(row.change) &&
            row.change !== 0,
        )
        .slice()
        .sort((a, b) => Math.abs(b.change) - Math.abs(a.change));
      const driver = changes[0];
      if (driver)
        findings.push({
          key: "expense-driver",
          label: "哪类金额变动最明显",
          value: `${driver.name}：${driver.change > 0 ? "增加" : "减少"} ¥ ${Money.format(Math.abs(driver.change))}`,
          detail: `本期该分类净额 ¥ ${Money.format(driver.amount)}，等长上期为 ¥ ${Money.format(driver.previous_amount)}。这里只比较已入账金额。`,
          target:
            driver.id >= -1 ? { kind: "category", id: driver.id } : undefined,
          actionLabel: "核对变动明细",
        });
    }
    const unknown = parents.filter((row) =>
      ["未知用途", "未分类"].includes(row.name),
    );
    const unknownPaid = this.sum(unknown, "paid");
    if (unknownPaid > 0) {
      const share = this.percentage(unknownPaid, this.number(report.paid));
      findings.push({
        key: "expense-unknown",
        label: "还有多少付款用途待补充",
        value: `¥ ${Money.format(unknownPaid)}${share ? ` · ${share}` : ""}`,
        detail: `按付款原额计算${share ? `，占本期付款的 ${share}` : ""}；退款不从这个分母中扣除，便于核对分类覆盖。`,
        tone: "warning",
        target:
          unknown.length === 1 && unknown[0].id >= 0
            ? { kind: "category", id: unknown[0].id }
            : { kind: "tab", key: "categories" },
        actionLabel: "核对待补用途",
      });
    } else {
      const frequent: Row[] = (report.merchants || []).filter(
        (row: Row) => this.number(row.count) >= 3,
      );
      const count = this.sum(frequent, "count");
      if (frequent.length && count > 0) {
        const share = this.percentage(count, this.number(report.count));
        findings.push({
          key: "expense-frequency",
          label: "重复付款累积了多少",
          value: `${frequent.length} 个交易方 · ${count} 笔付款`,
          detail: `每个交易方至少付款 3 次${share ? `，合计占付款笔数的 ${share}` : ""}；含退款抵减后的合计净额为 ¥ ${Money.format(this.sum(frequent))}。`,
          target: { kind: "tab", key: "merchants" },
          actionLabel: "查看付款频次",
        });
      }
    }
    if (findings.length < 3 && this.number(report.large_paid) > 0) {
      const share = this.percentage(
        report.large_paid,
        this.number(report.paid),
      );
      findings.push({
        key: "expense-large-share",
        label: "大额付款占多少支出原额",
        value: share || `¥ ${Money.format(report.large_paid)}`,
        detail: `达到当前门槛的付款合计 ¥ ${Money.format(report.large_paid)}；分母为付款原额 ¥ ${Money.format(report.paid)}，退款另作抵减。`,
        target: { kind: "tab", key: "large" },
        actionLabel: "查看大额付款",
      });
    }
    return findings.slice(0, 3);
  }

  static financial(report: Row): HouseholdFinding[] {
    const findings: HouseholdFinding[] = [];
    const income = this.category(
      report.categories?.income || [],
      "收入主要由哪类构成",
      "income-category",
    );
    const expense = this.category(
      report.categories?.expense || [],
      "正额支出主要花在哪",
      "expense-category",
    );
    if (income) findings.push(income);
    if (expense) findings.push(expense);
    const transactions: Row[] = report.transactions || [];
    const large: Row[] = report.large_transactions || [];
    const gross = transactions.reduce(
      (total, row) => total + Math.abs(this.number(row.amount)),
      0,
    );
    const largeGross = large.reduce(
      (total, row) => total + Math.abs(this.number(row.amount)),
      0,
    );
    if (largeGross > 0 && gross > 0) {
      const share = this.percentage(largeGross, gross);
      const biggest = large
        .slice()
        .sort(
          (a, b) =>
            Math.abs(this.number(b.amount)) - Math.abs(this.number(a.amount)),
        )[0];
      findings.push({
        key: "financial-large-share",
        label: "大额交易集中了多少金额",
        value: share
          ? `占交易金额合计的 ${share}`
          : `合计 ¥ ${Money.format(largeGross)}`,
        detail: `大额交易合计 ¥ ${Money.format(largeGross)}；全部交易金额 ¥ ${Money.format(gross)} 按收入、付款和退款的单笔金额相加，不抵销正负。`,
        target: biggest?.id
          ? { kind: "transaction", id: biggest.id }
          : undefined,
        actionLabel: "查看金额最大一笔",
      });
    }
    return findings.slice(0, 3);
  }

  static incomeSummary(report: Row) {
    if (!(this.number(report.income) > 0))
      return "当前筛选下没有正向收入记录，可先核对日期和账户范围。";
    const categories = this.positive(report.categories || []);
    return categories.length
      ? `本期收入分布在 ${categories.length} 个当前层级分类，${categories[0].name}金额最大；以下结论使用当前整段统计范围。`
      : "本期已有收入入账，下面核对已记录的交易方和大额收入贡献。";
  }

  static expenseSummary(report: Row) {
    if (this.number(report.expense) < 0)
      return "本期退款抵减超过付款，净支出为负；正额用途与退款抵减需分开查看。";
    if (!this.number(report.paid) && !this.number(report.refunds))
      return "当前筛选下没有已入账开支，可先核对日期和账户范围。";
    const categories = this.positive(report.parents || []);
    return categories.length
      ? `正额净支出分布在 ${categories.length} 类用途，${categories[0].name}金额最大；退款净抵减另列。`
      : "本期付款与退款抵减后没有正额用途分类，可从交易明细核对抵减情况。";
  }

  static financialSummary(report: Row) {
    if (!this.number(report.count))
      return "当前筛选下没有已入账收支，可先核对日期、账户和分类条件。";
    if (this.number(report.expense) < 0)
      return "本期支出端为退款净抵减，净收支也包含这部分影响；先分开看收入来源与正额用途。";
    const net = this.number(report.net);
    return `本期收入与净支出相抵后${net > 0 ? "有结余" : net < 0 ? "为缺口" : "持平"}；下面核对主要构成和大额交易集中度。`;
  }

  static periodNote(
    report: Row,
    filters: Row,
    today: string,
    comparison = true,
  ) {
    const start = report.start || filters.start;
    const end = report.end || filters.end;
    const partial =
      start && end && start <= today && end >= today
        ? "区间包含今天或后续日期，仅反映当前已入账记录。"
        : "按当前筛选下的已入账记录分析。";
    return (
      partial +
      (comparison
        ? "上期是紧邻本期的等长日期区间，期间尚未结束时不代表完整月度对比。"
        : "本页未提供上期基准，不作环比判断。")
    );
  }
}
