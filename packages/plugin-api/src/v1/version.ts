/**
 * 插件 API v1 —— 版本协商与向后兼容（DESIGN.md §5.4）
 *
 * 策略：
 *   · manifest 声明 `apiVersion: "^1.0.0"`（semver range，受限子集）。
 *   · 宿主启动插件前做握手，不满足则拒绝激活并给出**可读原因**（EAPIVERSION）。
 *   · 承诺支持 N-2 个大版本。
 *   · 能力探测优于版本探测（见 contract.ts 的 HOST_CAPABILITIES_V1）。
 *
 * 这里**自己实现**了 semver 的一个受限子集，而不是引 npm `semver`。
 * 原因：这段代码要同时跑在宿主、插件脚手架、以及将来的沙箱引导脚本里，
 * 依赖越少越好；而且我们只需要 `^x.y.z` / `~x.y.z` / `x.y.z` / `*` 四种写法。
 * 代价：**不支持** `>=`、`||`、`x` 通配、预发布标签的比较语义。
 * 如果将来真需要完整 range，再换成 `semver` 包，别在这里继续加语法。
 */

import { fail, ok, type PluginResult } from './errors.ts';

/** 宿主当前实现的 API 版本 */
export const CURRENT_API_VERSION = '1.0.0';

/** 宿主承诺支持的最老主版本号（N-2：当前 1 → 支持 1；将来 2 → 支持 1..2） */
export const OLDEST_SUPPORTED_MAJOR = 1;

export interface Semver {
  major: number;
  minor: number;
  patch: number;
}

const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function parseSemver(s: string): Semver | null {
  const m = SEMVER_RE.exec(s);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

/** -1 / 0 / 1 */
export function compareSemver(a: Semver, b: Semver): number {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  return 0;
}

export type RangeOp = '^' | '~' | '=' | '*';

export interface VersionRange {
  op: RangeOp;
  /** `*` 时为 null */
  base: Semver | null;
}

const RANGE_RE = /^(\^|~)?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function parseRange(s: string): VersionRange | null {
  if (s === '*') return { op: '*', base: null };
  const m = RANGE_RE.exec(s);
  if (!m) return null;
  const base = { major: Number(m[2]), minor: Number(m[3]), patch: Number(m[4]) };
  const op: RangeOp = m[1] === '^' ? '^' : m[1] === '~' ? '~' : '=';
  return { op, base };
}

/**
 * `^0.y.z` 的语义与 `^x.y.z`（x>0）不同：主版本为 0 时，
 * 次版本号是「破坏性变更位」。这里按 semver 官方语义处理，
 * 因为插件作者会照 npm 的习惯写。
 */
function caretUpperBound(base: Semver): Semver {
  if (base.major > 0) return { major: base.major + 1, minor: 0, patch: 0 };
  if (base.minor > 0) return { major: 0, minor: base.minor + 1, patch: 0 };
  return { major: 0, minor: 0, patch: base.patch + 1 };
}

function tildeUpperBound(base: Semver): Semver {
  // `~x.y.z` := >=x.y.z <x.y+1.0 —— 只允许补丁级变化。
  // 注意这与 caret 不同：`~1.2.3` 的上界是 1.3.0，不是 2.0.0。
  return { major: base.major, minor: base.minor + 1, patch: 0 };
}

export function satisfiesRange(version: string, range: string): boolean {
  const v = parseSemver(version);
  const r = parseRange(range);
  if (!v || !r) return false;
  if (r.op === '*') return true;
  const base = r.base as Semver;
  const cmp = compareSemver(v, base);
  if (cmp < 0) return false;
  // 精确版本必须**相等**，不能只判 >= —— 否则 `1.2.4` 会满足 `1.2.3`
  if (r.op === '=') return cmp === 0;
  const upper = r.op === '^' ? caretUpperBound(base) : tildeUpperBound(base);
  return compareSemver(v, upper) < 0;
}

/**
 * 握手：插件声明的 range 能否被宿主满足。
 *
 * 失败信息是**给用户看的**（安装页会原样展示），所以要说清「你要求的」和「我支持的」。
 */
export function negotiateApiVersion(pluginRange: string): PluginResult<HandshakeResult> {
  const r = parseRange(pluginRange);
  if (!r) {
    return fail('EAPIVERSION', `apiVersion "${pluginRange}" 不是受支持的写法（只支持 ^x.y.z / ~x.y.z / x.y.z / *）`);
  }

  const currentMajor = parseSemver(CURRENT_API_VERSION)!.major;
  if (currentMajor - OLDEST_SUPPORTED_MAJOR > 2) {
    // 自检：如果将来忘了同步 OLDEST_SUPPORTED_MAJOR，这里会暴露出来
    return fail('EINTERNAL', '宿主版本协商配置不一致：OLDEST_SUPPORTED_MAJOR 与 CURRENT_API_VERSION 不匹配');
  }

  if (!satisfiesRange(CURRENT_API_VERSION, pluginRange)) {
    return fail('EAPIVERSION', `插件要求 API ${pluginRange}，宿主当前提供 ${CURRENT_API_VERSION}`, {
      required: pluginRange,
      provided: CURRENT_API_VERSION,
      supportedMajors: `${OLDEST_SUPPORTED_MAJOR}..${currentMajor}`,
    });
  }

  return ok({
    apiVersion: CURRENT_API_VERSION,
    hostVersion: CURRENT_API_VERSION,
    /** 插件声明的 range 覆盖了当前版本，但可能也覆盖了更老的 —— 宿主给当前实现 */
    negotiated: CURRENT_API_VERSION,
  });
}

export interface HandshakeResult {
  apiVersion: string;
  hostVersion: string;
  negotiated: string;
}

/** 该版本是否仍在 N-2 支持窗口内 */
export function isMajorSupported(major: number): boolean {
  const currentMajor = parseSemver(CURRENT_API_VERSION)!.major;
  return major >= OLDEST_SUPPORTED_MAJOR && major <= currentMajor;
}
