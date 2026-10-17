/**
 * 用 CDP 直接连**手机上**的 WebView，把表达式丢进去跑。
 *
 * 为什么不接着用 `adb shell input tap`：真机的 `uiautomator dump` 坐标和
 * `input tap` 的坐标不一定同一个空间（这台 V2352A 就差了 1.1667 倍），
 * 点哪儿全靠猜。走 WebView 调试端口就没有坐标这件事了 —— 直接读 DOM、
 * 直接 .click()，和浏览器里验证用的是同一套表达式文件。
 *
 * 用法：node tools/adb-cdp.mjs [表达式文件] [截图输出路径]
 * 前提：应用是 debug 包（capacitor.config 里 webContentsDebuggingEnabled）
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const ADB = `${process.env.LOCALAPPDATA}\\qin-toolchain\\android-sdk\\platform-tools\\adb.exe`;
const PKG = 'dev.matrix.shell';
const PORT = 9334;

const adb = (...args) => execFileSync(ADB, args, { encoding: 'utf8' }).trim();

const pid = adb('shell', 'pidof', PKG);
if (pid === '') throw new Error(`${PKG} 没在跑，先 am start 一下`);
adb('forward', `tcp:${PORT}`, `localabstract:webview_devtools_remote_${pid}`);
console.log(`已连上 ${PKG} (pid ${pid})`);

const arg = process.argv[2] ?? 'document.body.innerText';
const expression = arg.startsWith('@') ? readFileSync(arg.slice(1), 'utf8') : arg;

async function targets() {
  for (let i = 0; i < 40; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await res.json();
      const page = list.find((t) => t.type === 'page');
      if (page !== undefined) return page;
    } catch { /* 端口还没通 */ }
    await sleep(250);
  }
  throw new Error('WebView 的 DevTools 端点没起来');
}

const page = await targets();
const ws = new WebSocket(page.webSocketDebuggerUrl);
let seq = 0;
const pending = new Map();
const logs = [];

ws.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id !== undefined && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
    return;
  }
  if (msg.method === 'Runtime.consoleAPICalled') {
    logs.push(`console.${msg.params.type}: ` + msg.params.args.map((a) => a.value ?? a.description ?? a.type).join(' '));
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    const d = msg.params.exceptionDetails;
    logs.push(`exception: ${d.text} ${d.exception?.description ?? ''}`);
  }
});

function send(method, params = {}) {
  seq += 1;
  const id = seq;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

await new Promise((resolve) => ws.addEventListener('open', resolve, { once: true }));
await send('Runtime.enable');

const result = await send('Runtime.evaluate', {
  expression,
  awaitPromise: true,
  returnByValue: true,
});

if (result.result?.exceptionDetails) {
  console.log('EVAL ERROR: ' + JSON.stringify(result.result.exceptionDetails, null, 2));
} else {
  console.log(typeof result.result?.result?.value === 'string'
    ? result.result.result.value
    : JSON.stringify(result.result?.result?.value, null, 2));
}

const shot = process.argv[3];
if (shot !== undefined && shot !== '') {
  const captured = await send('Page.captureScreenshot', { format: 'png' });
  if (captured.result?.data !== undefined) {
    writeFileSync(shot, Buffer.from(captured.result.data, 'base64'));
    console.log(`screenshot -> ${shot}`);
  }
}

if (logs.length > 0) console.log('--- console ---\n' + logs.join('\n'));
ws.close();
adb('forward', '--remove', `tcp:${PORT}`);
