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
  ios: {
    // 与 Android 的 backgroundColor 对齐，避免启动瞬间白闪
    backgroundColor: '#0f1115',
    // 内容铺到安全区里，由 CSS 的 env(safe-area-inset-*) 自己处理内边距。
    // 交给系统自动缩进的话，底部 Tab 栏在带刘海的机型上会多出一条空隙。
    contentInset: 'never',
    // 真机上跑明文 HTTP 会被 ATS 拦掉 —— 这个项目所有出网都走核心层，
    // 而且核心层只走 https，所以这里**不**开任何 ATS 例外。
  },
  server: {
    androidScheme: 'https',
    // iOS 的 scheme 与 Android 分开配：默认值是 'capacitor'，
    // 但我们的 CSP 与鉴权都按 https 写的，两端必须一致。
    iosScheme: 'https',
  },
  // ⚠️ 架构不变量 I7：绝不能打开 CapacitorHttp。
  // 一旦打开，window.fetch/XHR 会被补丁成走原生 HTTP，
  // 而原生 HTTP 不受 WebView CSP 约束 —— connect-src 'none' 会当场失效。
};

export default config;
