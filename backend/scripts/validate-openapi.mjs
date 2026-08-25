#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createConfig, lintFromString } from '@redocly/openapi-core';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const file = path.join(root, 'docs', 'openapi.json');
const source = await readFile(file, 'utf8');
const config = await createConfig({
  extends: ['recommended'],
  rules: {
    // Authentication is runtime-configurable (none, trusted-proxy, basic, OIDC),
    // so a single OpenAPI security scheme would misrepresent the deployed contract.
    'security-defined': 'off',
    'operation-4xx-response': 'off',
    'info-license': 'off',
    'tag-description': 'off',
    'no-unused-components': 'off',
  },
}, { configPath: file });
const problems = await lintFromString({ source, absoluteRef: file, config });
const errors = problems.filter((problem) => problem.severity === 'error');
const warnings = problems.filter((problem) => problem.severity === 'warn' || problem.severity === 'warning');
if (errors.length) {
  for (const problem of problems) console.error(`${problem.severity}: ${problem.message}`);
  process.exitCode = 1;
} else {
  console.log(`OpenAPI validation passed (0 errors, ${warnings.length} warnings).`);
}
