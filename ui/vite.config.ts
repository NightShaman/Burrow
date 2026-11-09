import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const uiBuildIdentity = process.env.BURROW_UI_SHA || 'development';

export default defineConfig({
  define: { __BURROW_UI_BUILD_IDENTITY__: JSON.stringify(uiBuildIdentity) },
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        // Output-level provenance is retained even when UI consumers are lazy or tree-shaken.
        banner: `globalThis.__BURROW_UI_BUILD_IDENTITY__ = ${JSON.stringify(uiBuildIdentity)};`,
      },
    },
  },
  server: {
    host: '0.0.0.0',
    port: 5174,
    strictPort: true,
    proxy: {
      // Preserve the browser-facing authority so backend origin checks compare
      // Origin with the Vite host, not the loopback proxy target.
      '/api': { target: 'http://127.0.0.1:42817', changeOrigin: false },
    },
  },
  preview: {
    host: '0.0.0.0',
    port: 4174,
    strictPort: true,
  },
});
