import { redactAndTruncateText } from './redaction.mjs';

function string(value) { return typeof value === 'string' ? value.trim() : ''; }
function object(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
function safeDetail(value) {
  const detail = redactAndTruncateText(typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim() : '', { maxChars: 320 });
  return `${detail.text}${detail.truncated ? '…' : ''}`;
}

export function archiveToolResultForEntry(entry) {
  const normalized = object(entry?.metadata?.normalizedResult);
  if (Object.keys(normalized).length) return normalized;
  try { return object(JSON.parse(entry?.content || '{}')); } catch { return {}; }
}

function idsForResult(entry, result) {
  return [result?.toolCallId, result?.execution?.toolCallId, result?.callId, entry?.metadata?.callId, result?.activityId]
    .map(string).filter(Boolean).map(id => /^tool-\d+$/u.test(id) && entry?.metadata?.iteration != null ? `iteration-${entry.metadata.iteration}:${id}` : id);
}

function detailFor(tool, result) {
  // MCP output may contain arbitrary provider data. Only the diagnostic field
  // is designed to be a bounded, sanitized explanation.
  const detail = tool === 'mcp_call'
    ? result.diagnostic
    : tool === 'shell_exec'
      ? (result.error || result.stderr || result.summary || result.stdout)
      : (result.error || result.stderr || result.summary || result.message);
  return safeDetail(detail);
}

function summaryFor(record) {
  const tool = record.tool || 'Tool';
  const lead = record.status === 'failed' ? `${tool} failed` : record.status === 'completed' ? `${tool} completed` : record.status === 'pending' ? `${tool} pending` : `${tool} outcome unknown`;
  return `${lead}${record.detail ? `: ${record.detail}` : '.'}`;
}

/** Correlate canonical execution entries and optional trace toolActivity.
 * Strong call IDs are the only cross-record join. No ordering/time/name joins.
 */
export function correlateArchiveTools(executionEntries = [], trace = null, { terminal = false } = {}) {
  const records = [];
  const calls = [];
  const aliases = new Map();
  const traceItems = Array.isArray(trace?.toolActivity) ? trace.toolActivity : [];
  const entries = Array.isArray(executionEntries) ? executionEntries : [];
  const linkIds = (record, ids) => {
    record.ids = [...new Set([...record.ids, ...ids])];
    for (const id of ids) if (!aliases.has(id)) aliases.set(id, record);
  };

  for (const entry of entries) {
    if (entry?.type !== 'tool_call' || entry.metadata?.canonicalExecution !== true) continue;
    const metadata = object(entry.metadata);
    const list = Array.isArray(metadata.toolCalls) ? metadata.toolCalls : [];
    for (const call of list) {
      const ids = [string(call?.id)].filter(Boolean);
      const record = { source: 'session', status: 'pending', tool: string(call?.name) || string(call?.tool) || 'Tool', iteration: metadata.iteration ?? null, ids, detail: '', arguments: object(call?.arguments), ts: entry.ts || null };
      calls.push(record); records.push(record); linkIds(record, ids);
    }
  }

  for (const entry of entries) {
    if (entry?.type !== 'tool_result' || entry.metadata?.canonicalExecution !== true) continue;
    const result = archiveToolResultForEntry(entry);
    const ids = idsForResult(entry, result);
    const matches = [...new Set(ids.map(id => aliases.get(id)).filter(Boolean))];
    // A result with ambiguous aliases cannot safely settle any call.
    const record = matches.length === 1 ? matches[0] : null;
    const target = record || { source: 'session', status: 'unknown', tool: string(result.tool) || string(entry.metadata?.tool) || 'Tool', iteration: entry.metadata?.iteration ?? null, ids: [], detail: '' };
    if (!record) records.push(target);
    target.source = 'session';
    const { tool, command, cwd, exitCode, execution, provider, mcpToolName, filePath, target: resultTarget } = result;
    target.result = { tool, command, cwd, exitCode, execution, provider, mcpToolName, filePath, target: resultTarget };
    target.tool = string(result.tool) || string(entry.metadata?.tool) || target.tool;
    const explicitOk = entry.metadata?.ok ?? result.ok;
    target.status = explicitOk === true ? 'completed' : explicitOk === false ? 'failed' : 'unknown';
    target.detail = target.status === 'failed' ? detailFor(target.tool, result) : '';
    target.finishedAt = entry.ts || target.finishedAt || null;
    linkIds(target, ids);
  }

  if (terminal) for (const call of calls) if (call.status === 'pending') call.status = 'unknown';

  // Trace enriches an already-correlated session record by strong ID. It is
  // otherwise preserved as trace-only evidence and excluded from canonical counts.
  for (const item of traceItems) {
    const ids = [string(item?.id), string(item?.payload?.toolCallId)].filter(Boolean);
    const matches = [...new Set(ids.map(id => aliases.get(id)).filter(Boolean))];
    if (matches.length === 1 && matches[0].source === 'session') {
      const target = matches[0];
      target.payload = object(item.payload);
      target.traceStatus = string(item.status) || target.traceStatus || null;
      target.traceAt = item.finishedAt || item.startedAt || target.traceAt || null;
      continue;
    }
    const status = item?.status === 'failed' ? 'failed' : ['completed','succeeded','ok'].includes(item?.status) ? 'completed' : 'pending';
    const payload = object(item?.payload);
    records.push({ source: 'trace', status, tool: string(item?.tool) || string(payload.tool) || 'Tool', iteration: null, ids, payload, detail: status === 'failed' ? detailFor(string(item?.tool), object(item?.result || payload)) : '', ts: item?.finishedAt || item?.startedAt || null });
  }

  return records.map(({ ids, ...record }) => ({ ...record, ...(ids[0] ? { callId: ids[0] } : {}), aliases: ids, summary: summaryFor(record) }));
}

/** Count canonical session outcomes and separately expose trace-only evidence. */
export function archiveToolHistory(records = []) {
  const all = Array.isArray(records) ? records : [];
  const canonical = all.filter(record => record?.source !== 'trace');
  const count = status => canonical.filter(record => record.status === status).length;
  return {
    total: canonical.length,
    completed: count('completed'),
    failed: count('failed'),
    pending: count('pending'),
    unknown: count('unknown'),
    traceOnly: all.filter(record => record?.source === 'trace').length,
  };
}
