// Scoped named-import maintenance check for CLEAN02. Parse syntax, not string matches:
// keep the explicit inventory limited to reviewed modules, rather than guessing
// whether unrelated entry points or public facades are unused project-wide.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parse } from 'acorn';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export function unusedNamedImports(source) {
  const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
  const candidates = new Set();
  for (const node of ast.body) {
    if (node.type === 'ImportDeclaration') for (const specifier of node.specifiers) candidates.add(specifier.local.name);
  }
  const used = new Set();
  const visit = (node, parent = null, key = '') => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'Identifier' && candidates.has(node.name)) {
      const ignored = parent && (
        (parent.type === 'ImportSpecifier' || parent.type === 'ImportDefaultSpecifier' || parent.type === 'ImportNamespaceSpecifier')
        || (parent.type === 'FunctionDeclaration' && key === 'id')
        || (parent.type === 'VariableDeclarator' && key === 'id')
        || (parent.type === 'Property' && key === 'key' && !parent.computed && !parent.shorthand)
        || ((parent.type === 'MemberExpression' || parent.type === 'MethodDefinition') && key === 'property' && !parent.computed)
        || (parent.type === 'ExportSpecifier' && key === 'exported' && parent.local !== node)
      );
      if (!ignored) used.add(node.name);
    }
    for (const [childKey, value] of Object.entries(node)) {
      if (childKey === 'start' || childKey === 'end' || childKey === 'loc') continue;
      if (Array.isArray(value)) value.forEach(child => visit(child, node, childKey));
      else if (value && typeof value === 'object') visit(value, node, childKey);
    }
  };
  visit(ast);
  // A plain identifier walk cannot resolve a shadowed import. Keep these
  // ambiguous bindings out of automatic deletion recommendations.
  const shadowed = new Set();
  const patternNames = (pattern, add) => {
    if (!pattern) return;
    if (pattern.type === 'Identifier') { if (candidates.has(pattern.name)) add(pattern.name); return; }
    if (pattern.type === 'RestElement' || pattern.type === 'AssignmentPattern') { patternNames(pattern.argument || pattern.left, add); return; }
    if (pattern.type === 'ArrayPattern') { for (const item of pattern.elements) patternNames(item, add); return; }
    if (pattern.type === 'ObjectPattern') { for (const item of pattern.properties) patternNames(item.value || item.argument, add); }
  };
  const findShadows = node => {
    if (!node || typeof node !== 'object') return;
    if (/^(?:FunctionDeclaration|FunctionExpression|ArrowFunctionExpression)$/.test(node.type)) {
      if (node.id) patternNames(node.id, name => shadowed.add(name));
      for (const param of node.params) patternNames(param, name => shadowed.add(name));
    }
    if (node.type === 'CatchClause') patternNames(node.param, name => shadowed.add(name));
    if (node.type === 'VariableDeclarator') patternNames(node.id, name => shadowed.add(name));
    if (node.type === 'ClassDeclaration' || node.type === 'ClassExpression') patternNames(node.id, name => shadowed.add(name));
    for (const [key, child] of Object.entries(node)) {
      if (key === 'start' || key === 'end' || key === 'loc') continue;
      if (Array.isArray(child)) child.forEach(findShadows);
      else if (child && typeof child === 'object') findShadows(child);
    }
  };
  findShadows(ast);
  // Ambiguous shadowing is deliberately left to a human rather than emitted as
  // an unused import (which could be a false positive for an outer use).
  return [...candidates].filter(name => !used.has(name) && !shadowed.has(name));
}

const files = [
  'scripts/burrow-ui.mjs', 'src/agent-registry.mjs', 'src/app-runtime.mjs', 'src/dream-cycle-runner.mjs',
  'src/context-engine.mjs', 'src/completion-addendum.mjs', 'src/doctor.mjs',
  'src/model-adapter.mjs', 'src/mod-runtime.mjs', 'src/mcp-settings-store.mjs',
  'src/model-settings-store.mjs', 'src/model-adapters/openai.mjs',
  'src/postgres-composition.mjs', 'src/runtime-prompt-context.mjs',
  'src/runtime-plain-chat-finalizer.mjs', 'src/runtime-orchestrator.mjs',
  'src/session-compression.mjs', 'src/scheduled-job-store.mjs',
  'src/harness/write-file.mjs', 'src/model-adapters/openai-generated-artifacts.mjs',
  'src/model-adapters/adapter-primitives.mjs',
];
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const failures = [];
  for (const file of files) {
    for (const name of unusedNamedImports(readFileSync(path.join(root, file), 'utf8'))) {
      failures.push(`${file}: ${name}`);
    }
  }
  if (failures.length) { console.error(`Unused imports in reviewed modules:\n${failures.join('\n')}`); process.exitCode = 1; }
  else console.log(`No unused bindings in ${files.length} reviewed modules`);
}
