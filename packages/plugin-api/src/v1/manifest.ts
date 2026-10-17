/**
 * 插件 API v1 —— Manifest（DESIGN.md §5.2）
 *
 * 这一份是**权威定义**（此前只有 docs/design/api-v1.d.ts 里的草案）。
 *
 * 设计要点：
 *   · `permissions` 是**声明**，不是授予。安装时用户确认的子集才成为 `granted`，
 *     且必须满足 `granted ⊆ declared`（见 permissions.ts 的 intersectPermissions）。
 *   · `capabilities` 管的是「代码能不能进来」（信任），与 `permissions`（能做什么）**正交**。
 *     这是 I4：授予远程代码信任 ≠ 授予网络权限。
 *   · 校验失败不抛异常，返回 issue 列表 —— 安装页要能把问题一条条显示给用户。
 */

import { fail, ok, type PluginResult } from './errors.ts';
import { ENTITY_TYPE_RE, FIELD_TYPES, type EntitySchema } from './schema.ts';
import { validateViewContribution, type ViewContribution } from './ui.ts';

export type PluginKind = 'declarative' | 'logic' | 'connector' | 'ui' | 'first-party';

export const PLUGIN_KINDS: readonly PluginKind[] = [
  'declarative', 'logic', 'connector', 'ui', 'first-party',
];

/**
 * 这些形态**不要求** `entry`（给了也不禁止，只是可选）。
 *
 *   · `declarative` —— 没有代码，entry 无意义
 *   · `first-party` —— 编译进应用的宿主内置 / 官方插件。进程内运行时直接持有模块对象，
 *     根本不读 `entry`。要求它填一个并不存在的文件名是纯粹的谎 ——
 *     第一个第一方插件就撞上了这条。
 */
export const KINDS_WITHOUT_ENTRY: readonly PluginKind[] = ['declarative', 'first-party'];

export interface ManifestPermissions {
  data?: { write?: string[]; read?: string[] };
  net?: { domains?: string[]; methods?: string[] };
  auth?: { providers?: string[] };
  notify?: boolean;
  background?: { periodic?: boolean; exact?: boolean };
  secrets?: boolean;
  fs?: 'none' | 'sandbox';
  ui?: { components?: string[]; slots?: string[] };
  /** 二期能力（§5.5）：声明了也未必被授予，宿主可拒绝 */
  stream?: boolean;
  db?: { raw?: boolean };
  llm?: { local?: boolean };
  /**
   * 允许该插件请求**宿主提供的本地资源**（`PlannedRequest.source === 'host'`）：
   * 用户选的文件、剪贴板、系统分享进来的文本……
   *
   * 这不等于「读文件系统」—— 插件给的是**不透明键**（如 `host://import`），
   * 宿主决定每个键对应什么，且键按 `(pluginId, url)` 隔离，
   * 所以也读不到别的插件导入的东西。真正的路径由用户在 UI 里选择。
   *
   * 与 `fs` 的区别：`fs` 是插件自己的沙箱目录；`local` 是用户主动递交进来的东西。
   */
  local?: boolean;
}

export interface ManifestCapabilities {
  /**
   * 受限模式下的行为。
   * `false` = 完全不激活；`limited` = 只激活声明式视图与自身数据读写（§5.7）
   */
  untrustedRemote?: false | 'limited';
  /** 受限模式下不读写的配置项 */
  restrictedSettings?: string[];
  remoteCode?: {
    /** 必须展示给用户：为什么需要远程代码 */
    reason: string;
    origins: string[];
    /** 建议要求子资源签名 */
    signature?: 'required' | 'optional';
  };
}

/** manifest 里声明一个实体类型的方式 */
export interface ManifestEntityType {
  name: string;
  schema: EntitySchema;
}

export interface ManifestContributes {
  /**
   * 本插件写入的实体类型。
   *
   * 形状是 `{ name, schema }` 的**数组**，而不是 `{ course: {...} }` 这样的映射 ——
   * `DataBus.declareSchema()` 需要 `type` 作为一等参数（它参与记录键构造、
   * 配额统计、跨插件读取）。
   *
   * ⚠️ 这个形状是**提案**，未经真实插件检验。
   */
  entityTypes?: ManifestEntityType[];
  /**
   * 本插件贡献的视图（页面 / 控件）。
   *
   * 这里是**目录**：只有 id / title / kind / requires 这些纯数据，可校验、可序列化。
   * 渲染函数不在这里 —— 它在 `PluginExports.renders` 里，按同一个 id 对应。
   * 宿主会交叉核对：声明了没有实现、或实现了没有声明，都会报警告。
   */
  views?: ViewContribution[];
  commands?: Array<{ id: string; title: string }>;
  connectors?: Array<{ id: string; authProvider?: string; syncIntervalMin?: number }>;
}

export interface ManifestIntegrity {
  algo: 'ed25519';
  hash: string;
  sig: string;
}

export interface Manifest {
  id: string;
  name: string;
  version: string;
  /** semver range，如 `^1.0.0` */
  apiVersion: string;
  kind: PluginKind;
  /** declarative 形态可省略 */
  entry?: string;
  engines?: { platform?: string[] };
  permissions?: ManifestPermissions;
  capabilities?: ManifestCapabilities;
  contributes?: ManifestContributes;
  /** 依赖的其它插件 id —— `trust.loadModule` 要求目标在此列表中 */
  dependencies?: string[];
  integrity?: ManifestIntegrity;
}

export interface ManifestIssue {
  /** 出问题的字段路径，便于安装页精确定位 */
  path: string;
  message: string;
}

export interface ManifestValidation {
  ok: boolean;
  issues: ManifestIssue[];
  /** 仅在 ok 为 true 时给出，且已做浅冻结 */
  manifest?: Manifest;
}

// ---------------------------------------------------------------- 基础校验

/**
 * 保留前缀：内置与官方第一方插件，第三方不得占用。
 *
 *   · `dev.matrix.*` —— 宿主内置（与 `appId: dev.matrix.shell` 同命名空间）
 *   · `app.matrix.*` —— 官方第一方插件
 *
 * 注意：**依赖**不适用这条限制 —— 第三方插件可以依赖内置插件（`dependencies: ["dev.matrix.core"]`）。
 * 受限的只是「谁可以把自己**命名成**什么」。
 *
 * ## 谁能占用：只有「编译进应用的」插件
 *
 * 默认**全拒**。要占用必须由宿主显式传 `allowReservedPrefix: true`
 * （见 `ManifestValidationOptions`）—— 因为「这个文件是编译进应用的」
 * 是宿主知道、manifest 无法声称的事实。
 *
 * 刻意**不**用 `kind === 'first-party'` 当豁免条件：`kind` 是 manifest 自己声称的，
 * 第三方照抄就能绕过（运行时自报的 kind 本来就以 manifest 为准，
 * 见 registry.ts 的握手核对）—— 那就是个假开关。
 *
 * 第三方安装流程永远不传这个开关，所以保留前缀对他们始终关闭。
 *
 * TODO(签名)：签名落地后，这个开关应被「官方密钥签名验证通过」取代。
 */
const RESERVED_ID_PREFIXES = ['app.matrix.', 'dev.matrix.'];

const ID_RE = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9-]*)+$/;

/** 严格 semver（不含 range 语法） */
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** semver range 的**受限子集**：`^x.y.z` / `~x.y.z` / 精确 `x.y.z` / `*` */
const RANGE_RE = /^(\^|~)?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$|^\*$/;

/**
 * 域名**形状**校验。
 *
 * 注意分工：这里只拦「明显写错了」（写了 scheme、路径、端口、IP 字面量、大写），
 * 目的是让插件作者在打包时就收到明确报错。
 * **权威的匹配规则**在核心层 `apps/shell/src/core/allowlist.ts`（精确 / `*.` 后缀、
 * 标签边界判定）。两处必须保持一致 —— 目前是重复实现，
 * 待 `packages/net` 抽出后应改为单向依赖。**这是已知的技术债。**
 */
export function isValidDomainPattern(d: unknown): d is string {
  if (typeof d !== 'string' || d.length === 0 || d.length > 253) return false;
  if (d !== d.toLowerCase()) return false;
  // 不许写 scheme / 路径 / 端口 / userinfo
  if (/[/:@?#]/.test(d)) return false;
  // 不许 IP 字面量（v4 / v6 括号 / 纯数字）
  if (/^\[.*\]$/.test(d) || /^[\d.]+$/.test(d)) return false;
  // 通配只能是最左一个标签
  if (d.includes('*')) {
    if (!d.startsWith('*.')) return false;
    if (d.slice(2).includes('*')) return false;
  }
  const host = d.startsWith('*.') ? d.slice(2) : d;
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host)) return false;
  // 标签不能以连字符开头/结尾
  if (host.split('.').some((l) => l.startsWith('-') || l.endsWith('-'))) return false;
  return true;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === 'string');

// ---------------------------------------------------------------- 主校验

/**
 * 校验一份 manifest。**不抛异常** —— 返回 issue 列表。
 *
 * 校验是「尽早失败」的：把作者的错误在安装前就挡下来，
 * 而不是等到运行时某个 RPC 莫名其妙被拒。
 */
export interface ManifestValidationOptions {
  /**
   * 允许占用保留前缀（`dev.matrix.*` / `app.matrix.*`）。
   *
   * **只能由宿主在加载「编译进应用的」插件时传 true。**
   *
   * 为什么用显式开关，而不是看 `kind === 'first-party'`：`kind` 是 manifest
   * **自己声称**的东西 —— 第三方照抄就能绕过（运行时自报的 kind 本来就以 manifest 为准）。
   * 而「这个文件是编译进应用的」是**宿主知道、manifest 无法声称**的事实。
   * 信任判断必须建立在后者上，否则就是个假开关。
   *
   * 第三方安装流程永远不传 —— 保留前缀对他们始终关闭。
   *
   * TODO(签名)：签名落地后，这个开关应被「官方密钥签名验证通过」取代。
   */
  allowReservedPrefix?: boolean;
}

export function validateManifest(
  raw: unknown,
  opts: ManifestValidationOptions = {},
): ManifestValidation {
  const issues: ManifestIssue[] = [];
  const add = (path: string, message: string) => issues.push({ path, message });

  if (!isPlainObject(raw)) {
    return { ok: false, issues: [{ path: '', message: 'manifest 必须是一个对象' }] };
  }

  // --- id
  if (typeof raw.id !== 'string') add('id', 'id 必须是字符串');
  else {
    // 先取出来：TS 不会把属性收窄带进回调里
    const id = raw.id;
    if (!ID_RE.test(id)) add('id', `id 必须是反向域名形式的小写标识，实际为 "${id}"`);
    else if (!opts.allowReservedPrefix && RESERVED_ID_PREFIXES.some((p) => id.startsWith(p))) {
      add('id', `id 不得占用保留前缀 ${RESERVED_ID_PREFIXES.join(' / ')}（仅编译进应用的插件可占用）`);
    }
  }

  // --- name / version / apiVersion
  if (typeof raw.name !== 'string' || raw.name.trim() === '') add('name', 'name 必须是非空字符串');
  if (typeof raw.version !== 'string' || !SEMVER_RE.test(raw.version)) {
    add('version', `version 必须是严格 semver，实际为 "${String(raw.version)}"`);
  }
  if (typeof raw.apiVersion !== 'string' || !RANGE_RE.test(raw.apiVersion)) {
    add('apiVersion', `apiVersion 必须是 ^x.y.z / ~x.y.z / x.y.z / * 之一，实际为 "${String(raw.apiVersion)}"`);
  }

  // --- kind / entry
  if (typeof raw.kind !== 'string' || !PLUGIN_KINDS.includes(raw.kind as PluginKind)) {
    add('kind', `kind 必须是 ${PLUGIN_KINDS.join(' / ')} 之一`);
  } else if (!KINDS_WITHOUT_ENTRY.includes(raw.kind as PluginKind)) {
    if (typeof raw.entry !== 'string' || raw.entry.trim() === '') {
      add('entry', `kind=${raw.kind} 必须提供 entry`);
    }
  }
  // entry **只要给了就校验**，不管这个 kind 是否要求它。
  // 原实现把校验塞在「必填」分支里，于是 declarative / first-party 可以塞一个
  // 越界路径而完全不被检查。现在无害（这两种形态不加载代码），
  // 但沙箱加载器一旦开始读 manifest.entry，那就是路径穿越。
  if (typeof raw.entry === 'string' && raw.entry.trim() !== '') {
    if (raw.entry.startsWith('/') || raw.entry.includes('..')) {
      add('entry', 'entry 必须是包内相对路径，不得越出包目录');
    }
  }

  // --- engines
  if (raw.engines !== undefined) {
    if (!isPlainObject(raw.engines)) add('engines', 'engines 必须是对象');
    else if (raw.engines.platform !== undefined && !isStringArray(raw.engines.platform)) {
      add('engines.platform', 'engines.platform 必须是字符串数组');
    }
  }

  // --- permissions
  const p = raw.permissions;
  if (p !== undefined) {
    if (!isPlainObject(p)) add('permissions', 'permissions 必须是对象');
    else {
      validateData(p.data, add);
      validateNet(p.net, add);
      if (p.auth !== undefined) {
        if (!isPlainObject(p.auth)) add('permissions.auth', 'auth 必须是对象');
        else if (p.auth.providers !== undefined && !isStringArray(p.auth.providers)) {
          add('permissions.auth.providers', 'providers 必须是字符串数组');
        }
      }
      if (p.notify !== undefined && typeof p.notify !== 'boolean') {
        add('permissions.notify', 'notify 必须是布尔值');
      }
      if (p.secrets !== undefined && typeof p.secrets !== 'boolean') {
        add('permissions.secrets', 'secrets 必须是布尔值');
      }
      if (p.stream !== undefined && typeof p.stream !== 'boolean') {
        add('permissions.stream', 'stream 必须是布尔值（二期能力）');
      }
      if (p.fs !== undefined && p.fs !== 'none' && p.fs !== 'sandbox') {
        add('permissions.fs', 'fs 只能是 "none" 或 "sandbox"');
      }
      if (p.background !== undefined) {
        if (!isPlainObject(p.background)) add('permissions.background', 'background 必须是对象');
        else {
          for (const k of ['periodic', 'exact'] as const) {
            if (p.background[k] !== undefined && typeof p.background[k] !== 'boolean') {
              add(`permissions.background.${k}`, `${k} 必须是布尔值`);
            }
          }
        }
      }
      if (p.ui !== undefined) {
        if (!isPlainObject(p.ui)) add('permissions.ui', 'ui 必须是对象');
        else {
          for (const k of ['components', 'slots'] as const) {
            if (p.ui[k] !== undefined && !isStringArray(p.ui[k])) {
              add(`permissions.ui.${k}`, `${k} 必须是字符串数组`);
            }
          }
        }
      }
      if (p.db !== undefined) {
        if (!isPlainObject(p.db)) add('permissions.db', 'db 必须是对象');
        else if (p.db.raw !== undefined && typeof p.db.raw !== 'boolean') {
          add('permissions.db.raw', 'db.raw 必须是布尔值');
        }
      }
      if (p.llm !== undefined) {
        if (!isPlainObject(p.llm)) add('permissions.llm', 'llm 必须是对象');
        else if (p.llm.local !== undefined && typeof p.llm.local !== 'boolean') {
          add('permissions.llm.local', 'llm.local 必须是布尔值');
        }
      }
      if (p.local !== undefined && typeof p.local !== 'boolean') {
        add('permissions.local', 'local 必须是布尔值');
      }
    }
  }

  // --- capabilities
  const c = raw.capabilities;
  if (c !== undefined) {
    if (!isPlainObject(c)) add('capabilities', 'capabilities 必须是对象');
    else {
      if (c.untrustedRemote !== undefined && c.untrustedRemote !== false && c.untrustedRemote !== 'limited') {
        add('capabilities.untrustedRemote', '只能是 false 或 "limited"');
      }
      if (c.restrictedSettings !== undefined && !isStringArray(c.restrictedSettings)) {
        add('capabilities.restrictedSettings', 'restrictedSettings 必须是字符串数组');
      }
      if (c.remoteCode !== undefined) {
        if (!isPlainObject(c.remoteCode)) add('capabilities.remoteCode', 'remoteCode 必须是对象');
        else {
          // reason 是**强制**的 —— 授予时必须展示给用户（§5.7 工程要求 2）
          if (typeof c.remoteCode.reason !== 'string' || c.remoteCode.reason.trim() === '') {
            add('capabilities.remoteCode.reason', '必须说明为什么需要远程代码（会展示给用户）');
          }
          if (!isStringArray(c.remoteCode.origins) || c.remoteCode.origins.length === 0) {
            add('capabilities.remoteCode.origins', 'origins 必须是非空字符串数组');
          } else {
            for (const [i, o] of c.remoteCode.origins.entries()) {
              if (!isValidDomainPattern(o)) {
                add(`capabilities.remoteCode.origins[${i}]`, `不是合法的域名形状："${o}"`);
              }
            }
          }
        }
      }
    }
  }

  // --- dependencies
  if (raw.dependencies !== undefined) {
    if (!isStringArray(raw.dependencies)) add('dependencies', 'dependencies 必须是字符串数组');
    else {
      for (const [i, d] of raw.dependencies.entries()) {
        if (!ID_RE.test(d)) add(`dependencies[${i}]`, `不是合法的插件 id："${d}"`);
        if (d === raw.id) add(`dependencies[${i}]`, '插件不能依赖自己');
      }
      if (new Set(raw.dependencies).size !== raw.dependencies.length) {
        add('dependencies', 'dependencies 存在重复项');
      }
    }
  }

  // --- contributes
  validateContributes(raw.contributes, add);

  // --- integrity
  if (raw.integrity !== undefined) {
    if (!isPlainObject(raw.integrity)) add('integrity', 'integrity 必须是对象');
    else {
      if (raw.integrity.algo !== 'ed25519') add('integrity.algo', '目前只支持 ed25519');
      for (const k of ['hash', 'sig'] as const) {
        if (typeof raw.integrity[k] !== 'string' || raw.integrity[k] === '') {
          add(`integrity.${k}`, `${k} 必须是非空字符串`);
        }
      }
    }
  }

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, issues: [], manifest: Object.freeze(raw as unknown as Manifest) };
}

function validateData(data: unknown, add: (p: string, m: string) => void): void {
  if (data === undefined) return;
  if (!isPlainObject(data)) { add('permissions.data', 'data 必须是对象'); return; }
  for (const k of ['write', 'read'] as const) {
    const v = data[k];
    if (v === undefined) continue;
    if (!isStringArray(v)) { add(`permissions.data.${k}`, `${k} 必须是字符串数组`); continue; }
    for (const [i, e] of v.entries()) {
      // 实体类型名会成为表名的一部分，必须是安全的标识符。
      // 与 DataBus.declareSchema 共用同一个正则（schema.ts 的 ENTITY_TYPE_RE）。
      if (!ENTITY_TYPE_RE.test(e)) {
        add(`permissions.data.${k}[${i}]`, `实体类型必须是 snake_case 标识符："${e}"`);
      }
    }
    if (new Set(v).size !== v.length) add(`permissions.data.${k}`, `${k} 存在重复项`);
  }
}

function validateNet(net: unknown, add: (p: string, m: string) => void): void {
  if (net === undefined) return;
  if (!isPlainObject(net)) { add('permissions.net', 'net 必须是对象'); return; }
  if (net.domains !== undefined) {
    if (!isStringArray(net.domains)) add('permissions.net.domains', 'domains 必须是字符串数组');
    else {
      for (const [i, d] of net.domains.entries()) {
        if (!isValidDomainPattern(d)) {
          add(`permissions.net.domains[${i}]`, `不是合法的域名形状："${d}"（不许写 scheme/路径/端口/IP）`);
        }
      }
      if (new Set(net.domains).size !== net.domains.length) {
        add('permissions.net.domains', 'domains 存在重复项');
      }
    }
  }
  if (net.methods !== undefined) {
    if (!isStringArray(net.methods)) add('permissions.net.methods', 'methods 必须是字符串数组');
    else {
      const allowed = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'];
      for (const [i, m] of net.methods.entries()) {
        if (!allowed.includes(m)) add(`permissions.net.methods[${i}]`, `不支持的方法："${m}"`);
      }
    }
  }
}

/**
 * `contributes` 的形状校验。
 *
 * 原实现**完全没有校验 contributes** —— `entityTypes` 是 `unknown[]`，
 * 于是字段名打错、少一层 `{ name, schema }` 包装、schema 类型拼错，
 * 都要等到 `registry.install` 才以 `ESCHEMA` 冒出来，
 * 而那时安装页已经走完了，用户看到的是一句没有定位信息的话。
 *
 * 这里把能查的形状问题一次查完，让作者在**打包时**就收到带路径的报错。
 * 深度校验（值 vs schema）仍在 `DataBus.validateEntity` —— 那是写入时的事。
 */
function validateContributes(raw: unknown, add: (p: string, m: string) => void): void {
  if (raw === undefined) return;
  if (!isPlainObject(raw)) { add('contributes', 'contributes 必须是对象'); return; }

  // --- entityTypes
  const et = raw.entityTypes;
  if (et !== undefined) {
    if (!Array.isArray(et)) {
      add('contributes.entityTypes', 'entityTypes 必须是数组（每项 { name, schema }）');
    } else {
      const seen = new Set<string>();
      et.forEach((item, i) => {
        const at = `contributes.entityTypes[${i}]`;
        if (!isPlainObject(item)) { add(at, '每一项必须是 { name, schema } 对象'); return; }

        const name = item.name;
        if (typeof name !== 'string' || !ENTITY_TYPE_RE.test(name)) {
          add(`${at}.name`, `实体类型名必须是 snake_case 标识符："${String(name)}"`);
        } else if (seen.has(name)) {
          add(`${at}.name`, `实体类型名重复：${name}`);
        } else {
          seen.add(name);
        }

        const schema = item.schema;
        if (!isPlainObject(schema)) { add(`${at}.schema`, 'schema 必须是对象'); return; }
        if (schema.type !== 'object') {
          add(`${at}.schema.type`, 'schema.type 必须是 "object"（实体都是具名字段的对象）');
        }
        if (schema.properties !== undefined) {
          if (!isPlainObject(schema.properties)) {
            add(`${at}.schema.properties`, 'properties 必须是对象');
          } else {
            for (const [key, fs] of Object.entries(schema.properties)) {
              const fat = `${at}.schema.properties.${key}`;
              if (!isPlainObject(fs)) { add(fat, '字段 schema 必须是对象'); continue; }
              if (fs.type !== undefined && !(FIELD_TYPES as readonly unknown[]).includes(fs.type)) {
                add(`${fat}.type`, `字段类型必须是 ${FIELD_TYPES.join(' / ')} 之一，实际为 "${String(fs.type)}"`);
              }
            }
          }
        }
        if (schema.required !== undefined && !isStringArray(schema.required)) {
          add(`${at}.schema.required`, 'required 必须是字符串数组');
        }
        if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== 'boolean') {
          add(`${at}.schema.additionalProperties`, 'additionalProperties 必须是布尔值');
        }
      });
    }
  }

  // --- views
  const views = raw.views;
  if (views !== undefined) {
    if (!Array.isArray(views)) {
      add('contributes.views', 'views 必须是数组（每项 { id, title, kind }）');
    } else {
      const seen = new Set<string>();
      views.forEach((v, i) => {
        validateViewContribution(v, `contributes.views[${i}]`, add, seen);
      });
    }
  }

  // --- commands
  const cmds = raw.commands;
  if (cmds !== undefined) {
    if (!Array.isArray(cmds)) {
      add('contributes.commands', 'commands 必须是数组');
    } else {
      cmds.forEach((cmd, i) => {
        const at = `contributes.commands[${i}]`;
        if (!isPlainObject(cmd)) { add(at, '每一项必须是 { id, title } 对象'); return; }
        if (typeof cmd.id !== 'string' || cmd.id === '') add(`${at}.id`, 'id 必须是非空字符串');
        if (typeof cmd.title !== 'string' || cmd.title === '') add(`${at}.title`, 'title 必须是非空字符串');
      });
    }
  }

  // --- connectors
  const conns = raw.connectors;
  if (conns !== undefined) {
    if (!Array.isArray(conns)) {
      add('contributes.connectors', 'connectors 必须是数组');
    } else {
      conns.forEach((cn, i) => {
        const at = `contributes.connectors[${i}]`;
        if (!isPlainObject(cn)) { add(at, '每一项必须是对象'); return; }
        if (typeof cn.id !== 'string' || cn.id === '') add(`${at}.id`, 'id 必须是非空字符串');
        if (cn.syncIntervalMin !== undefined &&
            (typeof cn.syncIntervalMin !== 'number' || !(cn.syncIntervalMin > 0))) {
          add(`${at}.syncIntervalMin`, 'syncIntervalMin 必须是正数');
        }
      });
    }
  }
}

/** 便捷包装：把校验结果转成 `PluginResult` */
export function loadManifest(
  raw: unknown,
  opts: ManifestValidationOptions = {},
): PluginResult<Manifest> {
  const v = validateManifest(raw, opts);
  if (!v.ok || !v.manifest) {
    return fail('EMANIFEST', 'manifest 校验未通过', {
      issues: v.issues.map((i) => `${i.path || '<root>'}: ${i.message}`),
    });
  }
  return ok(v.manifest);
}
