#!/usr/bin/env node
import process from 'node:process';

function parseArgs(argv) {
  const args = { json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') {
      args.json = true;
      continue;
    }
    if (arg === '--url') {
      args.url = argv[++i];
      continue;
    }
    if (arg === '--timeout-ms') {
      args.timeoutMs = Number(argv[++i]);
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      args.help = true;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

function usage() {
  return `Usage: node scripts/health-check.mjs [--url URL] [--timeout-ms N] [--json]\n\nDefaults:\n  URL: BURROW_HEALTH_URL or http://127.0.0.1:42817/health\n`;
}

function summarize(health) {
  return {
    ok: Boolean(health?.ok),
    runtime: health?.runtime || 'unknown',
    config: typeof health?.config?.exists === 'boolean' ? health.config.exists : null,
    ui: {
      host: health?.ui?.host || null,
      port: health?.ui?.port || null,
      authEnabled: (typeof health?.ui?.authEnabled === 'boolean' ? health?.ui?.authEnabled : null),
    },
    model: {
      configured: (typeof health?.model?.configured === 'boolean' ? health?.model?.configured : null),
      api: health?.model?.api || null,
      model: health?.model?.model || null,
    },
    memory: {
      configured: (typeof health?.memory?.configured === 'boolean' ? health?.memory?.configured : null),
      project: health?.memory?.project || null,
      hasApiKey: (typeof health?.memory?.hasApiKey === 'boolean' ? health?.memory?.hasApiKey : null),
    },
    policy: {
      packs: health?.policy?.packs ?? null,
    },
  };
}

function formatText(summary) {
  const lines = [];
  lines.push(`Burrow health: ${summary.ok ? 'ok' : 'not ok'}`);
  lines.push(`UI: ${summary.ui.host || '?'}:${summary.ui.port || '?'} auth=${summary.ui.authEnabled === null ? 'unknown' : summary.ui.authEnabled ? 'on' : 'off'}`);
  lines.push(`Model: ${summary.model.configured === null ? 'unknown' : summary.model.configured ? 'configured' : 'selection required'} ${summary.model.model || ''}`.trim());
  lines.push(`Memory: ${summary.memory.configured === null ? 'unknown' : summary.memory.configured ? 'configured' : 'missing'} ${summary.memory.project || ''}`.trim());
  lines.push(`Policy packs: ${summary.policy.packs ?? 'unknown'}`);
  return lines.join('\n');
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(usage());
  process.exit(0);
}

const url = args.url || process.env.BURROW_HEALTH_URL || 'http://127.0.0.1:42817/health';
const timeoutMs = Number.isFinite(args.timeoutMs) ? args.timeoutMs : 5000;
if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new Error('invalid timeout');
const signal = AbortSignal.timeout(timeoutMs);

try {
  const response = await fetch(url, { signal });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { ok: false, error: text };
  }
  const summary = summarize(body);
  const ok = response.ok && summary.ok;
  const output = { ok, status: response.status, url, summary, raw: body };
  if (args.json) console.log(JSON.stringify(output, null, 2));
  else console.log(formatText(summary));
  process.exit(ok ? 0 : 1);
} catch (error) {
  const output = { ok: false, url, error: String(error?.message || error) };
  if (args.json) console.log(JSON.stringify(output, null, 2));
  else console.error(`Burrow health: failed (${output.error})`);
  process.exit(1);
}
