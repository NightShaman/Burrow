import { build } from 'vite';
import react from '@vitejs/plugin-react';
await build({
  configFile: false,
  root: new URL('.', import.meta.url).pathname,
  publicDir: new URL('../../public', import.meta.url).pathname,
  plugins: [react()],
  define: { __BURROW_UI_BUILD_IDENTITY__: JSON.stringify('fidgit-fixture') },
  build: { outDir: 'bundle', emptyOutDir: true },
});
const { mkdir, copyFile } = await import('node:fs/promises');
const modDirectory = new URL('./bundle/api/mods/fixture-extension/ui/', import.meta.url);
await mkdir(modDirectory, { recursive: true });
await copyFile(new URL('./fixture-mod.js', import.meta.url), new URL('settings.js', modDirectory));
