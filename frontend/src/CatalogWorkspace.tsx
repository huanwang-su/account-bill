import React from "react";
import { Button, Card, Empty, Space, Tag, Tree } from "antd";
import { PlusOutlined } from "@ant-design/icons";
import { LabelHierarchy, Row } from "./api";
interface Props {
  categories: Row[];
  tags: Row[];
  onOpen: (kind: string, row?: Row, initial?: Row) => void;
}
export class CatalogWorkspace extends React.Component<Props> {
  node(kind: string, row: Row, rows: Row[]): any {
    const isCategory = kind === "category";
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
            {(!isCategory || !row.parent_id) && (
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
          <p className="muted">分类按用途分层；选择父分类可包含全部子分类。</p>
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
          title="标签结构"
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
            父标签筛选包含全部子标签，账户与交易共用这份结构。
          </p>
          {tags.length ? (
            <Tree
              blockNode
              selectable={false}
              defaultExpandAll
              treeData={tags
                .filter((t) => !t.parent_id)
                .map((t) => this.node("tag", t, tags))}
            />
          ) : (
            <Empty description="新建标签后可添加子标签" />
          )}
        </Card>
      </div>
    );
  }
}
