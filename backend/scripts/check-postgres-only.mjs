#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const defaultRoot = fileURLToPath(new URL('..', import.meta.url));
const roots = ['src', 'scripts', 'bin', 'deploy', 'tests', 'docs'];
const exempt = (relative) => relative.startsWith('src/mods/') || relative.startsWith('tests/mods/');
const forbidden = [
  ['node:sqlite import', /(?:from\s*['"]node:sqlite['"]|import\s*\(\s*['"]node:sqlite['"]|require\s*\(\s*['"]node:sqlite['"])/],
  ['legacy settings database', /settings\.sqlite|BURROW_SETTINGS_DB|settingsDatabasePath|openSettingsDatabase/],
  ['databasePath persistence option', /\bdatabasePath\b/],
  ['SQLite WAL plumbing', /\bwalBytes\b|\bshmBytes\b|journal_mode\s*=\s*WAL/i],
  ['legacy PostgreSQL importer', /postgres-(?:settings-|conversation-|auxiliary-)?import|postgres-cutover/],
];
// Match the deleted module exactly, not the PostgreSQL store or mod stores.
const deletedSessionModule = /(?:^|[/'"`\s])session-store\.(?:mjs|js)(?=$|['"`\s?#])/m;
// Guard the core API and mod-host integration docs, not mod-owned SQLite options.
const coreDocs = new Set(['docs/api.md', 'docs/mod-host-capabilities.md']);
const obsoleteDocsDatabasePath = /\bloadMods\s*\(\s*\{[^}\n]*\bdatabasePath\b|\b(?:core|settings|session|conversation)\s+(?:persistence|database|store)\s+(?:option\s+)?\bdatabasePath\b/i;
const coreSessionFilename = /session\.(?:jsonl|meta\.json|(?:compacted|reset)\.[^\s'"`/]*\.jsonl)|(?:continuity-head|interrupted-run|recovery-queue|recovery-continuation|read-evidence|run-evidence)\.json/;

export async function checkPostgresOnly(root = defaultRoot) {
const violations = [];
async function walk(dir) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!exempt(path.relative(root, file).split(path.sep).join('/') + '/')) await walk(file);
    }
    else if (/\.(?:mjs|js|sh|md|json)$/.test(entry.name) && entry.name !== 'check-postgres-only.mjs' && !exempt(path.relative(root, file))) {
      const text = await fs.readFile(file, 'utf8');
      const relative = path.relative(root, file).split(path.sep).join('/');
      if (deletedSessionModule.test(text)) violations.push(`${relative}: deleted session-store module reference`);
      if (coreDocs.has(relative) && obsoleteDocsDatabasePath.test(text)) violations.push(`${relative}: obsolete core persistence databasePath documentation`);
      if (['src/', 'scripts/', 'bin/'].some(prefix => relative.startsWith(prefix)) && coreSessionFilename.test(text)) violations.push(`${relative}: core persisted session filename`);
      const patterns = relative.startsWith('tests/') || relative.startsWith('docs/') ? forbidden.filter(([label]) => label === 'node:sqlite import' || label === 'legacy PostgreSQL importer') : ['.mjs','.js','.sh'].includes(path.extname(file)) ? forbidden : forbidden.filter(([label]) => label === 'node:sqlite import' || label === 'legacy PostgreSQL importer');
      for (const [label, pattern] of patterns) if (pattern.test(text)) violations.push(`${relative}: ${label}`);
    }
  }
}
for (const item of roots) {
  try { await walk(path.join(root, item)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
if (await fs.stat(path.join(root, 'src/session-store.mjs')).catch(error => { if (error.code === 'ENOENT') return null; throw error; })) violations.push('src/session-store.mjs: deleted session-store module restored');
for (const manifest of ['package.json', 'package-lock.json']) {
  const text = await fs.readFile(path.join(root, manifest), 'utf8');
  if (/['"](?:better-sqlite3|sqlite3|sqlite)['"]\s*:/.test(text)) violations.push(`${manifest}: core SQLite dependency`);
}
return violations;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const violations = await checkPostgresOnly();
  if (violations.length) { console.error(violations.join('\n')); process.exitCode = 1; }
  else console.log('PostgreSQL-only source guard passed.');
}
