import { build } from 'vite';
import react from '@vitejs/plugin-react';
await build({
  configFile: false,
  root: new URL('.', import.meta.url).pathname,
  publicDir: false,
  plugins: [react()],
  define: { __BURROW_UI_BUILD_IDENTITY__: JSON.stringify('residual-ui-fixture') },
  build: { outDir: 'bundle', emptyOutDir: true },
});
