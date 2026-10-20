import React from "react";
import { StatisticTone as Tone } from "./StatisticTone";
import { Card, Empty, Select, Tag } from "antd";
import { DisplayMoneyFormatter as Money, type Row } from "./api";
import { AccountDistribution } from "./AccountDistribution";
import { AccountMovementDistribution } from "./AccountMovementDistribution";
import { AnalysisDrilldownBar } from "./AnalysisDrilldown";
import { AnalysisDetailFocus } from "./AnalysisDetailFocus";
import { DistributionDiagram } from "./DistributionDiagram";
import { PagedTable } from "./PagedTable";

interface Props {
  report: Row;
  groups: Row[];
}
interface State {
  selection?: Row;
  changedOnly: boolean;
}

/** Complete account-period movements stay separate from transaction filters. */
export class AccountMovementSection extends React.Component<Props, State> {
  detailFocus = new AnalysisDetailFocus();
  state: State = { changedOnly: false };

  componentDidUpdate(previous: Props) {
    if (this.scopeKey(previous.report) !== this.scopeKey(this.props.report)) {
      this.detailFocus.cancel();
      if (this.state.selection || this.state.changedOnly)
        this.setState({ selection: undefined, changedOnly: false });
    }
  }

  componentWillUnmount() {
    this.detailFocus.cancel();
  }

  scopeKey(report: Row = this.props.report) {
    return JSON.stringify([
      report.start_at ?? report.start,
      report.end_at ?? report.end,
      report.applied_filters?.account_id ?? null,
      report.applied_filters?.group_id ?? null,
      (report.accounts || [])
        .map((row: Row) => row.id)
        .sort((a: number, b: number) => a - b),
    ]);
  }

  select(selection: Row) {
    if (
      !["movement:increase", "movement:decrease"].includes(selection.namespace)
    )
      return;
    this.detailFocus.request();
    this.setState({ selection: { ...selection } }, () =>
      this.detailFocus.afterRender(),
    );
  }

  clearSelection() {
    this.detailFocus.cancel();
    this.setState({ selection: undefined });
  }

  rows(
    distribution = new AccountMovementDistribution(
      this.props.report,
      this.props.groups,
    ),
  ): Row[] {
    return distribution
      .rows(this.state.selection)
      .filter(
        (row: Row) => !this.state.changedOnly || row.operating_change !== 0,
      )
      .sort(
        (a: Row, b: Row) =>
          Math.abs(b.operating_change) - Math.abs(a.operating_change) ||
          a.id - b.id,
      );
  }

  amount(value: number, change = false) {
    return (
      <span
        className={`account-movement-money${value < 0 ? " is-negative" : ""}`}
      >
        {change && value > 0 ? "+" : ""}
        {Money.format(value)}
      </span>
    );
  }

  breakdown(account: Row) {
    const amounts = AccountMovementDistribution.amounts(account);
    const matches =
      account.opening_balance +
        amounts.opening_added +
        amounts.operating_inflow -
        amounts.operating_outflow ===
      account.ending_balance;
    return (
      <div className="account-movement-breakdown">
        <p className="account-movement-equation">
          <strong>余额核对</strong>
          <span>
            期初净值 {Money.format(account.opening_balance)} ＋ 期初录入{" "}
            {Money.format(amounts.opening_added)} ＋ 期间增加额{" "}
            {Money.format(amounts.operating_inflow)} － 期间减少额{" "}
            {Money.format(amounts.operating_outflow)} {matches ? "＝" : "≠"}{" "}
            期末净值 {Money.format(account.ending_balance)}
          </span>
          <Tag>
            {matches && account.reconciled !== false ? "一致" : "待核对"}
          </Tag>
        </p>
        {account.composite &&
          [
            "opening_assets",
            "opening_liabilities",
            "ending_assets",
            "ending_liabilities",
          ].every((key) => Number.isFinite(account[key])) && (
            <div className="account-movement-composite">
              <p>
                综合账户账面拆分 · 期初 →
                期末（含期初录入，元），负债部分按欠款金额列示
              </p>
              <dl>
                <div>
                  <dt>资产部分</dt>
                  <dd>
                    {this.amount(account.opening_assets)} →{" "}
                    {this.amount(account.ending_assets)}
                  </dd>
                </div>
                <div>
                  <dt>负债部分</dt>
                  <dd>
                    {this.amount(account.opening_liabilities)} →{" "}
                    {this.amount(account.ending_liabilities)}
                  </dd>
                </div>
              </dl>
            </div>
          )}
        {account.breakdown?.length ? (
          <div className="account-movement-breakdown-scroll">
            <table>
              <caption>
                {account.name}的账面变动构成（期初单列，含冲销）· 金额单位：元
              </caption>
              <thead>
                <tr>
                  <th scope="col">变动类型</th>
                  <th scope="col">增加额</th>
                  <th scope="col">减少额</th>
                  <th scope="col">净变动</th>
                  <th scope="col">笔数</th>
                </tr>
              </thead>
              <tbody>
                {(account.breakdown || []).map((row: Row, index: number) => (
                  <tr key={`${row.kind}-${index}`}>
                    <th scope="row">
                      {row.label}
                      {row.kind === "OPENING" && <Tag>不计期间变动</Tag>}
                    </th>
                    <td>{this.amount(row.inflow)}</td>
                    <td>{this.amount(row.outflow)}</td>
                    <td>{this.amount(row.net_change, true)}</td>
                    <td>{row.transaction_count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="account-movement-description">本期没有账面变动分录。</p>
        )}
      </div>
    );
  }

  ignoredFilters() {
    const names: Record<string, string> = {
      category: "交易分类",
      categories: "交易分类",
      category_id: "交易分类",
      exact_category: "交易分类",
      tag: "交易标签",
      tags: "交易标签",
      tag_id: "交易标签",
      account_tag: "账户标签",
      q: "交易搜索",
      kind: "交易类型",
      min_amount: "交易金额",
      max_amount: "交易金额",
      excluded_account_ids: "交易排除账户",
      direct_group: "交易直属组",
    };
    return [
      ...new Set(
        (this.props.report.ignored_filters || []).map(
          (name: string) => names[name] || "其他交易条件",
        ),
      ),
    ].join("、");
  }

  render() {
    const { report, groups } = this.props;
    const { selection, changedOnly } = this.state;
    const distribution = new AccountMovementDistribution(report, groups);
    const accounts = distribution.accounts;
    const totals = { ...report.totals };
    const excludedCount =
      report.account_scope?.excluded_account_ids?.length || 0;
    const assets = Number.isFinite(totals.ending_assets)
      ? totals.ending_assets
      : accounts.reduce(
          (sum, row) =>
            sum +
            (row.ending_assets ??
              (row.role === "ASSET" ? row.ending_balance : 0)),
          0,
        );
    const liabilities = Number.isFinite(totals.ending_liabilities)
      ? totals.ending_liabilities
      : accounts.reduce(
          (sum, row) =>
            sum +
            (row.ending_liabilities ??
              (row.role === "LIABILITY" ? -row.ending_balance : 0)),
          0,
        );
    for (const key of [
      "opening_added",
      "operating_change",
      "operating_inflow",
      "operating_outflow",
    ])
      if (!Number.isFinite(totals[key]))
        totals[key] = accounts.reduce((sum, row) => sum + row[key], 0);
    const rows = this.rows(distribution);
    const selectedChange = rows.reduce(
      (sum, row) => sum + row.operating_change,
      0,
    );
    const selectedOpening = rows.reduce(
      (sum, row) => sum + row.opening_added,
      0,
    );
    const selectedEnding = rows.reduce(
      (sum, row) => sum + row.ending_balance,
      0,
    );
    const zeroCount = distribution.zeroCount;
    const ignored = this.ignoredFilters();
    const missingOpening = report.missing_opening_ids?.length || 0;
    const range = report.start
      ? `${report.start} 至 ${report.end || "当前"}`
      : report.end
        ? `最早记录至 ${report.end}`
        : "全部记录期间";
    const scopeItems = selection
      ? [
          {
            key: "movement",
            label:
              selection.label ||
              (selection.namespace === "movement:increase"
                ? "期间净增加账户"
                : "期间净减少账户"),
            onClear: () => this.clearSelection(),
          },
        ]
      : [];
    return (
      <section className="account-movement-section" aria-label="账户期间变动">
        <header className="account-movement-heading">
          <div>
            <h2>账户期间变动</h2>
            <p>{range} · 金额单位：元</p>
          </div>
          <span>{accounts.length} 个资金账户</span>
        </header>
        <p className="account-movement-scope">
          按所选日期、账户组、账户及账户屏蔽条件计算范围内余额；期间增减剔除期初录入，分类等交易筛选条件不参与计算。
        </p>
        {excludedCount > 0 && (
          <p className="account-movement-ignored" role="note">
            已屏蔽 {excludedCount}{" "}
            个账户，下方是所选范围净值，不是完整家庭净资产。屏蔽资产账户后，范围内负债仍保留。
          </p>
        )}
        {ignored && (
          <p className="account-movement-ignored" role="note">
            当前{ignored}条件已忽略，下方仍展示所选账户的完整期间余额与变动。
          </p>
        )}
        {missingOpening > 0 && (
          <p className="account-movement-opening" role="note">
            {missingOpening}{" "}
            个账户未完成期初设置，所示余额以已记录分录累计计算。
          </p>
        )}
        <div className="account-movement-summary">
          <div
            className="account-movement-stat"
            data-tone={Tone.of(totals.opening_balance)}
          >
            <span>所选范围期初净值</span>
            <strong className="account-movement-stat-value">
              ¥ {Money.format(totals.opening_balance)}
            </strong>
            <small>范围内资金账户期初账面净额</small>
          </div>
          <div
            className="account-movement-stat"
            data-tone={Tone.of(totals.ending_balance)}
          >
            <span>所选范围期末净值</span>
            <strong className="account-movement-stat-value">
              ¥ {Money.format(totals.ending_balance)}
            </strong>
            <small>范围内资产 − 范围内负债，负值不表示期间亏损</small>
          </div>
          <div
            className="account-movement-stat"
            data-tone={Tone.of(totals.operating_change, "net")}
          >
            <span>期间净变动（剔除期初）</span>
            <strong className="account-movement-stat-value">
              ¥ {totals.operating_change > 0 ? "+" : ""}
              {Money.format(totals.operating_change)}
            </strong>
            <small>期末减期初、再扣期初录入；包含估值等期间变动</small>
          </div>
        </div>
        <div
          className="account-movement-position-equation"
          aria-label="所选范围资产负债核对"
        >
          <span>
            期末资产 <strong>¥ {Money.format(assets)}</strong>
          </span>
          <b>−</b>
          <span>
            期末负债 <strong>¥ {Money.format(liabilities)}</strong>
          </span>
          <b>＝</b>
          <span>
            范围期末净值{" "}
            <strong>¥ {Money.format(totals.ending_balance)}</strong>
          </span>
          {totals.ending_balance < 0 && (
            <small>纳入的负债高于资产；期间变化看右上方“期间净变动”。</small>
          )}
        </div>
        <p className="account-movement-description">
          期末与期初账面差额 ¥ {Money.format(totals.net_change)} ＝ 期初录入 ¥{" "}
          {Money.format(totals.opening_added)} ＋ 期间净变动 ¥{" "}
          {Money.format(totals.operating_change)}
          。期初录入只补充历史余额，不计入下图或期间增减。
        </p>
        <Card
          className="account-movement-flow"
          title="期间净变动贡献（剔除期初）"
        >
          <p className="account-movement-description">
            展示剔除期初录入后各账户的期间净变动，不表示账户之间的转账路径。所选账户之间的转账在合计中互抵，期间净变动不等于收益。
          </p>
          {distribution.nodes.length ? (
            <DistributionDiagram
              data={distribution}
              columns={["期间净变动", "账户组", "账户标签", "账户"]}
              label={`期间净变动贡献桑基图（剔除期初）：期间净变动、直属账户组、账户标签、账户；增减绝对值合计 ${Money.format(distribution.positiveTotal)} 元`}
              onSelect={(value) => this.select(value)}
            />
          ) : (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={
                accounts.length
                  ? "剔除期初录入后，各账户期间净变动均为零"
                  : "当前范围没有资金账户"
              }
            />
          )}
          <p className="account-movement-description">
            期间增减幅度＝期间净增加合计＋期间净减少绝对值合计，已剔除期初录入，图中线宽与占比共用这一基数。账户组按直属归属拆分，父子组不重复累计。点击节点或连线筛选下方账户。
            {zeroCount > 0 &&
              `${zeroCount} 个零期间净变动账户不绘图，仍可在明细查看。`}
          </p>
        </Card>
        <Card
          className="account-movement-details"
          title="各账户变动明细"
          extra={
            <Select
              aria-label="账户变动明细显示范围"
              value={changedOnly ? "changed" : "all"}
              options={[
                { value: "all", label: "全部账户（含零期间净变动）" },
                { value: "changed", label: "仅期间净变动账户" },
              ]}
              onChange={(value) => {
                this.detailFocus.cancel();
                this.setState({ changedOnly: value === "changed" });
              }}
            />
          }
        >
          <AnalysisDrilldownBar
            elementRef={this.detailFocus.ref}
            label="账户明细范围"
            items={scopeItems}
            onReset={() => this.clearSelection()}
            resetLabel="清除图表联动"
            emptyText="显示完整账户范围；点击上图可按增减方向、账户组、标签或账户查看。"
          />
          <p className="account-movement-table-note" aria-live="polite">
            <span>
              显示 {rows.length} / {accounts.length}{" "}
              个账户，默认按期间净变动绝对值排列。
              {changedOnly && "已隐藏零期间净变动账户。"}
            </span>
            <span>
              本区期间净变动{" "}
              <strong>{this.amount(selectedChange, true)}</strong>
            </span>
            <span>
              本区期初录入 <strong>{this.amount(selectedOpening, true)}</strong>
            </span>
            <span>
              本区期末净值 <strong>{this.amount(selectedEnding)}</strong>
            </span>
          </p>
          <PagedTable<Row>
            rowKey="id"
            dataSource={rows}
            defaultPageSize={10}
            pageResetKey={JSON.stringify([
              this.scopeKey(),
              changedOnly,
              selection,
            ])}
            size="middle"
            scroll={{ x: 1665 }}
            expandable={{
              expandedRowRender: (row) => this.breakdown(row),
              rowExpandable: (row) =>
                !!row.breakdown?.length || !!row.composite,
              columnWidth: 38,
            }}
            locale={{
              emptyText: "当前明细范围没有账户，可清除图表联动或切换全部账户。",
            }}
            columns={[
              {
                title: "账户",
                dataIndex: "name",
                width: 220,
                render: (_, row) => (
                  <div className="account-movement-account">
                    <strong>{row.name}</strong>
                    <div>
                      {row.composite && <Tag>综合账户</Tag>}
                      {!row.active && <Tag>停用</Tag>}
                      {row.opening_set === false && <Tag>期初未设置</Tag>}
                      {row.reconciled === false && <Tag>待核对</Tag>}
                    </div>
                  </div>
                ),
              },
              {
                title: "账户类型 / 标签",
                width: 170,
                render: (_, row) => (
                  <div className="account-movement-type">
                    <span>{row.kind}</span>
                    <Tag>{AccountMovementDistribution.tag(row).label}</Tag>
                  </div>
                ),
              },
              {
                title: "直属账户组",
                width: 190,
                render: (_, row) =>
                  AccountDistribution.path(groups, row.group_id) || "未分组",
              },
              ...[
                ["opening_balance", "期初"],
                ["opening_added", "期初录入"],
                ["operating_inflow", "期间增加额"],
                ["operating_outflow", "期间减少额"],
                ["operating_change", "期间净变动"],
                ["ending_balance", "期末"],
              ].map(([key, title]) => ({
                title: `${title}（元）`,
                dataIndex: key,
                align: "right" as const,
                width: 155,
                sorter: (a: Row, b: Row) => a[key] - b[key],
                render: (value: number) =>
                  this.amount(
                    value,
                    ["operating_change", "opening_added"].includes(key),
                  ),
              })),
              {
                title: "账面笔数",
                dataIndex: "transaction_count",
                align: "right",
                width: 78,
              },
            ]}
          />
          <p className="account-movement-description">
            期初净值 ＋ 期初录入 ＋ 期间增加额 － 期间减少额 ＝
            期末净值。期初录入不计入期间增减。资产增加或欠款减少记增加，资产减少或欠款增加记减少；负债欠款以负数列示，综合账户显示净额。展开查看原始账面构成，包含期初录入、原记录及冲销，不等同于有效业务收支。账面笔数包含期初与冲销，按账户去重，同一交易可涉及多个账户。
          </p>
        </Card>
      </section>
    );
  }
}
