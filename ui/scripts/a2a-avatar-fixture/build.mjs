import { build } from 'vite';
import react from '@vitejs/plugin-react';
await build({
  configFile: false,
  base: './',
  root: new URL('.', import.meta.url).pathname,
  plugins: [react()],
  build: { outDir: process.env.A2A_FIXTURE_OUT ?? 'bundle', emptyOutDir: true },
});
