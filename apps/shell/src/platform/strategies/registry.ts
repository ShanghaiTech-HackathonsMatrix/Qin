import type {
  CandidateReport, ProbeResult, SlotId, SlotReport, Strategy, Tier,
} from './types';

const TIER_ORDER: Record<Tier, number> = { ideal: 0, fallback: 1, dev: 2 };

/** 未声明 order 时的默认次序 */
const DEFAULT_ORDER = 50;

/**
 * 同 tier 内按显式 order 排，最后才用 id 兜底保证稳定。
 * 不能只用 id —— 见 Strategy.order 的注释。
 */
function compare(a: Strategy<unknown, unknown>, b: Strategy<unknown, unknown>): number {
  return (
    TIER_ORDER[a.tier] - TIER_ORDER[b.tier] ||
    (a.order ?? DEFAULT_ORDER) - (b.order ?? DEFAULT_ORDER) ||
    a.id.localeCompare(b.id)
  );
}

async function safeProbe(s: Strategy<unknown, unknown>, deps: unknown): Promise<ProbeResult> {
  try {
    const r = await s.probe(deps);
    // 防御：probe 实现可能返回形状不对的东西
    if (r && typeof r === 'object' && 'ok' in r) return r as ProbeResult;
    return { ok: false, reason: 'probe 返回了非法结果' };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, reason: `探测抛错: ${msg}` };
  }
}

/**
 * 策略注册表。
 *
 * 解析顺序：用户覆盖 → ideal → fallback → dev，取第一个 probe 通过的。
 * 覆盖目标探测失败时不会卡死，会退回自动顺序（并在报告里说明）。
 */
export class StrategyRegistry {
  private bySlot = new Map<SlotId, Strategy<unknown, unknown>[]>();

  register<T, D>(s: Strategy<T, D>): void {
    const list = this.bySlot.get(s.slot) ?? [];
    if (list.some((x) => x.id === s.id)) {
      throw new Error(`策略重复注册: ${s.slot}/${s.id}`);
    }
    list.push(s as unknown as Strategy<unknown, unknown>);
    list.sort(compare);
    this.bySlot.set(s.slot, list);
  }

  candidates(slot: SlotId): ReadonlyArray<Strategy<unknown, unknown>> {
    return this.bySlot.get(slot) ?? [];
  }

  async resolve<T, D>(slot: SlotId, deps: D, overrideId?: string | null):
    Promise<{ value: T | null; report: SlotReport }> {
    const list = this.candidates(slot);
    const probes = new Map<string, ProbeResult>();
    let chosen: Strategy<unknown, unknown> | null = null;
    let overrideFailed: string | undefined;

    // ① 手动覆盖优先
    if (overrideId) {
      const target = list.find((s) => s.id === overrideId);
      if (!target) {
        overrideFailed = `未找到策略「${overrideId}」`;
      } else {
        const pr = await safeProbe(target, deps);
        probes.set(target.id, pr);
        if (pr.ok) {
          chosen = target;
        } else {
          overrideFailed = `覆盖目标探测失败：${pr.reason}`;
        }
      }
    }

    // ② 按 tier 顺序自动探测
    for (const s of list) {
      if (probes.has(s.id)) continue;
      const pr = await safeProbe(s, deps);
      probes.set(s.id, pr);
      if (!chosen && pr.ok) chosen = s;
    }

    const candidates: CandidateReport[] = list.map((s) => {
      const pr = probes.get(s.id) ?? { ok: false, reason: '未探测' };
      const r: CandidateReport = {
        id: s.id,
        label: s.label,
        tier: s.tier,
        note: s.note,
        ok: pr.ok,
        detail: pr.ok ? pr.detail : pr.reason,
        selected: chosen === s,
      };
      if (!r.selected && !pr.ok && overrideId === s.id) r.note2 = '（你手动指定的策略）';
      return r;
    });

    const report: SlotReport = {
      slot,
      selectedId: chosen?.id ?? null,
      override: overrideId ?? null,
      candidates,
    };
    if (overrideFailed) report.overrideFailed = overrideFailed;
    if (!chosen) report.error = `槽位「${slot}」没有任何可用策略`;

    const value = chosen ? ((await chosen.create(deps)) as T) : null;
    return { value, report };
  }
}

/** 用于识别「换设备/换系统版本后策略选择是否变了」 */
export function fingerprint(reports: SlotReport[]): string {
  return reports.map((r) => `${r.slot}=${r.selectedId ?? 'none'}`).join('|');
}
