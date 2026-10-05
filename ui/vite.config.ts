import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const uiBuildIdentity = process.env.BURROW_UI_SHA || 'development';

export default defineConfig({
  define: { __BURROW_UI_BUILD_IDENTITY__: JSON.stringify(uiBuildIdentity) },
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5174,
    strictPort: true,
    proxy: {
      '/api': 'http://127.0.0.1:42817',
    },
  },
  preview: {
    host: '0.0.0.0',
    port: 4174,
    strictPort: true,
  },
});
