import React from "react";
import {
  Button,
  Card,
  Collapse,
  Empty,
  Popconfirm,
  Space,
  Tag,
  Tree,
} from "antd";
import { PlusOutlined } from "@ant-design/icons";
import { LabelHierarchy, Row } from "./api";
interface Props {
  categories: Row[];
  tags: Row[];
  onOpen: (kind: string, row?: Row, initial?: Row) => void;
  onTagActivation: (row: Row, active: boolean) => Promise<void>;
}
export class CatalogWorkspace extends React.Component<Props> {
  node(kind: string, row: Row, rows: Row[]): any {
    const isCategory = kind === "category";
    const archived = !isCategory && row.active === false;
    return {
      key: `${kind}:${row.id}`,
      title: (
        <div className="catalog-node" data-catalog-id={`${kind}:${row.id}`}>
          <span title={new LabelHierarchy(rows).path(row.id)}>{row.name}</span>
          <span className="catalog-node-meta">
            {isCategory ? (
              !row.active && <Tag>停用</Tag>
            ) : (
              <Tag>
                {
                  (
                    {
                      ACCOUNT: "账户",
                      TRANSACTION: "交易",
                      BOTH: "通用",
                    } as Row
                  )[row.scope]
                }
              </Tag>
            )}
          </span>
          <Space size={0}>
            {!archived && (!isCategory || !row.parent_id) && (
              <Button
                type="link"
                size="small"
                aria-label={`新增${row.name}子项`}
                onClick={(e) => {
                  e.stopPropagation();
                  this.props.onOpen(
                    kind,
                    undefined,
                    isCategory
                      ? { kind: row.kind, parent_id: row.id }
                      : { scope: row.scope, parent_id: row.id },
                  );
                }}
              >
                添加子项
              </Button>
            )}
            {!archived && (
              <Button
                type="link"
                size="small"
                aria-label={`编辑${row.name}`}
                onClick={(e) => {
                  e.stopPropagation();
                  this.props.onOpen(kind, row);
                }}
              >
                编辑
              </Button>
            )}
            {!isCategory && (
              <Popconfirm
                title={
                  archived
                    ? "恢复此标签及全部子标签？"
                    : "归档此标签及全部子标签？"
                }
                description="历史账户、交易和账单中的标签保留。"
                onConfirm={() => this.props.onTagActivation(row, archived)}
                onPopupClick={(e) => e.stopPropagation()}
                okText={archived ? "恢复" : "归档"}
                okButtonProps={{
                  "aria-label": archived ? "确认恢复标签" : "确认归档标签",
                }}
                cancelText="取消"
              >
                <Button
                  type="link"
                  size="small"
                  onClick={(e) => e.stopPropagation()}
                  aria-label={`${archived ? "恢复" : "归档"}标签${row.name}`}
                >
                  {archived ? "恢复" : "归档"}
                </Button>
              </Popconfirm>
            )}
          </Space>
        </div>
      ),
      children: rows
        .filter((r) => r.parent_id === row.id)
        .map((child) => this.node(kind, child, rows)),
    };
  }
  render() {
    const { categories, tags } = this.props;
    const activeTags = tags.filter((t) => t.active !== false);
    const archivedTags = tags.filter((t) => t.active === false);
    const categoryNodes = [
      {
        key: "EXPENSE",
        title: "支出分类",
        children: categories
          .filter((c) => c.kind === "EXPENSE" && !c.parent_id)
          .sort((a, b) => Number(b.name === "宝宝") - Number(a.name === "宝宝"))
          .map((c) => this.node("category", c, categories)),
      },
      {
        key: "INCOME",
        title: "收入分类",
        children: categories
          .filter((c) => c.kind === "INCOME" && !c.parent_id)
          .map((c) => this.node("category", c, categories)),
      },
    ];
    return (
      <>
        <div className="catalog-explanation">
          <strong>分类记录钱的用途，标签补充归属与场景。</strong>
          <span>
            例如：买菜 100 元，分类选“餐饮 /
            买菜”，标签可选“家庭日常”。用途无需重复建成标签。
          </span>
        </div>
        <div className="catalog-grid catalog-trees">
          <Card
            title="收支分类"
            extra={
              <Button
                icon={<PlusOutlined />}
                onClick={() => this.props.onOpen("category")}
              >
                新建分类
              </Button>
            }
          >
            <p className="muted">
              用于收支统计，最多两级；通常一笔选一个，拆分交易可分别分类。父分类包含全部子分类。
            </p>
            <Tree
              blockNode
              selectable={false}
              defaultExpandedKeys={[
                "EXPENSE",
                "INCOME",
                ...categories
                  .filter((c) => c.name === "宝宝" && !c.parent_id)
                  .map((c) => `category:${c.id}`),
              ]}
              treeData={categoryNodes}
            />
          </Card>
          <Card
            title="辅助标签"
            extra={
              <Button
                icon={<PlusOutlined />}
                onClick={() => this.props.onOpen("tag")}
              >
                新建标签
              </Button>
            }
          >
            <p className="muted">
              用于归属、场景等补充信息，可同时选多个；按范围用于账户或交易。父标签包含全部子标签。
            </p>
            {activeTags.length ? (
              <Tree
                blockNode
                selectable={false}
                defaultExpandAll
                treeData={activeTags
                  .filter((t) => !t.parent_id)
                  .map((t) => this.node("tag", t, activeTags))}
              />
            ) : (
              <Empty description="可创建“家庭日常”“出差”等辅助标签" />
            )}
            {archivedTags.length > 0 && (
              <Collapse
                className="catalog-archive"
                items={[
                  {
                    key: "archived",
                    label: `已归档标签（${archivedTags.length}）`,
                    children: (
                      <>
                        <p className="muted">
                          仅保留历史，不出现在新标签选择或 AI
                          分类目录中。恢复父标签会同时恢复其子标签。
                        </p>
                        <Tree
                          blockNode
                          selectable={false}
                          defaultExpandAll
                          treeData={archivedTags
                            .filter(
                              (t) =>
                                !t.parent_id ||
                                !archivedTags.some((p) => p.id === t.parent_id),
                            )
                            .map((t) => this.node("tag", t, archivedTags))}
                        />
                      </>
                    ),
                  },
                ]}
              />
            )}
          </Card>
        </div>
      </>
    );
  }
}
