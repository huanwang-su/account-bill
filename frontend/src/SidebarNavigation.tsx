import React from "react";
import { Badge, Menu } from "antd";
import {
  AppstoreOutlined,
  BarChartOutlined,
  FileDoneOutlined,
  SettingOutlined,
  WalletOutlined,
} from "@ant-design/icons";
import { Navigation } from "./Navigation";

interface Props {
  page: string;
  reportTab: string;
  onNavigate: (page: string, reportTab?: string) => void;
  pendingBillCount?: number;
  onPending?: () => void;
}

export class SidebarNavigation extends React.Component<
  Props,
  { openKeys: string[] }
> {
  state = { openKeys: this.activeBranch(this.props) };
  activeBranch(props: Props) {
    const parent = Navigation.parent(
      Navigation.target(props.page, props.reportTab).key,
    );
    return parent ? [parent] : [];
  }
  componentDidUpdate(previous: Props) {
    if (
      Navigation.target(previous.page, previous.reportTab).key !==
      Navigation.target(this.props.page, this.props.reportTab).key
    )
      this.setState({ openKeys: this.activeBranch(this.props) });
  }
  label(key: string, text: string) {
    const count = this.props.pendingBillCount || 0;
    if (key !== "bills" || count === 0) return text;
    return (
      <Badge
        className="navigation-pending-badge"
        count={
          <button
            type="button"
            className="navigation-pending-count"
            title={`${count} 条待核对，点击处理`}
            aria-label={`处理 ${count} 条待核对交易`}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ")
                event.stopPropagation();
            }}
            onClick={(event) => {
              event.stopPropagation();
              if (this.props.onPending) this.props.onPending();
              else this.props.onNavigate("bills");
            }}
          >
            {count > 999 ? "999+" : count}
          </button>
        }
        offset={[12, -1]}
      >
        <span>{text}</span>
      </Badge>
    );
  }
  render() {
    const icons: Record<string, React.ReactNode> = {
      overview: <AppstoreOutlined />,
      reports: <BarChartOutlined />,
      accounts: <WalletOutlined />,
      ledger: <FileDoneOutlined />,
      management: <SettingOutlined />,
    };
    return (
      <nav className="sidebar-navigation" aria-label="账本导航">
        <Menu
          mode="inline"
          inlineIndent={16}
          selectedKeys={[
            Navigation.target(this.props.page, this.props.reportTab).key,
          ]}
          openKeys={this.state.openKeys}
          onOpenChange={(keys) =>
            this.setState({ openKeys: Navigation.openKeys(keys) })
          }
          items={Navigation.sections.map((section) => ({
            key: section.key,
            label:
              section.key === "ledger" &&
              (this.props.pendingBillCount || 0) > 0 &&
              !this.state.openKeys.includes("ledger") ? (
                <Badge dot offset={[8, 0]}>
                  {section.label}
                </Badge>
              ) : (
                section.label
              ),
            icon: icons[section.key],
            children: section.children?.map((target) => ({
              key: target.key,
              label: this.label(target.key, target.label),
            })),
          }))}
          onClick={({ key }) => {
            const target = Navigation.targets().find((t) => t.key === key);
            if (target) this.props.onNavigate(target.page, target.reportTab);
          }}
        />
      </nav>
    );
  }
}
