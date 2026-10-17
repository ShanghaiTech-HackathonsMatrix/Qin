import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'dev.matrix.shell',
  appName: 'Matrix',
  webDir: 'dist',
  android: {
    allowMixedContent: false,
    webContentsDebuggingEnabled: true,
    backgroundColor: '#0f1115',
  },
  server: {
    androidScheme: 'https',
  },
  // ⚠️ 架构不变量 I7：绝不能打开 CapacitorHttp。
  // 一旦打开，window.fetch/XHR 会被补丁成走原生 HTTP，
  // 而原生 HTTP 不受 WebView CSP 约束 —— connect-src 'none' 会当场失效。
};

export default config;
