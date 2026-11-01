import { build } from 'vite';
import react from '@vitejs/plugin-react';
await build({
  configFile: false,
  define: { __BURROW_UI_BUILD_IDENTITY__: JSON.stringify('isolated-native-thinking') },
  root: new URL('.', import.meta.url).pathname,
  plugins: [react()],
  build: { outDir: 'bundle', emptyOutDir: true },
});
