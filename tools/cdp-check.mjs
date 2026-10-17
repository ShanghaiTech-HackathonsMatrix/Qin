/**
 * 用 CDP 驱动无头 Edge 做真实浏览器验证。
 *
 * 为什么不用 `--dump-dom`：它按虚拟时间预算导出 DOM，WASM 加载、IndexedDB
 * 这类真实异步操作经常还没完成就导出了，看到的是一半的状态。这里直连
 * DevTools 协议，可以 await 真实 Promise，也能抓到 console 与页面异常。
 *
 * 用法：node tools/cdp-check.mjs <url> [表达式文件]
 */
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9333;
const url = process.argv[2] ?? 'http://127.0.0.1:5173/';
// 表达式以 @ 开头时从文件读，避免 PowerShell 的引号地狱
const arg = process.argv[3] ?? 'document.querySelector("#root")?.textContent?.replace(/\\s+/g," ").trim()';
const expression = arg.startsWith('@') ? readFileSync(arg.slice(1), 'utf8') : arg;

const child = spawn(EDGE, [
  '--headless=new',
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  `--remote-debugging-port=${PORT}`,
  '--user-data-dir=' + process.env.TEMP + '\\qin-cdp-profile',
  'about:blank',
], { stdio: 'ignore' });

async function targets() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await res.json();
      const page = list.find((t) => t.type === 'page');
      if (page !== undefined) return page;
    } catch { /* 还没起来 */ }
    await sleep(250);
  }
  throw new Error('DevTools 端点没起来');
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
await send('Page.enable');

// 可选：把视口固定成手机尺寸再导航，否则量到的是桌面宽度（~750px）
const vw = Number(process.argv[4] ?? 0);
const vh = Number(process.argv[5] ?? 0);
if (vw > 0 && vh > 0) {
  await send('Emulation.setDeviceMetricsOverride', {
    width: vw,
    height: vh,
    deviceScaleFactor: 2,
    mobile: true,
  });
}

await send('Page.navigate', { url });
await sleep(4000);

/**
 * 表达式文件里出现 `/* ---RELOAD--- *\/` 就分两段跑：
 * 先跑前段，然后整页重载，再跑后段。
 *
 * 用来验证「设置改了之后刷新还在不在」这类事情。
 * 注意必须在**同一个浏览器进程**里重载 —— 进程被强杀时 localStorage
 * 可能还没落盘，换进程再读会读到旧值，那是测试环境的问题，不是应用的。
 */
const RELOAD_MARK = '/* ---RELOAD--- */';
const parts = expression.includes(RELOAD_MARK) ? expression.split(RELOAD_MARK) : [expression];

for (let i = 0; i < parts.length; i += 1) {
  if (i > 0) {
    await send('Page.navigate', { url });
    await sleep(4000);
  }

  const result = await send('Runtime.evaluate', {
    expression: parts[i],
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
}

// 可选：把当前视口截成 PNG（argv[6] 是输出路径）
const shot = process.argv[6];
if (shot !== undefined && shot !== '') {
  const captured = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  if (captured.result?.data !== undefined) {
    writeFileSync(shot, Buffer.from(captured.result.data, 'base64'));
    console.log(`screenshot -> ${shot}`);
  } else {
    console.log('screenshot failed: ' + JSON.stringify(captured));
  }
}

if (logs.length > 0) console.log('--- console ---\n' + logs.join('\n'));

ws.close();
child.kill();
process.exit(0);
