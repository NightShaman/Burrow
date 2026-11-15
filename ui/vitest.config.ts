import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    // DOM-heavy integration suites contend with the shared development host.
    // Bound parallelism rather than masking slow scheduling with longer timeouts.
    maxWorkers: 2,
    environment: 'jsdom',
    css: { include: /.css/ },
    setupFiles: ['./src/test/isolation.ts'],
    clearMocks: true,
    restoreMocks: true,
  },
});
