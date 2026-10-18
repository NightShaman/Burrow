import { SUPPORTED_SYSTEM_MOD_CAPABILITIES } from './mod-runtime.mjs';

// Core-only authority. Never pass this object's mutator to a mod host.
export const POSTGRES_MOD_AUTHORITY_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS core_mod_authority (
  mod_id VARCHAR(128) PRIMARY KEY,
  grants JSONB NOT NULL DEFAULT '[]',
  admin_agent_ids JSONB NOT NULL DEFAULT '[]',
  diagnostic_agent_ids JSONB NOT NULL DEFAULT '[]',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS core_mod_denials (
  id BIGSERIAL PRIMARY KEY, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  owner_mod_id VARCHAR(128) NOT NULL, agent_id VARCHAR(256),
  capability VARCHAR(80) NOT NULL
);
`;
const invalid = () => Object.assign(new Error('mod_authority_input_invalid'), { statusCode: 400 });
export function createModAuthority({ repositoryFactory }) {
  async function db(fn) { const repository = await repositoryFactory(); try { return await fn(repository); } finally { await repository.close(); } }
  const ready = db(repository => repository.ensureAuthoritySchema());
  void ready.catch(() => {});
  async function read(id) {
    await ready;
    const row = await db(repository => repository.readModAuthority(id));
    return { grants: row?.grants || [], adminAgentIds: row?.admin_agent_ids || [], diagnosticAgentIds: row?.diagnostic_agent_ids || [] };
  }
  async function allowed(id, capability, agentId = null) {
    const value = await read(id);
    return capability === 'diagnostics-global' ? value.diagnosticAgentIds.includes(agentId)
      : value.grants.includes(capability) && (agentId === null || value.adminAgentIds.includes(agentId));
  }
  async function assertAllowed(id, capability, agentId = null) {
    if (await allowed(id, capability, agentId)) return;
    await deny(id, capability, agentId);
    throw Object.assign(new Error('mod_authority_forbidden'), { statusCode: 403 });
  }
  async function deny(id, capability, agentId = null) {
    await ready;
    await db(repository => repository.recordModDenial(id, capability, agentId));
  }
  async function replace(id, value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['grants','adminAgentIds','diagnosticAgentIds'].includes(key))) throw invalid();
    for (const key of ['grants','adminAgentIds','diagnosticAgentIds']) {
      const list = value[key];
      if (!Array.isArray(list) || list.length > 256 || new Set(list).size !== list.length || list.some(item => typeof item !== 'string' || !item || item.length > 128 || Buffer.byteLength(item, 'utf8') > 256 || /[\x00-\x1f\x7f]/.test(item))) throw invalid();
    }
    if (value.grants.some(item => !SUPPORTED_SYSTEM_MOD_CAPABILITIES.includes(item))) throw invalid();
    await ready;
    await db(repository => repository.replaceModAuthority(id, value));
    return read(id);
  }
  return Object.freeze({ ready, read, allowed, assertAllowed, deny, replace });
}

// Mounted before mod-owned routes and protected independently of authMode=none.
export function createModAuthorityRoute({ authority, getMods, readJsonBody, sendJson }) {
  return async ({ req, res, url }) => {
    const match = /^\/api\/operator\/mods\/([a-z0-9]+(?:-[a-z0-9]+)*)\/access$/.exec(url.pathname);
    if (!match) return false;
    if (!req.burrowVerifiedAuth?.authenticated || req.burrowApiToken) { sendJson(res, 403, { ok: false, error: 'operator_authentication_required' }); return true; }
    const mod = getMods().find(mod => mod.id === match[1]);
    if (!mod) { sendJson(res, 404, { ok: false, error: 'mod_not_found' }); return true; }
    if (!['GET','PUT'].includes(req.method)) { sendJson(res, 405, { ok: false, error: 'method_not_allowed' }); return true; }
    const declaredCapabilities = mod.systemCapabilities || [];
    let access;
    if (req.method === 'PUT') {
      const replacement = await readJsonBody(req);
      if (Array.isArray(replacement?.grants) && replacement.grants.some(capability => !declaredCapabilities.includes(capability))) throw invalid();
      access = await authority.replace(mod.id, replacement);
    } else access = await authority.read(mod.id);
    sendJson(res, 200, { ok: true, modId: mod.id, declaredCapabilities, ...access, restartRequired: req.method === 'PUT' });
    return true;
  };
}
