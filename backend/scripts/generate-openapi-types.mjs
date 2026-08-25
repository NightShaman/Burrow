#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const specPath = path.join(root, 'docs', 'openapi.json');
const outputPath = path.join(root, 'docs', 'openapi-types.ts');

function refName(ref) { return ref.split('/').at(-1); }
function tsType(schema = {}) {
  if (schema.$ref) return refName(schema.$ref);
  if (schema.const !== undefined) return JSON.stringify(schema.const);
  if (Array.isArray(schema.type)) return schema.type.map((type) => type === 'null' ? 'null' : primitive(type)).join(' | ');
  if (schema.enum) return schema.enum.map((value) => JSON.stringify(value)).join(' | ');
  if (schema.oneOf) return schema.oneOf.map(tsType).join(' | ');
  if (schema.anyOf) return schema.anyOf.map(tsType).join(' | ');
  if (schema.type === 'array') return `Array<${tsType(schema.items || {})}>`;
  if (schema.type === 'object' || schema.properties) {
    if (!schema.properties) return 'Record<string, unknown>';
    return inlineObject(schema);
  }
  return primitive(schema.type);
}
function primitive(type) {
  return ({ string: 'string', number: 'number', integer: 'number', boolean: 'boolean', object: 'Record<string, unknown>', null: 'null' })[type] || 'unknown';
}
function inlineObject(schema) {
  const required = new Set(schema.required || []);
  const fields = Object.entries(schema.properties || {}).map(([name, value]) => `  ${safeKey(name)}${required.has(name) ? '' : '?'}: ${tsType(value)};`);
  return fields.length ? `{\n${fields.join('\n')}\n}` : 'Record<string, unknown>';
}
function safeKey(name) { return /^[A-Za-z_$][\w$]*$/.test(name) ? name : JSON.stringify(name); }
function schemaBlock(name, schema) {
  const type = tsType(schema);
  return type.startsWith('{\n') ? `export interface ${name} ${type}\n` : `export type ${name} = ${type};\n`;
}
function operationTypes(spec) {
  const rows = [];
  for (const [route, pathItem] of Object.entries(spec.paths)) {
    for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
      const operation = pathItem[method];
      if (!operation?.operationId) continue;
      const success = Object.entries(operation.responses || {}).find(([status]) => /^2/.test(status))?.[1];
      const response = success?.$ref && success.$ref.startsWith('#/components/responses/')
        ? spec.components.responses[refName(success.$ref)]
        : success;
      const responseSchema = response?.content?.['application/json']?.schema?.$ref
        ? refName(response.content['application/json'].schema.$ref)
        : 'JsonObject';
      rows.push(`  ${JSON.stringify(operation.operationId)}: { method: ${JSON.stringify(method.toUpperCase())}; path: ${JSON.stringify(route)}; response: ${responseSchema}; };`);
    }
  }
  return rows.join('\n');
}

const spec = JSON.parse(await readFile(specPath, 'utf8'));
const lines = [
  '/* eslint-disable */',
  '// Generated from docs/openapi.json. Do not edit by hand.',
  `// OpenAPI version: ${spec.openapi}; contract version: ${spec.info?.version || 'unknown'}.`,
  '',
];
for (const [name, schema] of Object.entries(spec.components?.schemas || {})) lines.push(schemaBlock(name, schema), '');
lines.push('export interface BurrowOperationMap {', operationTypes(spec), '}', '');
lines.push('export type BurrowOperationId = keyof BurrowOperationMap;');
const expected = `${lines.join('\n')}\n`;
if (process.argv.includes('--check')) {
  const existing = await readFile(outputPath, 'utf8');
  if (existing !== expected) { console.error(`${path.relative(root, outputPath)} is stale; run npm run openapi:types`); process.exitCode = 1; }
} else {
  await writeFile(outputPath, expected, 'utf8');
}
if (process.argv.includes('--check')) {
  const existing = await readFile(outputPath, 'utf8');
  const expected = `${lines.join('\n')}\n`;
  if (existing !== expected) { console.error(`${path.relative(root, outputPath)} is stale; run npm run openapi:types`); process.exitCode = 1; }
}
