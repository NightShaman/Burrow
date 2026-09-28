#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { createPostgresPool } from '../src/postgres-foundation.mjs';
import { migratePostgres } from '../src/postgres-migrations.mjs';
import { runPostgresCutover } from '../src/postgres-cutover.mjs';

// Explicit offline import only. Runtime must be stopped; source files are never removed.
const manifestPath = process.argv[2];
if (!manifestPath || process.argv.length !== 3) throw new Error('Usage: node scripts/postgres-import.mjs <source-manifest.json>');
const manifest = JSON.parse(await readFile(manifestPath,'utf8'));
const pool = createPostgresPool();
try {
 await migratePostgres(pool);
 const result = await runPostgresCutover(pool, manifest);
 process.stdout.write(JSON.stringify({ok:true,result})+'\n');
} finally { await pool.end(); }
