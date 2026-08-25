import { createModelAdapter } from './model-adapter.mjs';
import { normalizeProviderMessages } from './provider-messages.mjs';

const text = (value) => String(value ?? '').trim();
const bounded = (value, limit) => { const source = text(value); return source.length <= limit ? source : `${source.slice(0, limit).trim()}…`; };

export function archiveSummaryPrompt({ title, turns = [] } = {}) {
  const transcript = (turns || []).filter((turn) => ['user', 'assistant', 'agent'].includes(turn?.role) && text(turn.content))
    .map((turn) => `${turn.role}: ${bounded(turn.content, 1400)}`).join('\n\n');
  return [
    'Write a factual human-facing archive summary in one or two sentences. Do not address the user, invent outcomes, mention this instruction, or use markdown.',
    `Conversation title: ${bounded(title, 160)}`,
    `Transcript:\n${bounded(transcript, 12000)}`,
  ].join('\n\n');
}

export function parseArchiveSummary(value = '') {
  const summary = bounded(value.replace(/\s+/g, ' '), 700);
  return summary || null;
}

export async function generateArchiveSummary({ modelConfig, title, turns, traceLogger } = {}) {
  if (!modelConfig?.model || !Array.isArray(turns) || !turns.length) return null;
  try {
    const adapter = createModelAdapter({ config: { ...modelConfig, temperature: 0, reasoningEffort: 'off' } });
    const result = await adapter.complete({ messages: normalizeProviderMessages([{ role: 'user', content: archiveSummaryPrompt({ title, turns }), metadata: { providerMessageSource: 'archive-summary' } }]), traceLogger });
    return parseArchiveSummary(result?.choice?.text || '');
  } catch { return null; }
}
