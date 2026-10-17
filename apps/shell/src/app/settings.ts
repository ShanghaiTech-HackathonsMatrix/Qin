import type { SecureStore } from '../platform/strategies/kv/types';

export type Density = 'compact' | 'normal' | 'comfy';
export type Layout = 'list' | 'cards';

export interface AppSettings {
  accent: string;
  density: Density;
  layout: Layout;
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
};

const KEY = 'app.settings';

export async function loadSettings(kv: SecureStore): Promise<AppSettings> {
  try {
    const raw = await kv.get(KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const p = JSON.parse(raw) as Partial<AppSettings>;
    return {
      accent: typeof p.accent === 'string' ? p.accent : DEFAULT_SETTINGS.accent,
      density: (p.density as Density) ?? DEFAULT_SETTINGS.density,
      layout: (p.layout as Layout) ?? DEFAULT_SETTINGS.layout,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveSettings(kv: SecureStore, s: AppSettings): Promise<void> {
  await kv.set(KEY, JSON.stringify(s));
}

/** 把设置写到 DOM 上，由 CSS 变量接管渲染 */
export function applySettings(s: AppSettings): void {
  const root = document.documentElement;
  root.style.setProperty('--accent', s.accent);
  root.dataset.density = s.density;
  root.dataset.layout = s.layout;
}
