#!/usr/bin/env node
// The orchestrator owns selection; the frozen backend owns its isolated test runner.
import { readFileSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const manifest = JSON.parse(readFileSync(new URL('./public-critical-backend.json', import.meta.url), 'utf8'));
export function selectedFiles(root, selection = manifest) {
  if (selection.schemaVersion !== 1 || !Array.isArray(selection.files) || selection.files.length < 1 || new Set(selection.files).size !== selection.files.length) throw Error('invalid critical backend manifest');
  for (const file of selection.files) {
    if (!/^tests\/[a-z0-9-]+(?:\.integration)?\.test\.mjs$/.test(file) || !statSync(join(root, file)).isFile()) throw Error(`missing or invalid critical test: ${file}`);
  }
  return selection.files;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(process.argv[2] || '');
  if (!process.argv[2]) throw Error('usage: run-critical-backend.mjs BACKEND_ROOT');
  const files = selectedFiles(root);
  console.log(`Public critical backend: ${files.length} files (isolated disposable PostgreSQL runner)`);
  const result = spawnSync('npm', ['run', 'test:files', '--', ...files], { cwd: root, env: process.env, stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}
