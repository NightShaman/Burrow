import { readFileSync } from 'node:fs';
import path from 'node:path';

const FALLBACK_CLAUDE_CODE_VERSION = '2.1.251';
function installedClaudeCodeVersion({ claudeBin = process.env.BURROW_CLAUDE_BIN, runtimeRoot = process.env.BURROW_RUNTIME_ROOT } = {}) {
  const candidates = [];
  if (claudeBin) candidates.push(path.resolve(path.dirname(claudeBin), '..', '@anthropic-ai', 'claude-code', 'package.json'));
  if (runtimeRoot) candidates.push(path.join(path.resolve(runtimeRoot), 'integrations', 'claude-code', 'node_modules', '@anthropic-ai', 'claude-code', 'package.json'));
  for (const candidate of candidates) { try { const version = String(JSON.parse(readFileSync(candidate, 'utf8')).version || '').trim(); if (/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) return version; } catch {} }
  return FALLBACK_CLAUDE_CODE_VERSION;
}
export const CLAUDE_CODE_VERSION = installedClaudeCodeVersion();
export const CLAUDE_CODE_BILLING_SYSTEM_BLOCK = `x-anthropic-billing-header: cc_version=${CLAUDE_CODE_VERSION}; cc_entrypoint=sdk-cli;`;
export { installedClaudeCodeVersion };
