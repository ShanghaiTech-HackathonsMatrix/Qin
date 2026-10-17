/**
 * 策略层契约。
 *
 * 设计目标：P0 里那些「尚未实机验证」的部分（密钥存储、SQLCipher、索引方案…）
 * 全部做成可替换策略。每个策略自己声明「我怎么判断自己能不能用」（probe），
 * 由注册表在启动时按 ideal → fallback → dev 顺序探测，第一个通过的胜出；
 * 用户也可以在调试面板里手动覆盖。
 *
 * 这样当实机测试发现某个理想实现不通过时，只需换一个策略，不用改业务代码。
 */

/** 策略槽位。每个槽位独立解析，互不影响。 */
export type SlotId = 'kv' | 'store' | 'indexing';

/**
 * 成熟度分级：
 *   ideal    —— 理想实现，最贴近设计目标（如 SQLCipher + Keystore）
 *   fallback —— 降级实现，牺牲部分属性换取可用（如无加密 SQLite、JSON 文档库）
 *   dev      —— 仅供开发/调试，绝不可用于生产数据
 */
export type Tier = 'ideal' | 'fallback' | 'dev';

export type ProbeResult =
  | { ok: true; detail: string }
  | { ok: false; reason: string };

export interface Strategy<T, D = unknown> {
  readonly slot: SlotId;
  readonly id: string;
  readonly label: string;
  readonly tier: Tier;
  /**
   * 同一 tier 内的优先次序，**小的先试**。省略时视为 50。
   *
   * 为什么不能靠 id 字母序：`store.json` 会排在 `store.sqlite` 前面，
   * 于是「无事务无索引的 JSON 文档库」会抢走「普通 SQLite」的降级名额。
   * 这个 bug 已在真机上复现过，所以次序必须显式声明。
   */
  readonly order?: number;
  /** 一句话说明它做什么、依赖什么 */
  readonly note: string;
  /**
   * 探测本策略在当前设备/环境是否可用。
   * 约定：必须**无副作用**、可重复调用、失败要给出可读原因。
   *
   * deps 是已经解析好的上游策略（例如 store 槽位能拿到 kv 与 indexing）。
   * 之所以要传进来，是因为加密存储的探针**必须用正式口令**去试 ——
   * 若用随机口令探测，会污染 @capacitor-community/sqlite 的全局密钥槽，
   * 导致正式库被错误口令加密、再也打不开。
   */
  probe(deps: D): Promise<ProbeResult>;
  /** 真正创建实例。仅在 probe 通过后被调用。 */
  create(deps: D): Promise<T>;
}

// ---------------------------------------------------------------- 解析报告

export interface CandidateReport {
  id: string;
  label: string;
  tier: Tier;
  note: string;
  ok: boolean;
  /** probe 的说明或失败原因 */
  detail: string;
  selected: boolean;
  /** 未被选中的额外说明（例如「用户覆盖到别的策略」） */
  note2?: string;
}

export interface SlotReport {
  slot: SlotId;
  selectedId: string | null;
  /** 用户手动指定的 id（若有） */
  override: string | null;
  /** 覆盖目标探测失败时的说明 */
  overrideFailed?: string;
  candidates: CandidateReport[];
  /** 整个槽位都没解析出来时的错误 */
  error?: string;
}

export interface ResolutionReport {
  at: number;
  platform: string;
  /** 用于识别「换设备/换版本后策略是否变了」 */
  fingerprint: string;
  slots: SlotReport[];
}
