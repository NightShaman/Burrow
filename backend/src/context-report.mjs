import { redactValue } from './redaction.mjs';

// Presentation only: inspect the captured provider body, never resolve fresh
// profiles/mod records or reconstruct context from current application state.
const labels = {
  'agent-identity-provider': 'Identity',
  'stable-instructions-provider': 'Fixed guidance',
  'support-context-provider': 'Turn support',
  'current-task': 'Current message',
  'compaction-summary': 'Conversation summary',
  'raw-transcript-assistant': 'Assistant conversation',
  'prior-execution-continuity': 'Prior execution continuity',
  'stable-context': 'Identity and fixed guidance',
  'request-support': 'Turn support',
  'mod-shared-context-provider': 'Shared mod guidance',
  'mod-agent-context-provider': 'Mod context',
  'historical-user-turn': 'Conversation history',
  'current-message': 'Current message',
  'retained-conversation': 'Retained conversation',
};
const friendly = value => String(value || '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[-_]/g, ' ');
const recordLabel = name => friendly(String(name).replace(/\.(?:md|txt)$/i, '')).toLowerCase().replace(/(^|\s)\S/g, match => match.toUpperCase());
const inline = value => String(value ?? '').replace(/[\\`*_[\]<>|]/g, '\\$&').replace(/\r?\n/g, ' ');
const fence = (value, language = '') => {
  const text = String(value ?? '');
  const ticks = '`'.repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map(match => match[0].length + 1)));
  return `${ticks}${language}\n${text}\n${ticks}`;
};
const chars = value => (typeof value === 'string' ? value : JSON.stringify(value ?? '')).length;

// Captures are already redacted at the provider boundary. Reapply the existing
// field-aware policy without the old /token/ substring match (which destroyed
// max_output_tokens and tool schemas). No new context truncation in this view.
export function redactedContextBody(body) {
  return redactValue(body, { maxDepth: Infinity, maxItems: Infinity, maxKeys: Infinity });
}

function structured(value, depth = 0) {
  if (value === null) return 'Not set';
  if (typeof value === 'string') return value || '(empty text)';
  if (typeof value !== 'object') return String(value);
  if (!Object.keys(value).length) return Array.isArray(value) ? '(No entries)' : '(No fields)';
  if (depth > 10) return fence(JSON.stringify(value, null, 2), 'json');
  const indent = text => text.split('\n').map(line => `  ${line}`).join('\n');
  const field = (label, item) => {
    const text = structured(item, depth + 1);
    return item && typeof item === 'object'
      ? `- **${label}**\n${indent(text)}`
      : `- **${label}:** ${text.split('\n').join('\n  ')}`;
  };
  if (Array.isArray(value)) return value.map((entry, index) => field(`Entry ${index + 1}`, entry)).join('\n');
  return Object.entries(value).map(([key, item]) => field(inline(friendly(key)), item)).join('\n');
}

// Legacy captures have Path lines; new captures use clean headings and a
// record divider distinct from the prompt's section divider. Do not mistake
// headings or horizontal rules *inside* a Soul body for sibling records.
function capturedRecords(text) {
  const candidates = [...text.matchAll(/^## ([^\n]+)\n(?:Path: ([^\n]+)\n)?\n/gm)];
  const accepted = [];
  for (const match of candidates) {
    const before = text.slice(0, match.index);
    const sectionStart = [...before.matchAll(/^# (profile-files|mod-profile-files|mod-context|mod-shared-context)\n/gm)].at(-1);
    const section = sectionStart ? before.slice(sectionStart.index) : '';
    const legacy = Boolean(match[2]);
    const inRecordSection = /^# (?:profile-files|mod-profile-files|mod-context|mod-shared-context)\n/.test(section);
    if (!legacy && !inRecordSection) continue;
    if (!legacy && !(/(?:^|\n\n)----\n\n$/.test(before)
      || !/^## /m.test(section))) continue;
    accepted.push({ name: match[1], path: match[2], start: match.index, bodyStart: match.index + match[0].length });
  }
  return accepted.map((record, index) => {
    const next = accepted[index + 1]?.start ?? text.length;
    const sectionEnd = text.slice(record.bodyStart).search(/\n\n---\n\n# [a-z][a-z0-9-]*\n/);
    const end = sectionEnd < 0 ? next : Math.min(next, record.bodyStart + sectionEnd);
    const raw = text.slice(record.bodyStart, end);
    const content = raw.replace(/\n\n(?:----|---)\n\n$/, '').trim();
    return { ...record, content, end: record.bodyStart + raw.length };
  });
}

function readableText(text) {
  try { return structured(JSON.parse(text)); } catch { /* ordinary Markdown */ }
  const found = capturedRecords(text);
  // Convert only complete structured record bodies, never JSON-looking prose.
  for (const record of found.reverse()) {
    try {
      const parsed = structured(JSON.parse(record.content));
      const source = text.slice(record.bodyStart, record.end);
      text = text.slice(0, record.bodyStart) + source.replace(record.content, parsed) + text.slice(record.end);
    } catch { /* ordinary Markdown or capture with omission markers */ }
  }
  return text;
}

function readableContent(content) {
  if (typeof content === 'string') return readableText(content);
  if (!Array.isArray(content)) return content == null ? '' : structured(content);
  return content.map(part => {
    if (typeof part === 'string') return readableText(part);
    if (typeof part?.text === 'string') return readableText(part.text);
    if (part?.type === 'tool_result') return `**Tool result — ${inline(part.tool_use_id)}${part.is_error ? ' (error)' : ''}**\n\n${readableContent(part.content)}`;
    if (part?.type === 'tool_use') return `**Tool call — ${inline(part.name)} (${inline(part.id)})**\n\n${structured(part.input)}`;
    // Keep non-text attachment/signature data explicit, not a claim that the
    // bytes are readable prose. Its full captured form is in the raw disclosure.
    return `**${inline(part?.type || 'Non-text content')}**\n\n${structured(part)}`;
  }).join('\n\n');
}

function records(content) {
  const texts = typeof content === 'string' ? [content] : Array.isArray(content) ? content.map(part => typeof part === 'string' ? part : part?.text || '') : [];
  return texts.flatMap(text => capturedRecords(text).map(record => {
    let description;
    try {
      const value = JSON.parse(record.content);
      description = Array.isArray(value) ? `${value.length} entr${value.length === 1 ? 'y' : 'ies'}` : 'Structured record';
    } catch { description = /^[\[{]/.test(record.content) ? 'Structured record (capture may contain omission markers)' : 'Text record'; }
    return { name: recordLabel(record.name), chars: record.content.length, description };
  }));
}

export function contextReport({ request, agentRuntime, sessionId, status = {}, full = false }) {
  const body = redactedContextBody(request.body);
  const manifest = request.payload?.providerMessageManifest || [];
  const sourceMessages = Array.isArray(body.messages) ? body.messages : Array.isArray(body.input) ? body.input : Array.isArray(body.contents) ? body.contents : [];
  const entries = [];
  for (const key of ['system', 'instructions', 'systemInstruction']) {
    if (body[key] != null && body[key] !== '') entries.push({ message: { role: key === 'instructions' ? 'developer' : 'system', content: body[key]?.parts || body[key] }, source: `provider ${key}`, state: 'captured' });
  }
  if (typeof body.input === 'string') entries.push({ message: { role: 'user', content: body.input }, source: 'provider input', state: 'captured' });
  sourceMessages.forEach((message, index) => entries.push({ message, source: manifest[index]?.source || 'provider-visible', state: manifest[index]?.status || 'selected' }));
  const groups = new Map();
  for (const entry of entries) {
    const { message, source } = entry;
    entry.role = message.role || message.type || 'unknown';
    entry.content = message.type === 'function_call_output' ? message.output : message.content ?? message.parts;
    entry.chars = chars(entry.content) + (message.tool_calls ? chars(message.tool_calls) : 0) + (message.arguments ? chars(message.arguments) : 0);
    const group = groups.get(source) || { count: 0, chars: 0, records: [] };
    group.count++; group.chars += entry.chars; group.records.push(...records(entry.content)); groups.set(source, group);
  }
  const meter = status.context || {};
  const correlated = Boolean(meter.requestId && request.payload?.requestId === meter.requestId);
  const header = [
    `# Context${full ? ' — full' : ''}`,
    `**Agent:** ${inline(agentRuntime.agentId)} · **Model:** ${inline(body.model || meter.model || 'unknown')}`,
    correlated ? `**Usage:** ${meter.percent == null ? 'unknown' : `${meter.percent}%`} · **${meter.source === 'provider-input-tokens' ? 'Reported input tokens' : 'Estimated tokens'}:** ${meter.estimatedTokens ?? 'unknown'} / ${meter.capacityTokens ?? 'unknown'}` : '**Usage:** unavailable for this capture (no matching request meter).',
    '', '## What was included',
    ...[...groups].flatMap(([source, group]) => [
      `- **${inline(labels[source] || friendly(source))}** — ${group.count} message${group.count === 1 ? '' : 's'}, ${group.chars.toLocaleString('en-US')} chars`,
      ...group.records.map(record => `  - **${inline(record.name)}** — ${record.chars.toLocaleString('en-US')} chars · ${inline(record.description)}`),
    ]),
    ...(entries.length ? [] : ['No context messages were found in the captured body. Inspect the raw request for this provider format.']),
    ...(!full ? ['', 'Use `/context full` to inspect each captured message.'] : []),
  ].join('\n\n');
  const details = [
    `**Session:** ${inline(sessionId)} · **Captured request:** ${inline(request.payload?.requestId || 'ID unavailable')} · **Sent:** ${inline(request.ts || 'time unavailable')}`,
    `**Run:** ${inline(request.runId)} · **API:** ${inline(request.payload?.api || 'unknown')}`,
    `**Compaction:** ${status.compaction?.active ? 'active' : 'idle'} · **Provider messages:** ${sourceMessages.length}${entries.length !== sourceMessages.length ? `, plus ${entries.length - sourceMessages.length} top-level context field(s)` : ''}`,
    'This is the last captured provider request, not a live preview of the next turn. Both context views use this capture. Content reflects capture-time redaction and any pre-existing omission markers.',
    ...(body.previous_response_id ? ['**Provider-held history:** this request references an earlier response. That remote history is not contained in this capture.'] : []),
    ...(body.conversation ? ['**Provider conversation:** additional server-held history may not be contained in this capture.'] : []),
  ].join('\n\n');
  const blocks = [{ title: '', markdown: header }, { title: 'Capture details', markdown: details, collapsed: true }];
  if (full) {
    entries.forEach((entry, index) => {
      const { message, role, source, state, content } = entry;
      const toolCalls = (message.tool_calls || []).map(call => {
        let argumentsValue = call.function?.arguments;
        try { argumentsValue = JSON.parse(argumentsValue); } catch { /* not JSON */ }
        return `**Tool call — ${inline(call.function?.name || call.name || 'unknown')} (${inline(call.id)})**\n\n${structured(argumentsValue)}`;
      });
      if (message.type === 'function_call') {
        let args = message.arguments;
        try { args = JSON.parse(args); } catch { /* not JSON */ }
        toolCalls.push(`**Tool call — ${inline(message.name)} (${inline(message.call_id)})**\n\n${structured(args)}`);
      }
      const markdown = [
        `**Source:** ${inline(source)} · **Selection:** ${inline(state)} · **Size:** ${entry.chars.toLocaleString('en-US')} chars`,
        ...(message.tool_call_id || message.type === 'function_call_output' ? [`**Tool call ID:** ${inline(message.tool_call_id || message.call_id)}`] : []),
        readableContent(content), ...toolCalls,
        ...(!content && !toolCalls.length ? [structured(message)] : []),
      ].filter(Boolean).join('\n\n');
      blocks.push({ title: `${index + 1}. ${role} — ${labels[source] || friendly(source)}`, markdown, collapsed: true });
    });
    const options = Object.fromEntries(Object.entries(body).filter(([key]) => !['messages', 'input', 'contents', 'system', 'instructions', 'systemInstruction'].includes(key)));
    blocks.push({ title: 'Technical details — tool schemas and provider options', markdown: 'Provider options affect behavior; tool definitions are separate from conversation messages. This is the captured, redacted representation.\n\n' + fence(JSON.stringify(options, null, 2), 'json'), collapsed: true });
    blocks.push({ title: 'Raw provider request (redacted)', markdown: 'Explicit debug view of this same capture. Use Copy code to export it. Capture-time redaction/omission markers are preserved; this is not an unredacted wire-body export.\n\n' + fence(JSON.stringify(body, null, 2), 'json'), collapsed: true });
  }
  const report = { version: 1, blocks };
  // Plain clients get the full readable message contents, not the raw dump.
  // Structured clients start with the compact inventory and closed disclosures.
  const text = blocks.filter(block => full ? !['Technical details — tool schemas and provider options', 'Raw provider request (redacted)'].includes(block.title) : !block.collapsed).map(block => `${block.title ? `## ${block.title}\n\n` : ''}${block.markdown}`).join('\n\n');
  return { report, text };
}
