import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
const require = createRequire(new URL('../apps/shell/package.json', import.meta.url));
const { build } = await import(pathToFileURL(require.resolve('vite')).href);

// JavaScriptCore executes only our bundled first-party code, never downloaded scripts.
await build({
  root: fileURLToPath(new URL('../apps/shell/', import.meta.url)),
  configFile: false,
  build: {
    target: 'es2022', outDir: 'dist', emptyOutDir: false,
    lib: {
      entry: fileURLToPath(new URL('../apps/shell/src/platform/ios-widget-runtime.ts', import.meta.url)),
      name: 'MatrixWidgetRuntime', formats: ['iife'], fileName: () => 'ios-widget-runtime.js',
    },
  },
});
