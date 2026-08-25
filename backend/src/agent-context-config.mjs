const ID = /^[a-zA-Z0-9._-]{1,96}$/;

function text(value, maxChars) {
  const normalized = String(value ?? '').trim();
  if (normalized.length > maxChars) throw new Error('agent_context_text_too_large');
  return normalized || null;
}

function ids(value, field) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(`${field}_invalid`);
  const normalized = [...new Set(value.map((item) => String(item ?? '').trim()).filter(Boolean))];
  if (normalized.some((item) => !ID.test(item))) throw new Error(`${field}_invalid`);
  return normalized;
}

function positiveInteger(value, field, { min, max } = {}) {
  if (value === undefined || value === null || value === '') return undefined;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw new Error(`${field}_invalid`);
  return number;
}

function uiTarget(value) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('agent_context_ui_target_invalid');
  const url = text(value.url, 2_000);
  const label = value.label === undefined ? null : text(value.label, 240);
  if (!url) throw new Error('agent_context_ui_target_url_invalid');
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error();
  } catch { throw new Error('agent_context_ui_target_url_invalid'); }
  return { url, ...(label ? { label } : {}) };
}

/**
 * Structured, portable boot-context record. It is configuration only: no
 * permissions, filesystem boundaries, or executable tool definitions belong
 * here. Markdown profile files remain supported import/export material while
 * this record becomes the selected agent's canonical configuration surface.
 */
export function normalizeAgentContextConfig(input = {}, { partial = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('agent_context_config_invalid');

  const personality = input.personality === undefined ? undefined : text(input.personality, 24_000);
  const operatorPreferences = input.operatorPreferences === undefined ? undefined : text(input.operatorPreferences, 24_000);
  const goblinOrientation = input.goblinOrientation === undefined ? undefined : text(input.goblinOrientation, 24_000);
  const toolIds = ids(input.toolIds, 'agent_context_tool_ids');
  const skillIds = ids(input.skillIds, 'agent_context_skill_ids');
  const target = uiTarget(input.uiTarget);

  const result = {
    version: 1,
    ...(personality !== undefined ? { personality } : {}),
    ...(operatorPreferences !== undefined ? { operatorPreferences } : {}),
    ...(goblinOrientation !== undefined ? { goblinOrientation } : {}),
    ...(toolIds !== undefined ? { toolIds } : {}),
    ...(skillIds !== undefined ? { skillIds } : {}),
    ...(target !== undefined ? { uiTarget: target } : {}),
  };
  if (!partial && !Object.keys(result).some((key) => key !== 'version')) return { version: 1 };
  return result;
}

export function mergeAgentContextConfig(current = {}, patch = {}) {
  const base = normalizeAgentContextConfig(current);
  const update = normalizeAgentContextConfig(patch, { partial: true });
  return normalizeAgentContextConfig({
    ...base,
    ...update,
  });
}

export function exportAgentContextConfig(agent = {}) {
  return {
    schema: 'burrow.agent-context/v1',
    agent: {
      id: String(agent.id || ''),
      name: String(agent.name || ''),
      availableCapabilities: Array.isArray(agent.availableCapabilities) ? agent.availableCapabilities : [],
    },
    context: normalizeAgentContextConfig(agent.contextConfig || {}),
  };
}

export function importAgentContextConfig(record = {}) {
  if (!record || record.schema !== 'burrow.agent-context/v1' || !record.agent?.id) throw new Error('agent_context_import_invalid');
  return {
    agent: {
      id: String(record.agent.id),
      name: String(record.agent.name || '').trim(),
      availableCapabilities: Array.isArray(record.agent.availableCapabilities) ? record.agent.availableCapabilities : undefined,
    },
    contextConfig: normalizeAgentContextConfig(record.context || {}),
  };
}
