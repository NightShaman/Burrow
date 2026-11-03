import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { execFileSync } from 'node:child_process';
const before = process.argv.includes('--before');
await build({
  configFile: false,
  root: new URL('.', import.meta.url).pathname,
  plugins: [
    before && {
      name: 'exact-base-context-meter',
      enforce: 'pre',
      transform(code, id) {
        if (id.endsWith('/src/features/workspace/WorkspaceRail.tsx')) {
          return execFileSync('git', ['show', 'b1fcdf5:src/features/workspace/WorkspaceRail.tsx'], {
            encoding: 'utf8',
          });
        }
      },
    },
    react(),
  ],
  build: { outDir: 'bundle', emptyOutDir: true },
});
