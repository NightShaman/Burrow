import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { execFileSync } from 'node:child_process';
const root = new URL('.', import.meta.url).pathname;
const before = process.argv.includes('--before');
const baseline = process.argv.find(arg => arg.startsWith('--baseline='))?.slice('--baseline='.length) || 'e1d564b';
await build({ configFile: false, base: './', root, plugins: [react(), ...(before ? [{ name: 'baseline', enforce: 'pre', load(id) { const path = ['AgentDetails.tsx', 'AgentReferencePhoto.tsx'].find(name => id.endsWith(`/src/features/settings/${name}`)); if (path && !(baseline === 'e1d564b' && path === 'AgentReferencePhoto.tsx')) return execFileSync('git', ['show', `${baseline}:src/features/settings/${path}`], { encoding: 'utf8' }); } }] : [])], resolve: { alias: [{ find: /.*app\/api$/, replacement: `${root}api.ts` }] }, build: { outDir: before ? 'bundle/before' : 'bundle/after', emptyOutDir: true } });
