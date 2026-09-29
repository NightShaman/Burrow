#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import path from 'node:path';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const roots = ['src', 'scripts', 'bin', 'deploy'];
const forbidden = [
  ['node:sqlite', /node:sqlite/],
  ['legacy settings database', /settings\.sqlite|BURROW_SETTINGS_DB|settingsDatabasePath|openSettingsDatabase/],
  ['databasePath persistence option', /\bdatabasePath\b/],
  ['SQLite WAL plumbing', /\bwalBytes\b|\bshmBytes\b|journal_mode\s*=\s*WAL/i],
  ['legacy PostgreSQL importer', /postgres-(?:settings-|conversation-|auxiliary-)?import|postgres-cutover/],
];
const violations = [];
async function walk(dir) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(file);
    else if (/\.(?:mjs|js|sh)$/.test(entry.name) && entry.name !== 'check-postgres-only.mjs') {
      const text = await fs.readFile(file, 'utf8');
      for (const [label, pattern] of forbidden) if (pattern.test(text)) violations.push(`${path.relative(root, file)}: ${label}`);
    }
  }
}
for (const item of roots) await walk(path.join(root, item));
if (violations.length) { console.error(violations.join('\n')); process.exit(1); }
console.log('PostgreSQL-only source guard passed.');
