import React from "react";
import { App as AntApp, Card, ConfigProvider, theme } from "antd";
import { CheckOutlined } from "@ant-design/icons";
import zhCN from "antd/locale/zh_CN";
import {
  appearancePalettes,
  AppearanceMode,
  ResolvedAppearance,
} from "./AppearancePalette";

export type {
  AppearanceColors,
  AppearanceMode,
  ResolvedAppearance,
} from "./AppearancePalette";

export class Appearance {
  static key = "ledger.appearance";
  static options = [
    ...this.resolvedOptions(),
    {
      value: "system" as const,
      label: "跟随系统",
      description: "跟随设备的浅色或深色外观",
    },
  ];
  static resolvedOptions() {
    return (Object.keys(appearancePalettes) as ResolvedAppearance[]).map(
      (value) => ({
        value,
        label: appearancePalettes[value].label,
        description: appearancePalettes[value].description,
      }),
    );
  }
  static valid(value: unknown): value is AppearanceMode {
    return this.options.some((o) => o.value === value);
  }
  static read(): AppearanceMode {
    try {
      const value = localStorage.getItem(this.key);
      return this.valid(value) ? value : "forest";
    } catch {
      return "forest";
    }
  }
  static resolve(mode: AppearanceMode, dark = false): ResolvedAppearance {
    return mode === "system" ? (dark ? "dark" : "forest") : mode;
  }
  static isDark(mode: ResolvedAppearance) {
    return mode === "dark" || mode === "midnight";
  }
  static colors(mode: ResolvedAppearance) {
    return appearancePalettes[mode].colors;
  }
  static variables(mode: ResolvedAppearance) {
    const colors = this.colors(mode);
    return {
      "--canvas": colors.canvas,
      "--surface": colors.surface,
      "--surface-muted": colors.soft,
      "--text": colors.text,
      "--muted": colors.muted,
      "--primary": colors.primary,
      "--accent-rgb": colors.accentRgb,
      "--border": colors.border,
      "--hero-bg": colors.hero,
      "--hero-end": colors.heroEnd,
      "--hero-muted": colors.heroMuted,
      "--on-accent": colors.onAccent,
      "--on-primary": colors.onPrimary,
      "--positive": colors.positive,
      "--negative": colors.negative,
      "--warning": colors.warning,
      "--expense": colors.expense,
      "--shadow": colors.shadow,
    };
  }
  static apply(mode: ResolvedAppearance) {
    if (typeof document === "undefined") return;
    const root = document.documentElement;
    root.dataset.appearance = mode;
    root.style.colorScheme = this.isDark(mode) ? "dark" : "light";
    for (const [name, color] of Object.entries(this.variables(mode)))
      root.style.setProperty(name, color);
  }
  static previewStyle(mode: AppearanceMode): React.CSSProperties {
    const resolved = this.resolve(
      mode,
      typeof window !== "undefined" &&
        window.matchMedia("(prefers-color-scheme: dark)").matches,
    );
    const colors = this.colors(resolved);
    return {
      "--preview-primary": colors.primary,
      "--preview-text": colors.text,
      "--preview-muted": colors.muted,
      "--preview-canvas": colors.canvas,
      "--preview-surface": colors.surface,
      "--preview-soft": colors.soft,
      "--preview-border": colors.border,
      "--preview-hero": colors.hero,
      "--preview-hero-end": colors.heroEnd,
      "--preview-expense": colors.expense,
    } as React.CSSProperties;
  }
}
interface AppearanceValue {
  mode: AppearanceMode;
  resolved: ResolvedAppearance;
  reducedMotion: boolean;
  setMode: (mode: AppearanceMode) => void;
}
export const AppearanceContext = React.createContext<AppearanceValue>({
  mode: "forest",
  resolved: "forest",
  reducedMotion: false,
  setMode: () => {},
});

export class AppearanceProvider extends React.Component<
  { children: React.ReactNode },
  { mode: AppearanceMode; systemDark: boolean; reducedMotion: boolean }
> {
  media =
    typeof window !== "undefined"
      ? window.matchMedia("(prefers-color-scheme: dark)")
      : undefined;
  motionMedia =
    typeof window !== "undefined"
      ? window.matchMedia("(prefers-reduced-motion: reduce)")
      : undefined;
  state = {
    mode: Appearance.read(),
    systemDark: this.media?.matches || false,
    reducedMotion: this.motionMedia?.matches || false,
  };
  onSystem = (event: MediaQueryListEvent) =>
    this.setState({ systemDark: event.matches });
  onMotion = (event: MediaQueryListEvent) =>
    this.setState({ reducedMotion: event.matches });
  onStorage = (event: StorageEvent) => {
    if (event.key === Appearance.key)
      this.setState({
        mode: Appearance.valid(event.newValue) ? event.newValue : "forest",
      });
  };
  componentDidMount() {
    this.media?.addEventListener("change", this.onSystem);
    this.motionMedia?.addEventListener("change", this.onMotion);
    window.addEventListener("storage", this.onStorage);
    this.apply();
  }
  componentDidUpdate() {
    this.apply();
  }
  componentWillUnmount() {
    this.media?.removeEventListener("change", this.onSystem);
    this.motionMedia?.removeEventListener("change", this.onMotion);
    window.removeEventListener("storage", this.onStorage);
  }
  apply() {
    Appearance.apply(
      Appearance.resolve(this.state.mode, this.state.systemDark),
    );
  }
  setMode = (mode: AppearanceMode) => {
    try {
      localStorage.setItem(Appearance.key, mode);
    } catch {
      /* Theme still works for the current window. */
    }
    Appearance.apply(Appearance.resolve(mode, this.state.systemDark));
    this.setState({ mode });
  };
  render() {
    const resolved = Appearance.resolve(this.state.mode, this.state.systemDark),
      colors = Appearance.colors(resolved);
    return (
      <AppearanceContext.Provider
        value={{
          mode: this.state.mode,
          resolved,
          reducedMotion: this.state.reducedMotion,
          setMode: this.setMode,
        }}
      >
        <ConfigProvider
          locale={zhCN}
          theme={{
            algorithm: Appearance.isDark(resolved)
              ? theme.darkAlgorithm
              : theme.defaultAlgorithm,
            token: {
              motion: !this.state.reducedMotion,
              colorPrimary: colors.primary,
              colorTextLightSolid: colors.onPrimary,
              colorInfo: colors.primary,
              colorSuccess: colors.positive,
              colorError: colors.negative,
              colorWarning: colors.warning,
              colorText: colors.text,
              colorTextSecondary: colors.muted,
              colorBgLayout: colors.canvas,
              colorBgContainer: colors.surface,
              colorBgElevated: colors.surface,
              colorBorder: colors.border,
              colorBorderSecondary: colors.border,
              colorSplit: colors.border,
              colorFillAlter: colors.soft,
              boxShadow: colors.shadow,
              borderRadius: 11,
              fontFamily:
                '-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif',
            },
            components: {
              Table: {
                headerBg: colors.soft,
                headerColor: colors.muted,
                cellPaddingBlock: 12,
                cellPaddingInline: 14,
                cellPaddingBlockMD: 10,
                cellPaddingInlineMD: 12,
                cellPaddingBlockSM: 8,
                cellPaddingInlineSM: 10,
              },
              Card: { headerFontSize: 15, headerHeight: 50, bodyPadding: 20 },
              Button: { primaryShadow: "none" },
              Menu: {
                itemBg: "transparent",
                subMenuItemBg: "transparent",
                itemSelectedBg: colors.soft,
                itemSelectedColor: colors.primary,
              },
            },
          }}
        >
          <AntApp>{this.props.children}</AntApp>
        </ConfigProvider>
      </AppearanceContext.Provider>
    );
  }
}
export class AppearanceSettings extends React.Component {
  render() {
    return (
      <Card title="外观与主题" className="mb">
        <p className="muted">
          主题即时生效，并保存在当前浏览器；页面、表格、弹窗和图表同步切换。
        </p>
        <AppearanceContext.Consumer>
          {({ reducedMotion }) =>
            reducedMotion ? (
              <p className="muted small" role="status">
                系统已开启“减少动态效果”，当前已关闭页面入场与交互动效。
              </p>
            ) : null
          }
        </AppearanceContext.Consumer>
        <div className="appearance-choices">
          <AppearanceContext.Consumer>
            {(value) => (
              <>
                {Appearance.options.map((option) => (
                  <button
                    type="button"
                    key={option.value}
                    aria-pressed={value.mode === option.value}
                    className={value.mode === option.value ? "selected" : ""}
                    onClick={() => value.setMode(option.value)}
                  >
                    <span
                      className={
                        "appearance-preview" +
                        (option.value === "system"
                          ? " appearance-preview-system"
                          : "")
                      }
                      style={Appearance.previewStyle(option.value)}
                      aria-hidden="true"
                    >
                      <span className="appearance-preview-rail">
                        <i />
                        <i />
                        <i />
                      </span>
                      <span className="appearance-preview-main">
                        <span className="appearance-preview-header">
                          <i />
                          <i />
                        </span>
                        <span className="appearance-preview-metrics">
                          <i />
                          <i />
                          <i />
                        </span>
                        <span className="appearance-preview-chart">
                          <i />
                          <i />
                          <i />
                          <i />
                          <i />
                        </span>
                      </span>
                    </span>
                    <span className="appearance-choice-label">
                      <strong>{option.label}</strong>
                      <span className="appearance-choice-check">
                        {value.mode === option.value && (
                          <CheckOutlined aria-label="正在使用" />
                        )}
                      </span>
                    </span>
                    <small className="appearance-choice-description">
                      {option.description}
                    </small>
                  </button>
                ))}
              </>
            )}
          </AppearanceContext.Consumer>
        </div>
      </Card>
    );
  }
}
