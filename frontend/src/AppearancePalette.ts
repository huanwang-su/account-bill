export type ResolvedAppearance =
  "forest" | "blue" | "warm" | "violet" | "ocean" | "dark";
export type AppearanceMode = ResolvedAppearance | "system";

export interface AppearanceColors {
  primary: string;
  accentRgb: string;
  text: string;
  muted: string;
  canvas: string;
  surface: string;
  soft: string;
  border: string;
  hero: string;
  heroEnd: string;
  heroMuted: string;
  onAccent: string;
  onPrimary: string;
  positive: string;
  negative: string;
  warning: string;
  expense: string;
  shadow: string;
}

interface AppearancePalette {
  label: string;
  description: string;
  colors: AppearanceColors;
}

const lightSemantics = {
  surface: "#ffffff",
  onAccent: "#ffffff",
  onPrimary: "#ffffff",
  positive: "#28734e",
  negative: "#a34838",
  warning: "#87632b",
  expense: "#8d5f3c",
};

function colors(values: Omit<AppearanceColors, "accentRgb">): AppearanceColors {
  const primary = values.primary.slice(1);
  return {
    ...values,
    accentRgb: [0, 2, 4]
      .map((offset) => parseInt(primary.slice(offset, offset + 2), 16))
      .join(", "),
  };
}

/** Shared source for page variables, component tokens and chart semantics. */
export const appearancePalettes: Record<ResolvedAppearance, AppearancePalette> =
  {
    forest: {
      label: "自然绿",
      description: "柔和绿意，清晰耐看",
      colors: colors({
        ...lightSemantics,
        primary: "#28664f",
        text: "#25332e",
        muted: "#5f7267",
        canvas: "#f5f6f2",
        soft: "#edf3ed",
        border: "#e1e7df",
        hero: "#265f4b",
        heroEnd: "#397259",
        heroMuted: "#e1eee6",
        shadow: "0 6px 20px #2038280a",
      }),
    },
    blue: {
      label: "简洁蓝",
      description: "理性蓝调，信息鲜明",
      colors: colors({
        ...lightSemantics,
        primary: "#3469ad",
        text: "#26344a",
        muted: "#596b82",
        canvas: "#f2f5fa",
        soft: "#eaf0f8",
        border: "#dce4ef",
        hero: "#2d527d",
        heroEnd: "#416a98",
        heroMuted: "#e0ebfa",
        shadow: "0 6px 20px #26344a0a",
      }),
    },
    warm: {
      label: "纸杏",
      description: "温暖纸感，轻松记账",
      colors: colors({
        ...lightSemantics,
        primary: "#9b542e",
        text: "#3f332b",
        muted: "#75675b",
        canvas: "#f8f4ed",
        soft: "#f4ebe0",
        border: "#e9dfd2",
        hero: "#805033",
        heroEnd: "#8f5c39",
        heroMuted: "#f5e9da",
        shadow: "0 6px 20px #674a310c",
      }),
    },
    violet: {
      label: "雾紫",
      description: "安静雾紫，细节从容",
      colors: colors({
        ...lightSemantics,
        primary: "#7155a5",
        text: "#383044",
        muted: "#70647d",
        canvas: "#f5f3f8",
        soft: "#eee9f5",
        border: "#e3ddeb",
        hero: "#59477b",
        heroEnd: "#725d8e",
        heroMuted: "#eee6f8",
        shadow: "0 6px 20px #49375e0b",
      }),
    },
    ocean: {
      label: "海青",
      description: "清澈海青，明快有序",
      colors: colors({
        ...lightSemantics,
        primary: "#1b727a",
        text: "#263b3e",
        muted: "#526f73",
        canvas: "#f0f6f5",
        soft: "#e5f0ef",
        border: "#d7e5e3",
        hero: "#185861",
        heroEnd: "#28727b",
        heroMuted: "#e0f1ef",
        shadow: "0 6px 20px #1b51570b",
      }),
    },
    dark: {
      label: "深色",
      description: "低亮背景，夜间舒适",
      colors: colors({
        primary: "#82c6a9",
        text: "#e1ece5",
        muted: "#a0b3a7",
        canvas: "#101815",
        surface: "#19251f",
        soft: "#213229",
        border: "#34483c",
        hero: "#214f3b",
        heroEnd: "#285b46",
        heroMuted: "#d8ecdf",
        onAccent: "#f4fbf7",
        onPrimary: "#102219",
        positive: "#82c6a9",
        negative: "#f0a18e",
        warning: "#ddbd82",
        expense: "#d8b18b",
        shadow: "0 6px 20px #00000029",
      }),
    },
  };
