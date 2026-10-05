import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    css: { include: /.css/ },
    setupFiles: ['./src/test/isolation.ts'],
    clearMocks: true,
    restoreMocks: true,
  },
});
