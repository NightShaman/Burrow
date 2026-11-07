import { build } from 'vite';
import react from '@vitejs/plugin-react';
await build({
  configFile: false,
  base: './',
  root: new URL('.', import.meta.url).pathname,
  plugins: [react()],
  define: { __BURROW_UI_BUILD_IDENTITY__: JSON.stringify('range-fixture') },
  build: { outDir: process.argv[2] || 'bundle', emptyOutDir: true },
});
