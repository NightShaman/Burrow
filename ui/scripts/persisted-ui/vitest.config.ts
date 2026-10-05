import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
export default defineConfig({plugins:[react()],test:{environment:'jsdom',pool:'forks',maxWorkers:1,include:['scripts/persisted-ui/acceptance.tsx'],setupFiles:['./src/test/isolation.ts'],testTimeout:20000}});
