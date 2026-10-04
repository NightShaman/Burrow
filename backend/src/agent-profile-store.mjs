
export const AGENT_PROFILE_KINDS = Object.freeze(['SOUL', 'RULES', 'ORIENTATION', 'PREFERENCES', 'TOOLS', 'DREAM_MEMORY']);
const PROFILE_KIND_NAMES = Object.freeze({ DREAMMEMORY: 'DREAM_MEMORY', PREFERENCESMD: 'PREFERENCES' });
const MAX_DOCUMENT_CHARS = 48_000;
const text = (value) => String(value ?? '').trim();
const now = () => new Date().toISOString();

function agentId(value) {
  const result = text(value);
  if (!/^[A-Za-z0-9._-]{1,96}$/.test(result)) throw new Error('agent_id_invalid');
  return result;
}

function kind(value) {
  const result = PROFILE_KIND_NAMES[text(value).toUpperCase()] || text(value).toUpperCase();
  if (!AGENT_PROFILE_KINDS.includes(result)) throw new Error('agent_profile_kind_invalid');
  return result;
}

function markdown(value) {
  if (typeof value !== 'string') throw new Error('agent_profile_markdown_required');
  if (value.length > MAX_DOCUMENT_CHARS) throw new Error('agent_profile_markdown_too_large');
  return value;
}

function document(row) {
  return row && {
    kind: row.kind,
    markdown: row.markdown,
    format: 'markdown',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// Compatibility export only; persistence requires the PostgreSQL store.
export class AgentProfileStore {
  constructor() { throw new Error('postgres_required'); }
}

export function profileFilesFromDocuments(documents = [], { agentId: owningAgentId = null } = {}) {
  const byKind = new Map((Array.isArray(documents) ? documents : []).map((item) => [item.kind, item]));
  const files = AGENT_PROFILE_KINDS.map((documentKind) => byKind.get(documentKind)).filter(Boolean).map((item) => {
    const displayName = item.kind === 'DREAM_MEMORY' ? 'DreamMemory' : item.kind === 'PREFERENCES' ? 'PREFERENCES' : item.kind;
    return { id: displayName.toLowerCase(), name: `${displayName}.md`, path: `postgres:agent_profile_documents/${owningAgentId || 'agent'}/${item.kind}`, content: item.markdown, chars: item.markdown.length };
  });
  return { profileDir: 'postgres:agent_profile_documents', files, chars: files.reduce((total, file) => total + file.chars, 0) };
}

export { agentId, kind, markdown };
export const __agentProfileStore = Object.freeze({ MAX_DOCUMENT_CHARS, agentId, kind, markdown });
