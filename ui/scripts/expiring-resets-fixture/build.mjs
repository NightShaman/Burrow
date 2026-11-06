import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { execFileSync } from 'node:child_process';
const before = process.argv.includes('--before');
await build({
  configFile: false,
  base: './',
  root: new URL('.', import.meta.url).pathname,
  plugins: [
    ...(before
      ? [
          {
            name: 'baseline-component',
            enforce: 'pre',
            load(id) {
              if (id.endsWith('/src/features/settings/ModelConnections.tsx'))
                return execFileSync(
                  'git',
                  ['show', '8ce9c0d:src/features/settings/ModelConnections.tsx'],
                  { encoding: 'utf8' },
                );
            },
          },
        ]
      : []),
    react(),
  ],
  build: { outDir: before ? 'bundle-before' : 'bundle', emptyOutDir: true },
});
