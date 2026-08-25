import { AgentProfileStore } from './agent-profile-store.mjs';
import { WorkingMemoryStore } from './working-memory-store.mjs';

const DEFAULT_LIMIT = 12;

function text(value) { return String(value ?? '').trim(); }
function clamp(value, limit) { const source = text(value).replace(/\s+/g, ' '); return source.length <= limit ? source : `${source.slice(0, limit).trim()}…`; }
function kindLabel(value) { return text(value).toUpperCase() || 'NOTE'; }

export function renderDreamMemoryDocument(items = [], { generatedAt = new Date().toISOString() } = {}) {
  const lines = [
    '# DreamMemory',
    '',
    'Semi-durable local continuity distilled from recent work.',
    'Human-editable. Not authoritative. Verify mutable facts before acting.',
    '',
    'DreamMemory carries forward useful local continuity without declaring it durable truth.',
  ];
  const normalized = (Array.isArray(items) ? items : []).filter((item) => item?.title && item?.content);
  if (!normalized.length) {
    lines.push('', '- No current dream-promoted continuity.');
  } else {
    lines.push('');
    for (const item of normalized) {
      const refs = Array.isArray(item.sourceRefs) && item.sourceRefs.length ? ` Sources: ${item.sourceRefs.slice(0, 4).join(', ')}.` : '';
      const expires = item.expiresAt ? ` Expires: ${item.expiresAt.slice(0, 10)}.` : '';
      lines.push(`- ${kindLabel(item.kind)}: ${clamp(item.title, 180)} — ${clamp(item.content, 700)}${refs}${expires}`);
    }
  }
  lines.push('', `Updated: ${generatedAt}`);
  return `${lines.join('\n')}\n`;
}

export function consolidateDreamMemory({ agentId, databasePath = null, limit = DEFAULT_LIMIT, generatedAt = new Date().toISOString(), items = null } = {}) {
  const id = text(agentId);
  if (!id) throw new Error('dream_memory_agent_required');
  const memoryStore = new WorkingMemoryStore({ databasePath });
  const profileStore = new AgentProfileStore({ databasePath });
  try {
    profileStore.ensure(id);
    const candidateItems = Array.isArray(items)
      ? items
      : memoryStore.list({ agentId: id, includeInactive: false, limit: Math.max(1, Math.min(100, Number(limit) || DEFAULT_LIMIT)) })
        .filter((item) => item.id.startsWith('dream-'));
    // Session-window blobs are raw continuity residue, not DreamMemory candidates.
    // Reject them defensively even if a caller bypasses the Dream cycle selection gate.
    const boundedItems = candidateItems
      .filter((item) => item?.kind !== 'session-window' && !String(item?.id || '').startsWith('session-window-'))
      .slice(0, Math.max(1, Math.min(50, Number(limit) || DEFAULT_LIMIT)));
    const markdown = renderDreamMemoryDocument(boundedItems, { generatedAt });
    const document = profileStore.replaceDreamMemory(id, markdown);
    return { ok: true, agentId: id, itemCount: boundedItems.length, document, markdown };
  } finally {
    memoryStore.close();
    profileStore.close();
  }
}
