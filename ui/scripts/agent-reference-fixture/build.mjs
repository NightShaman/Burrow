import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { execFileSync } from 'node:child_process';
const root = new URL('.', import.meta.url).pathname;
const before = process.argv.includes('--before');
await build({ configFile: false, base: './', root, plugins: [react(), ...(before ? [{ name: 'baseline', enforce: 'pre', load(id) { if (id.endsWith('/src/features/settings/AgentDetails.tsx')) return execFileSync('git', ['show', 'e1d564b:src/features/settings/AgentDetails.tsx'], { encoding: 'utf8' }); } }] : [])], resolve: { alias: [{ find: /.*app\/api$/, replacement: `${root}api.ts` }] }, build: { outDir: before ? 'bundle/before' : 'bundle/after', emptyOutDir: true } });
