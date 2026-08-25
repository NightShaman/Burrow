#!/usr/bin/env node
import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_PORT = 8765;
const MAX_SCAN_DEPTH = 4;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJsonFile(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch {
    return null;
  }
}

async function readJsonlFile(filePath) {
  try {
    const text = await fs.readFile(filePath, 'utf8');
    return text
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function walkFiles(dir, depth = 0) {
  if (depth > MAX_SCAN_DEPTH) return [];
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const files = [];
  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walkFiles(entryPath, depth + 1));
    } else if (entry.isFile()) {
      files.push(entryPath);
    }
  }
  return files;
}

function newestString(current, candidate) {
  return asString(candidate) ?? current;
}

function collectFromValue(value, summary) {
  if (Array.isArray(value)) {
    for (const item of value) collectFromValue(item, summary);
    return;
  }
  if (!isObject(value)) return;

  const type = asString(value.type)?.toLowerCase() ?? '';
  const event = asString(value.event)?.toLowerCase() ?? '';
  const name = asString(value.name)?.toLowerCase() ?? '';
  const kind = `${type} ${event} ${name}`;

  summary.latestSummary = summary.latestSummary ?? asString(value.summary);
  summary.latestSummary = newestString(summary.latestSummary, value.answer);
  summary.latestSummary = newestString(summary.latestSummary, value.finalAnswer);
  summary.latestSummary = newestString(summary.latestSummary, value.final_answer);

  if (isObject(value.result)) {
    summary.latestSummary = summary.latestSummary ?? asString(value.result.summary);
    summary.latestSummary = newestString(summary.latestSummary, value.result.answer);
  }

  if (isObject(value.output)) {
    summary.latestSummary = summary.latestSummary ?? asString(value.output.summary);
    summary.latestSummary = newestString(summary.latestSummary, value.output.answer);
  }

  summary.verificationStatus = newestString(summary.verificationStatus, value.verificationStatus);
  summary.verificationStatus = newestString(summary.verificationStatus, value.verification_status);
  if (isObject(value.verification)) {
    summary.verificationStatus = newestString(summary.verificationStatus, value.verification.status);
    summary.verificationStatus = newestString(summary.verificationStatus, value.verification.verdict);
    summary.verificationStatus = newestString(summary.verificationStatus, value.verification.result);
  }

  summary.commitStatus = newestString(summary.commitStatus, value.commitStatus);
  summary.commitStatus = newestString(summary.commitStatus, value.commit_status);
  if (isObject(value.commit)) {
    summary.commitStatus = newestString(summary.commitStatus, value.commit.status);
    summary.commitStatus = newestString(summary.commitStatus, value.commit.result);
    summary.commitStatus = newestString(summary.commitStatus, value.commit.sha);
  }

  if (Array.isArray(value.proposedActions)) summary.proposedActionCount += value.proposedActions.length;
  if (Array.isArray(value.proposed_actions)) summary.proposedActionCount += value.proposed_actions.length;
  if (Array.isArray(value.executedActions)) summary.executedActionCount += value.executedActions.length;
  if (Array.isArray(value.executed_actions)) summary.executedActionCount += value.executed_actions.length;
  if (Array.isArray(value.toolOutputs)) summary.executedActionCount += value.toolOutputs.length;
  if (Array.isArray(value.tool_outputs)) summary.executedActionCount += value.tool_outputs.length;

  if (Array.isArray(value.actions)) {
    if (kind.includes('execut') || kind.includes('tool-output') || kind.includes('tool output')) {
      summary.executedActionCount += value.actions.length;
    } else {
      summary.proposedActionCount += value.actions.length;
    }
  }

  if (kind.includes('propos') && (value.tool || value.command || value.filePath || value.file_path)) {
    summary.proposedActionCount += 1;
  }
  if ((kind.includes('execut') || kind.includes('tool-output') || kind.includes('tool output')) && (value.tool || value.command || value.filePath || value.file_path)) {
    summary.executedActionCount += 1;
  }

  for (const nested of Object.values(value)) {
    if (nested && typeof nested === 'object') collectFromValue(nested, summary);
  }
}

async function findRunDir(rootDir, runId) {
  const direct = path.join(rootDir, runId);
  if (await exists(direct)) return direct;
  if (path.basename(rootDir) === runId && await exists(rootDir)) return rootDir;
  return direct;
}

export async function summarizeTraceRun(rootDir, runId) {
  const runDir = await findRunDir(rootDir, runId);
  const stat = await fs.stat(runDir);
  const summary = {
    runId,
    path: runDir,
    createdAt: stat.birthtime.toISOString(),
    updatedAt: stat.mtime.toISOString(),
    latestSummary: null,
    verificationStatus: null,
    proposedActionCount: 0,
    executedActionCount: 0,
    commitStatus: null,
  };

  const files = await walkFiles(runDir);
  files.sort();

  for (const file of files) {
    const ext = path.extname(file).toLowerCase();
    const base = path.basename(file).toLowerCase();

    if (ext === '.json') {
      const json = await readJsonFile(file);
      if (json) collectFromValue(json, summary);
    } else if (ext === '.jsonl' || ext === '.ndjson') {
      for (const json of await readJsonlFile(file)) collectFromValue(json, summary);
    } else if ((ext === '.md' || ext === '.txt') && /summary|answer|result|final/u.test(base)) {
      try {
        const text = (await fs.readFile(file, 'utf8')).trim();
        if (text) summary.latestSummary = text;
      } catch {
        // Ignore unreadable optional files.
      }
    }
  }

  return summary;
}

export async function listTraceRuns(rootDir) {
  let entries;
  try {
    entries = await fs.readdir(rootDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const dirs = entries.filter((entry) => entry.isDirectory());
  const runs = [];
  for (const dir of dirs) {
    try {
      runs.push(await summarizeTraceRun(rootDir, dir.name));
    } catch {
      // Ignore malformed or concurrently removed trace run directories.
    }
  }

  runs.sort((a, b) => {
    const byUpdated = Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
    if (byUpdated !== 0) return byUpdated;
    return b.runId.localeCompare(a.runId);
  });
  return runs;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function renderValue(value, fallback = '—') {
  const text = asString(value);
  return escapeHtml(text ?? fallback);
}

function renderPage(runs) {
  const latest = runs[0] ?? null;
  const rows = runs.map((run) => `
    <tr>
      <td><code>${escapeHtml(run.runId)}</code></td>
      <td>${escapeHtml(new Date(run.updatedAt).toLocaleString())}</td>
      <td>${renderValue(run.verificationStatus)}</td>
      <td>${escapeHtml(run.proposedActionCount)}</td>
      <td>${escapeHtml(run.executedActionCount)}</td>
      <td>${renderValue(run.commitStatus)}</td>
    </tr>`).join('');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Burrow Trace UI</title>
  <style>
    :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; padding: 2rem; background: Canvas; color: CanvasText; }
    main { max-width: 1100px; margin: 0 auto; }
    h1 { margin-top: 0; }
    .card { border: 1px solid color-mix(in srgb, CanvasText 20%, transparent); border-radius: 12px; padding: 1rem 1.25rem; margin: 1rem 0; background: color-mix(in srgb, Canvas 92%, CanvasText 8%); }
    .summary { white-space: pre-wrap; line-height: 1.45; }
    table { width: 100%; border-collapse: collapse; margin-top: 1rem; }
    th, td { text-align: left; padding: 0.65rem; border-bottom: 1px solid color-mix(in srgb, CanvasText 16%, transparent); vertical-align: top; }
    th { font-size: 0.85rem; text-transform: uppercase; letter-spacing: 0.04em; }
    code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace; }
    pre { overflow-x: auto; padding: 0.8rem; border-radius: 8px; background: color-mix(in srgb, CanvasText 10%, transparent); }
    .muted { opacity: 0.72; }
  </style>
</head>
<body>
  <main>
    <h1>Burrow Trace UI</h1>
    <p class="muted">Recent trace runs from <code>./traces</code>.</p>

    <section class="card">
      <h2>Latest Summary</h2>
      ${latest ? `<p><strong>Run:</strong> <code>${escapeHtml(latest.runId)}</code></p>
      <p><strong>Verification:</strong> ${renderValue(latest.verificationStatus)} &nbsp; <strong>Proposed actions:</strong> ${escapeHtml(latest.proposedActionCount)} &nbsp; <strong>Executed actions:</strong> ${escapeHtml(latest.executedActionCount)}${latest.commitStatus ? ` &nbsp; <strong>Commit:</strong> ${renderValue(latest.commitStatus)}` : ''}</p>
      <div class="summary">${renderValue(latest.latestSummary, 'No summary found for latest trace run.')}</div>` : '<p>No trace runs found.</p>'}
    </section>

    <section class="card">
      <h2>Copyable Commands</h2>
      <pre>node bin/burrow.mjs trace --latest --tool-output</pre>
      <pre>npm run service:smoke</pre>
    </section>

    <section class="card">
      <h2>Recent Runs</h2>
      <table>
        <thead>
          <tr><th>Run</th><th>Updated</th><th>Verification</th><th>Proposed</th><th>Executed</th><th>Commit</th></tr>
        </thead>
        <tbody>${rows || '<tr><td colspan="6">No trace runs found.</td></tr>'}</tbody>
      </table>
    </section>
  </main>
</body>
</html>`;
}

function parsePort(argv) {
  const index = argv.indexOf('--port');
  if (index >= 0 && argv[index + 1]) {
    const parsed = Number.parseInt(argv[index + 1], 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  const inline = argv.find((arg) => arg.startsWith('--port='));
  if (inline) {
    const parsed = Number.parseInt(inline.slice('--port='.length), 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_PORT;
}

export async function serveTraceUi({ rootDir = path.join(process.cwd(), 'traces'), host = '127.0.0.1', port = DEFAULT_PORT } = {}) {
  const server = http.createServer(async (_req, res) => {
    try {
      const runs = await listTraceRuns(rootDir);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(renderPage(runs));
    } catch (error) {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(`Trace UI error: ${error?.stack ?? error}`);
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  return server;
}

const isCli = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isCli) {
  const port = parsePort(process.argv.slice(2));
  const rootDir = path.join(process.cwd(), 'traces');
  const server = await serveTraceUi({ rootDir, port });
  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  console.log(`Trace UI listening on http://127.0.0.1:${actualPort}`);
}
