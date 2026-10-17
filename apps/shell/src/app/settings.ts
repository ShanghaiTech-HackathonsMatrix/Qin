import type { SecureStore } from '../platform/strategies/kv/types';
import { defaultHomeCards, normalizeHomeCards, type HomeCardConfig } from './home-cards';

export type Density = 'compact' | 'normal' | 'comfy';
export type Layout = 'list' | 'cards';

/**
 * 正文字号倍率。1 是设计稿原尺寸。
 *
 * 只作用在**阅读文本**上（任务标题、截止时间、小节标题、正文），
 * 不缩放图标、边框、间距 —— 那会让整块版式一起涨，一屏装不下。
 * 范围卡在 0.9–1.25：再小看不清，再大 DDL 卡会挤成三行。
 */
export const FONT_SCALE_MIN = 0.9;
export const FONT_SCALE_MAX = 1.25;
export const FONT_SCALE_STEP = 0.05;

export function normalizeFontScale(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 1;
  const clamped = Math.min(FONT_SCALE_MAX, Math.max(FONT_SCALE_MIN, value));
  // 滑轨给的是 0.05 的步长，落到两位小数免得出现 1.0500000000000003
  return Math.round(clamped * 100) / 100;
}

export interface AppSettings {
  accent: string;
  density: Density;
  layout: Layout;
  fontScale: number;
  /** 首页摆哪些卡片、什么顺序、多大 —— 见 app/home-cards.ts */
  homeCards: HomeCardConfig[];
}

export const ACCENTS = ['#5b8cff', '#3ecf8e', '#f0b429', '#f2555a', '#a78bfa', '#22d3ee'];

export const DENSITY_LABEL: Record<Density, string> = {
  compact: '紧凑', normal: '标准', comfy: '宽松',
};

export const LAYOUT_LABEL: Record<Layout, string> = {
  list: '列表', cards: '卡片',
};

export const DEFAULT_SETTINGS: AppSettings = {
  accent: '#5b8cff',
  density: 'normal',
  layout: 'list',
  fontScale: 1,
  homeCards: defaultHomeCards(true),
};

const KEY = 'app.settings';

export async function loadSettings(kv: SecureStore, demo = true): Promise<AppSettings> {
  try {
    const raw = await kv.get(KEY);
    if (!raw) return { ...DEFAULT_SETTINGS, homeCards: defaultHomeCards(demo) };
    const p = JSON.parse(raw) as Partial<AppSettings>;
    return {
      accent: typeof p.accent === 'string' ? p.accent : DEFAULT_SETTINGS.accent,
      density: (p.density as Density) ?? DEFAULT_SETTINGS.density,
      layout: (p.layout as Layout) ?? DEFAULT_SETTINGS.layout,
      fontScale: normalizeFontScale(p.fontScale),
      homeCards: normalizeHomeCards(p.homeCards, demo),
    };
  } catch {
    return { ...DEFAULT_SETTINGS, homeCards: defaultHomeCards(demo) };
  }
}

export async function saveSettings(kv: SecureStore, s: AppSettings): Promise<void> {
  await kv.set(KEY, JSON.stringify(s));
}

/** 把设置写到 DOM 上，由 CSS 变量接管渲染 */
export function applySettings(s: AppSettings): void {
  const root = document.documentElement;
  // 单色视觉系统：保留旧设置数据格式，但不让历史主题色染回界面。
  root.style.setProperty('--accent', '#111111');
  root.dataset.density = s.density;
  root.dataset.layout = s.layout;
}
