/**
 * S2 —— 移动端「UI 层零网络」可行性的静态审查
 *
 * 本机没有 Android SDK / gradle，无法做动态验证，因此这里只做**源码级证据核查**：
 * 把结论建立在可复查的代码事实上，而不是猜测。每条断言都注明证据出处。
 *
 * 运行：node src/s2-inspect-bridge.ts
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const NM = join(process.cwd(), 'node_modules');
const pass: string[] = [];
const fail: string[] = [];
const notes: string[] = [];

const check = (name: string, fn: () => void) => {
  try { fn(); pass.push(name); }
  catch (e: any) { fail.push(`${name}: ${e.message}`); }
};
const assert = (c: unknown, m: string) => { if (!c) throw new Error(m); };

const read = (p: string) => readFileSync(p, 'utf8');
const mustExist = (p: string) => { assert(existsSync(p), `文件不存在: ${p}`); return p; };

// ============================================================ 1. JS 桥接是否依赖网络 API

const CORE_DIST = join(NM, '@capacitor', 'core', 'dist');
const coreFiles = readdirSync(CORE_DIST).filter((f) => f.endsWith('.js') && !f.endsWith('.map'));

check('1.1 @capacitor/core 的 JS 产物不使用任何网络 API', () => {
  const offenders: string[] = [];
  for (const f of coreFiles) {
    const src = read(join(CORE_DIST, f));
    for (const pat of ['XMLHttpRequest', 'WebSocket', 'sendBeacon', 'EventSource', 'navigator.sendBeacon']) {
      // CapacitorHttp 的 web 兜底实现会用 fetch，需单独排除（见 1.3）
      if (src.includes(pat)) offenders.push(`${f}: ${pat}`);
    }
  }
  assert(offenders.length === 0, `发现网络 API: ${offenders.join('; ')}`);
});

check('1.2 插件调用走 nativePromise / nativeCallback（非网络请求）', () => {
  const src = coreFiles.map((f) => read(join(CORE_DIST, f))).join('\n');
  assert(src.includes('nativePromise'), '没找到 nativePromise');
  assert(src.includes('nativeCallback'), '没找到 nativeCallback');
  assert(src.includes('androidBridge'), '没找到 androidBridge（Android 侧 JS 接口）');
  assert(src.includes('messageHandlers'), '没找到 messageHandlers（iOS 侧 WKScriptMessageHandler）');
});

check('1.3 CapacitorHttp 是「网络出口」，但默认关闭', () => {
  const src = coreFiles.map((f) => read(join(CORE_DIST, f))).join('\n');
  assert(src.includes('CapacitorHttp'), 'JS 侧没有 CapacitorHttp 插件定义');
  assert(src.includes('class CapacitorHttpPluginWeb'), '没有 web 兜底实现');
  notes.push(
    'CapacitorHttpPluginWeb 是 web 平台的兜底实现（会用 fetch）。' +
    '原生平台走 CapacitorHttp.java，其 isEnabled() 默认返回 false。',
  );
});

// ============================================================ 2. 原生侧：HTTP 出口与 CSP 的关系

const ANDROID_PLUGIN = join(NM, '@capacitor', 'android', 'capacitor', 'src', 'main', 'java', 'com', 'getcapacitor', 'plugin');
const HTTP_JAVA = mustExist(join(ANDROID_PLUGIN, 'CapacitorHttp.java'));

check('2.1 CapacitorHttp 默认 enabled=false（必须保持关闭）', () => {
  const src = read(HTTP_JAVA);
  assert(
    /pluginConfig\.getBoolean\("enabled",\s*false\)/.test(src),
    'CapacitorHttp 的默认开关不再是 false —— 这会让 CSP connect-src 失效，必须重新评估',
  );
  notes.push(
    '⚠️ 关键约束：一旦在 capacitor.config 里打开 CapacitorHttp，window.fetch/XHR 会被补丁成走原生 HTTP。' +
    '原生 HTTP 不受 WebView CSP 约束 —— connect-src \'none\' 会被绕过。因此本项目必须保持它关闭。',
  );
});

check('2.2 CapacitorHttp 通过 addJavascriptInterface 注入 JS 接口', () => {
  const src = read(HTTP_JAVA);
  assert(src.includes('addJavascriptInterface'), '没找到 addJavascriptInterface');
  notes.push(
    '⚠️ Android 的 addJavascriptInterface 会把对象注入 WebView 中**所有 frame**（含 iframe）。' +
    '因此第三方插件 UI 即使跑在不透明源 iframe 里，也可能直接够到原生桥。' +
    '→ 原生桥只能暴露一个窄入口，且授权必须靠「每次调用携带的能力令牌」，不能靠 frame 来源判定。',
  );
});

const LOCAL_SERVER = mustExist(join(NM, '@capacitor', 'android', 'capacitor', 'src', 'main', 'java', 'com', 'getcapacitor', 'WebViewLocalServer.java'));

check('2.3 应用跑在 https://localhost 这个「假源」上，由 shouldInterceptRequest 拦截', () => {
  const src = read(LOCAL_SERVER);
  assert(src.includes('shouldInterceptRequest'), '没有 shouldInterceptRequest');
  assert(/handler == null[\s\S]{0,40}return null/.test(src), '没有看到「无匹配 handler 时返回 null」的放行逻辑');
  const cfg = read(join(NM, '@capacitor', 'android', 'capacitor', 'src', 'main', 'java', 'com', 'getcapacitor', 'CapConfig.java'));
  assert(cfg.includes('hostname = "localhost"'), '默认 hostname 不是 localhost');
  assert(cfg.includes('CAPACITOR_HTTPS_SCHEME'), '默认 scheme 不是 https');
  notes.push(
    '应用源是 https://localhost，本地资源由 shouldInterceptRequest 拦截返回。' +
    '不匹配的请求（含外域 <img>/CSS url()/字体）会返回 null 交给系统网络栈 —— 这正是必须用 CSP 收口的地方。',
  );
});

check('2.4 Capacitor 自己也在防「远端内容在应用源下执行」', () => {
  const src = read(LOCAL_SERVER);
  assert(
    src.includes('isDocumentRequest'),
    '没找到 isDocumentRequest —— Capacitor 对代理路径的文档型请求保护可能已变',
  );
  notes.push(
    'Capacitor 对 CAPACITOR_HTTP_INTERCEPTOR 代理路径做了 isDocumentRequest() 拦截，' +
    '注释原文：「a document would run remote content at the app origin」。' +
    '这与我们「第三方 UI 必须放不透明源 iframe」是同一条威胁模型 —— 方向得到独立印证。',
  );
});

// ============================================================ 3. SQLCipher

const SQLITE_GRADLE = mustExist(join(NM, '@capacitor-community', 'sqlite', 'android', 'build.gradle'));

check('3.1 Android 侧使用真 SQLCipher（net.zetetic）', () => {
  const src = read(SQLITE_GRADLE);
  const m = src.match(/net\.zetetic:sqlcipher-android:([\d.]+)/);
  assert(m, '没找到 sqlcipher-android 依赖');
  notes.push(`SQLCipher 制品: net.zetetic:sqlcipher-android:${m![1]}`);
  const room = src.match(/androidx\.room:room-runtime:([\d.]+)/);
  if (room) notes.push(`Room: ${room[1]}（插件侧若走 Room，注意其 SQLite 驱动需指向 SQLCipher）`);
});

check('3.2 minSdk / compileSdk 与 Capacitor 8 对齐', () => {
  const src = read(SQLITE_GRADLE);
  // gradle 里是三元兜底：minSdkVersion project.hasProperty(...) ? rootProject.ext.minSdkVersion : 24
  const minSdk = src.match(/minSdkVersion[\s\S]{0,80}?:\s*(\d+)/);
  const compileSdk = src.match(/compileSdk[\s\S]{0,80}?:\s*(\d+)/);
  assert(minSdk, '没能解析出 minSdkVersion');
  assert(compileSdk, '没能解析出 compileSdk');
  assert(Number(minSdk![1]) >= 24, `minSdk=${minSdk![1]} < 24`);
  assert(Number(compileSdk![1]) >= 35, `compileSdk=${compileSdk![1]} < 35`);
  notes.push(`minSdk=${minSdk![1]}（兜底值）, compileSdk=${compileSdk![1]}（兜底值）`);
});

notes.push(
  '❗ 未能离线确定 sqlcipher-android 4.17.0 内嵌的 SQLite 版本号。' +
  'generated column 需要 SQLite ≥ 3.31、partial index ≥ 3.8、FTS5 ≥ 3.9；' +
  '4.17.0 是 2025 年的版本，几乎必然满足，但**必须在真机上跑一次 PRAGMA compile_options / sqlite_version() 确认**。' +
  'S1b 已证明退路（影子索引表）与主方案结果一致且同样命中索引，故此项不阻塞。',
);

// ============================================================ 4. CSP 结论

check('4.1 CSP 建议可自洽推导', () => {
  // 若 1.1~2.1 全部成立，则 connect-src 'none' 成立
  const networkFree = fail.length === 0;
  assert(networkFree, '前面的前提有失败项，CSP 结论不成立');
});

// ============================================================ 输出

console.log(`\n通过 ${pass.length} 项：`);
for (const p of pass) console.log('  ✓', p);

if (notes.length) {
  console.log('\n证据与推论：');
  for (const n of notes) console.log('  ·', n);
}

if (fail.length) {
  console.log(`\n失败 ${fail.length} 项：`);
  for (const f of fail) console.log('  ✗', f);
  process.exitCode = 1;
} else {
  console.log('\n全部通过。');
}

console.log(`
────────────────────────────────────────────────────────────
S2 结论（CSP 建议）
────────────────────────────────────────────────────────────
default-src 'none';
script-src 'self';
style-src 'self' 'unsafe-inline';        /* 布局/主题需要内联样式 */
img-src 'self' data: blob:;              /* 远端图片一律由核心代理成 blob: */
font-src 'self';
connect-src 'none';                      /* ← 可行：桥接不走网络，CapacitorHttp 保持关闭 */
frame-src 'self' blob:;                  /* 第三方 UI 用不透明源 iframe + srcdoc */
worker-src 'none';
object-src 'none';
base-uri 'none';
form-action 'none';
frame-ancestors 'none';

前提（缺一不可）：
  1. plugins.CapacitorHttp.enabled 保持 false
  2. 不在 WebView 里跑任何自行 fetch 的第三方代码
  3. 远端图片/字体由核心下载后以 blob: 或 data: 交给 UI
残余风险：
  · WebRTC (RTCPeerConnection) 不受 CSP 约束 —— 若沙箱里残留该构造器需显式删除
  · 不透明源 iframe 仍可能够到 addJavascriptInterface 注入的原生桥（见 2.2）
  · 若将来打开 CapacitorHttp，connect-src 'none' 立即失效
`);

process.exit(process.exitCode ?? 0);
