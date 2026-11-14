import { build } from 'vite';
import react from '@vitejs/plugin-react';
await build({
  configFile: false,
  base: './',
  root: new URL('.', import.meta.url).pathname,
  publicDir: new URL('../../public', import.meta.url).pathname,
  plugins: [react()],
  define: { __BURROW_UI_BUILD_IDENTITY__: JSON.stringify('codex-chat-fixture') },
  build: { outDir: process.env.FIXTURE_OUT || 'bundle', emptyOutDir: true },
});
