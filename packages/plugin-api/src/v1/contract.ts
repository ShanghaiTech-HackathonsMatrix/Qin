/**
 * 插件 API v1 —— 插件契约（DESIGN.md §5.5，决策 D8）
 *
 * **核心约束：沙箱内不存在任何异步宿主 API。插件是纯函数。**
 *
 * 这不是审美选择，是被 P0-S4 证伪逼出来的：插件侧 `await ctx.net.request(...)`
 * 在顺序调用第二次时必崩，且 asyncify 状态是 WASM 模块实例级的全局状态，
 * 一处损坏全局连坐（证据见 spikes/p0/REPORT.md §4）。
 *
 * 所以：插件不碰网络，只**产出请求描述**；宿主代跑一切 IO，把响应体当普通字符串传回来。
 * 插件算完返回普通 JSON。全程同步，无 Promise，无 await。
 */

import type { PluginKind } from './manifest.ts';
import type { ViewRender } from './ui.ts';

// ------------------------------------------------------------ 请求描述

/**
 * 谁满足这个请求。
 *
 *   · `'net'`（默认）—— 宿主经**核心网关**出网。要过 URL 校验、插件域名白名单、
 *     平台白名单、限流、逐跳复检。
 *   · `'host'` —— 宿主**自行满足**，不走网络。用于本地导入：用户选的文件、
 *     剪贴板、系统分享进来的文本……
 *
 * ## 为什么是「请求的一种」而不是「另一种输入通道」
 *
 * 本地文档在插件眼里**就是一份响应体** —— 插件不关心字节是从网络来的还是从磁盘来的。
 * `parsers` 的签名 `(ParseInput) => ParseResult` 对它完全适用。
 *
 * 所以这里只加了一个**来源判别位**，而不是给插件开第二个入口：
 * 文档**始终**从 `parsers` 的 `body` 进来，这条前提没有被破坏。
 * （曾经考虑过给 `PlanInput` 加一个 `payload` 字段直接运文档 —— 那会让插件有两个入口，
 * 一个走 `parsers`、一个走 `plan`，语义就分叉了。）
 *
 * ## `url` 在 `'host'` 下是**不透明键**，不是路径
 *
 * 插件**无法**通过它指到文件系统上的某个文件 —— 它只是宿主用来查找
 * 「要满足哪份文档」的键（例如 `host://import`）。宿主决定每个键对应什么，
 * 而键是按 `(pluginId, url)` 隔离的，所以也读不到别的插件导入的东西。
 */
export type RequestSource = 'net' | 'host';

export interface PlannedRequest {
  /** 本次 plan 内唯一；宿主用它把响应与请求对应起来 */
  id: string;
  method: 'GET' | 'POST';
  /** 必须落在 manifest 声明的 origins 内，否则宿主抛 ENETDENIED */
  url: string;
  headers?: Record<string, string>;
  body?: string;
  /** 用哪个 parser 处理这个响应 */
  parse: string;
  /** 缺省 = `'net'` */
  source?: RequestSource;
}

export interface RequestPlan {
  requests: PlannedRequest[];

  /**
   * **无需 IO 即可落库的实体**。
   *
   * 给「纯计算」形态用：插件不需要任何外部文档，只靠 `PlanInput`（`now` / `settings`）
   * 算出结果。这批实体在请求循环**之前**落库。
   *
   * 为什么需要它：`bus.emit` 是插件写入数据的唯一通路，而它挂在请求循环里。
   * 没有这个字段的话，一个 `kind: 'logic'` 且不发请求的插件**永远无法产出数据** ——
   * 而且 `run()` 会返回 `ok`，静默什么都不做。
   *
   * 需要文档时**不要**用它，走 `requests` + `parsers`。
   */
  entities?: ParsedEntity[];
  /** 与 `entities` 配套的增量游标 */
  cursor?: string;
  /** 与 `entities` 配套的摘要 */
  summary?: string;
}

// ------------------------------------------------------------ 解析

export interface ParseInput {
  /** 宿主抓回来的响应体 —— 就是一段普通字符串 */
  body: string;
  status: number;
  baseUrl: string;
  /**
   * 凭证**永不进沙箱**。这个字段是 `never`，
   * 目的是让「插件想拿凭证」在类型层面就写不出来。
   */
  credentials?: never;
}

/** 要落库的一条实体 */
export interface ParsedEntity {
  /** 对应 manifest `permissions.data.write` 里声明过的实体类型 */
  type: string;
  /** 平台侧主键；缺省时宿主按内容哈希生成 */
  id?: string;
  data: Record<string, unknown>;
}

/**
 * 解析结果。
 *
 * ⚠️ 注意 `cursor` 是**增量游标**，不是累积状态 ——
 * 累积状态应当留在插件模块作用域内（见下方 STEP_STATE_GUIDANCE）。
 */
export interface ParseResult {
  entities?: ParsedEntity[];
  /** 传给下一次同步的增量游标（如页码、时间戳） */
  cursor?: string;
  /** 给 UI / 审计日志看的摘要 */
  summary?: string;
  /** 解析失败时填写；宿主会把它计入审计而不是让插件崩掉 */
  error?: string;
}

// ------------------------------------------------------------ 多步状态机

export interface StepInput {
  /** 上一步 `StepDirective.next` 给出的步骤名 */
  step: string;
  /**
   * 上一步的解析结果。
   *
   * ⚠️ **只传增量与摘要**。累积状态必须留在插件模块作用域（闭包 / 模块级变量）——
   * 沙箱实例在多次调用之间是**存活**的，实测连续 3000 次调用后状态完好。
   * 把累积状态每步传进传出会让单步耗时随步数线性上升，合计 O(n²)：
   * 400 步时朴素写法 1.04 ms/步，状态留沙箱 19.0 µs/步 —— 差 54.7×。
   * 完整实测表见 spikes/p0/REPORT.md §5.3。
   */
  result: ParseResult;
  /** 上一步那个请求的 HTTP 状态码 */
  status: number;
}

export interface StepDirective {
  /** 下一个 parser/step 名 */
  next: string;
  requests: PlannedRequest[];
}

// ------------------------------------------------------------ 插件导出

/**
 * §5.5 的 `ConnectorPlugin`，逐字对应设计文档。
 *
 * 全部同步。宿主按 `plan → 校验 URL → 发请求 → parsers[name] → next` 驱动循环。
 */
export interface ConnectorPlugin {
  /** 声明「我需要哪些请求」。插件不碰网络，只产出请求描述。 */
  plan(input: PlanInput): RequestPlan;

  /** 纯函数解析：宿主把响应体当普通字符串传进来，插件算完返回普通 JSON。 */
  parsers: Record<string, (input: ParseInput) => ParseResult>;

  /** 多步流程：插件返回下一步指令，宿主执行后再调一次。 */
  next?(input: StepInput): StepDirective | null;
}

export interface PlanInput {
  /** 本次同步的触发原因 */
  trigger: 'initial' | 'scheduled' | 'manual';
  /** 上次同步留下的**增量**游标 */
  cursor?: string;
  /**
   * 宿主提供的当前时间（epoch ms）。
   * 插件**不得**自己读时钟 —— 沙箱内读到的时钟不可信，也让插件难以单测。
   */
  now: number;
  /** 非敏感的配置项。凭证走 `ctx.secrets`，不从这里进。 */
  settings?: Record<string, string>;
}

/**
 * 插件模块的完整导出面（宿主侧 broker 面向的对象）。
 *
 * 生命周期钩子也是同步的：宿主负责调度，插件只负责「现在该做什么」。
 */
export interface PluginExports {
  /**
   * 视图渲染函数，键是 manifest `contributes.views` 里的 `id`。
   *
   * 目录（有哪些视图）在 manifest 里，实现（怎么画）在这里 —— 宿主交叉核对两边。
   * 每个函数必须**同步且纯**：同样的 `ViewContext` 得到同样的树。
   */
  renders?: Readonly<Record<string, ViewRender>>;

  /** connector / logic 形态 */
  plan?(input: PlanInput): RequestPlan;
  parsers?: Record<string, (input: ParseInput) => ParseResult>;
  next?(input: StepInput): StepDirective | null;

  onActivate?(): void;
  onSuspend?(): void;
  onDeactivate?(): void;
}

// ------------------------------------------------------------ 握手

export interface HandshakeRequest {
  /** 插件声明的 apiVersion range */
  apiVersion: string;
  pluginVersion: string;
  kind: PluginKind;
}

export interface HandshakeOk {
  /** 宿主实际选定的 API 版本 */
  apiVersion: string;
  hostVersion: string;
  /**
   * 宿主能力清单。
   * **能力探测优于版本探测**：插件应查 `capabilities.includes('notify.local')`，
   * 而不是查平台名或版本号（§5.4）。
   */
  capabilities: string[];
}

/**
 * v1 规范定义的宿主能力清单 —— **这是上限，不是本机能力**。
 *
 * ⚠️ 这个区分很要紧，而且曾经搞错过：宿主以前直接把这份常量当作
 * `handshake().capabilities` 返回，于是插件探测 `db.namespaced` 拿到 `true`，
 * 然后去调一个根本不存在的方法。清单说的是「v1 允许有什么」，
 * 不是「这台机器有什么」。
 *
 * **插件作者要查的是握手返回的那个数组**，它是这份清单的**子集**，
 * 由宿主装配点如实申报（见 `PluginHost.IMPLEMENTED_CAPABILITIES`）。
 * 本包不导出任何「本机实现了什么」的常量 —— 那取决于宿主。
 *
 * 两份东西同名会让人分不清，所以这里刻意叫 `_V1`（规范版本），
 * 而运行时的那个叫 `capabilities`（实际能力）。
 */
export const HOST_CAPABILITIES_V1: readonly string[] = [
  'bus.emit',
  'bus.read',
  'db.namespaced',
  'net.request',
  'local.request',
  'notify.local',
  'schedule.periodic',
  'schedule.exact',
  'secrets.namespaced',
  'auth.login',
  'ui.registerComponent',
  // 二期能力：宿主尚未实现，**不在** v1 清单里
  // 'net.stream',
];

/** 默认的最大状态机步数。超过则宿主返回 `ETIMEOUT`（§5.5 流程第 6 步） */
export const DEFAULT_MAX_STEPS = 16;

/**
 * 写状态机时的硬性指导 —— 会被插件脚手架与文档反复引用。
 * 放在代码里，是为了让它在类型提示中可见，而不只是躺在设计文档第 380 行。
 */
export const STEP_STATE_GUIDANCE =
  '累积状态留在插件模块作用域内，跨边界只传增量与摘要。' +
  '把累积状态每步传进传出会让单步耗时随步数线性上升（合计 O(n²)）：' +
  '实测 400 步时 1.04 ms/步 vs 19.0 µs/步，差 54.7×。详见 spikes/p0/REPORT.md §5.3。';
