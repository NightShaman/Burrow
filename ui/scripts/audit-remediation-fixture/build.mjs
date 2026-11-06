import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { copyFile, mkdir } from 'node:fs/promises';
const root = new URL('.', import.meta.url).pathname;
await build({
  configFile: false,
  root,
  publicDir: new URL('../../public', import.meta.url).pathname,
  plugins: [react()],
  define: { __BURROW_UI_BUILD_IDENTITY__: JSON.stringify('audit-remediation-fixture') },
  build: { outDir: 'bundle', emptyOutDir: true },
});
const modDirectory = new URL('./bundle/api/mods/fixture-extension/ui/', import.meta.url);
await mkdir(modDirectory, { recursive: true });
await copyFile(new URL('./fixture-mod.js', import.meta.url), new URL('settings.js', modDirectory));
