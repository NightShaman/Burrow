#!/usr/bin/env node
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const routerPaths = [
  path.join(root, 'scripts', 'burrow-ui.mjs'),
  ...(await readdir(path.join(root, 'scripts', 'ui'))).filter((name) => name.endsWith('.mjs')).map((name) => path.join(root, 'scripts', 'ui', name)),
];
const specPath = path.join(root, 'docs', 'openapi.json');
const source = (await Promise.all(routerPaths.map((routerPath) => readFile(routerPath, 'utf8')))).join('\n');
const spec = JSON.parse(await readFile(specPath, 'utf8'));

const literalRoutes = new Set();
for (const match of source.matchAll(/url\.pathname\s*===\s*['"](\/api\/[^'"]+)['"]/g)) literalRoutes.add(match[1]);
const templateRoutes = new Set();
for (const route of literalRoutes) {
  if (route.includes('/')) templateRoutes.add(route);
}
const documented = new Set(Object.keys(spec.paths));
// These serve the contract/documentation UI itself rather than product API operations.
const ignoredExact = new Set(['/api/openapi.json', '/api/docs']);
const ignoredPrefixes = [];
const normalize = (route) => route
  .replace(/\/[^/]+(?=\/cancel$)/, '/{runId}')
  .replace(/\/[^/]+$/, (suffix, offset, whole) => whole.includes('/agents/') ? '/{agentId}' : suffix);
const missing = [...literalRoutes]
  .filter((route) => !ignoredExact.has(route) && !ignoredPrefixes.some((prefix) => route.startsWith(prefix)))
  .filter((route) => !documented.has(route) && !documented.has(normalize(route)));
if (missing.length) {
  console.error('Undocumented literal API routes:');
  for (const route of missing) console.error(`- ${route}`);
  process.exitCode = 1;
} else {
  console.log(`OpenAPI route drift check passed (${documented.size} documented paths; ${literalRoutes.size} literal router routes inspected).`);
}
