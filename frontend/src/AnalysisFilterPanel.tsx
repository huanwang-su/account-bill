import React from "react";
import { Button, Tag } from "antd";
import { AccountGroupTree, CategoryTree, Row } from "./api";

interface FilterItem {
  key: string;
  label: string;
  clear: Row;
}

interface SelectionSources {
  accounts: Row[];
  groups: Row[];
  categories: Row[];
}

/** Describe the current query without owning or changing its filter state. */
export class AnalysisFilterSelection {
  constructor(
    private filters: Row,
    private sources: SelectionSources,
  ) {}

  items(): FilterItem[] {
    const { filters, sources } = this;
    const items: FilterItem[] = [];
    if (this.hasValue(filters.group_id))
      items.push({
        key: "group",
        label: `账户组：${filters.group_id === 0 ? "未分组" : new AccountGroupTree(sources.groups).path(filters.group_id) || `#${filters.group_id}`}`,
        clear: { group_id: undefined, direct_group: undefined },
      });
    if (this.hasValue(filters.account_id))
      items.push({
        key: "account",
        label: `账户：${sources.accounts.find((account) => account.id === filters.account_id)?.name || `#${filters.account_id}`}`,
        clear: { account_id: undefined },
      });
    if (this.hasValue(filters.category_id))
      items.push({
        key: "category",
        label: `分类：${filters.category_id === 0 ? "未分类" : filters.category_id === -1 ? "退款抵减" : new CategoryTree(sources.categories).path(filters.category_id) || `#${filters.category_id}`}`,
        clear: { category_id: undefined, exact_category: undefined },
      });
    if (this.hasValue(filters.tag))
      items.push({
        key: "tag",
        label: `标签：${filters.tag}`,
        clear: { tag: undefined },
      });
    if (filters.direct_group && this.hasValue(filters.group_id))
      items.push({
        key: "direct-group",
        label: "仅当前组直属账户",
        clear: { group_id: undefined, direct_group: undefined },
      });
    if (filters.exact_category)
      items.push({
        key: "exact-category",
        label: "仅此分类（不含下级）",
        clear: { exact_category: undefined },
      });
    return items;
  }

  private hasValue(value: unknown) {
    return value !== undefined && value !== null && value !== "";
  }
}

interface Props {
  id: string;
  label: string;
  primary: React.ReactNode;
  advanced: React.ReactNode;
  summary: FilterItem[];
  reset: React.ReactNode;
  onClear: (patch: Row) => void;
}

interface State {
  expanded: boolean;
}

/** Keep query ownership in each workspace, and disclosure state in this panel. */
export class AnalysisFilterPanel extends React.Component<Props, State> {
  state: State = { expanded: false };

  render() {
    const { id, label, primary, advanced, summary, reset, onClear } =
      this.props;
    const { expanded } = this.state;
    const advancedId = `${id}-advanced`;
    return (
      <section className="analysis-filter-panel" aria-label={`${label}筛选`}>
        <div className="analysis-filter-primary">
          <div className="analysis-filter-common">{primary}</div>
          <div className="analysis-filter-actions">
            <Button
              htmlType="button"
              aria-expanded={expanded}
              aria-controls={advancedId}
              onClick={() => this.setState({ expanded: !expanded })}
            >
              {expanded ? "收起高级筛选" : "展开高级筛选"}
              {summary.length > 0 ? `（${summary.length}）` : ""}
            </Button>
            {reset}
          </div>
        </div>
        <div
          id={advancedId}
          className="analysis-filter-advanced"
          hidden={!expanded}
        >
          {advanced}
        </div>
        <div className="analysis-filter-summary" aria-live="polite">
          {summary.length ? (
            <>
              <strong>已选 {summary.length} 项高级条件</strong>
              {summary.map((item) => (
                <Tag
                  key={item.key}
                  closable
                  onClose={(event) => {
                    event.preventDefault();
                    onClear(item.clear);
                  }}
                >
                  {item.label}
                </Tag>
              ))}
              <small className="muted">
                {expanded ? "以上条件已生效" : "高级条件已收起，以上筛选仍生效"}
              </small>
            </>
          ) : (
            <small className="muted">未使用高级条件</small>
          )}
        </div>
      </section>
    );
  }
}
