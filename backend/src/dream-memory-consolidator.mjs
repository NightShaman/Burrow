function text(value) { return String(value ?? '').trim(); }
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
      const expires = item.expiresAt ? ` Expires: ${item.expiresAt.slice(0, 10)}.` : '';
      lines.push(`- ${kindLabel(item.kind)}: ${text(item.title)} — ${text(item.content)}${expires}`);
    }
  }
  lines.push('', `Updated: ${generatedAt}`);
  return `${lines.join('\n')}\n`;
}

/** Async PG path. Stores are mandatory so this path can never silently touch SQLite. */
export async function consolidateDreamMemoryAsync({ agentId, workingMemoryStore, profileStore, generatedAt = new Date().toISOString(), items = null } = {}) {
  const id = text(agentId); if (!id) throw new Error('dream_memory_agent_required');
  if (!workingMemoryStore || !profileStore) throw new Error('dream_memory_stores_required');
  if (!Array.isArray(items)) throw new Error('dream_memory_synthesized_items_required');
  await profileStore.ensure(id);
  const synthesizedItems = items.filter((item) => item?.kind !== 'session-window' && !String(item?.id || '').startsWith('session-window-'));
  const markdown = renderDreamMemoryDocument(synthesizedItems, { generatedAt });
  const document = await profileStore.replaceDreamMemory(id, markdown);
  return { ok: true, agentId: id, itemCount: synthesizedItems.length, document, markdown };
}
