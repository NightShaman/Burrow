// Live mod-agent provider publication is independent of tool catalogs and MCP.
// Only Core publishes an activated host, keyed by its trusted installed identity.
const providers = new Map();

function unavailable() {
  return Object.assign(new Error('mod_agent_unavailable'), { code: 'mod_agent_unavailable' });
}
export function publishModAgentProvider(mod) {
  if (mod?.status !== 'loaded' || !mod.host?.isAvailable?.()) throw unavailable();
  // Publishing a replacement without a provider must revoke the previous one.
  if (mod.agentContextSupported === true) providers.set(mod.id, mod);
  else providers.delete(mod.id);
}
export function revokeModAgentProvider(ownerModId) { providers.delete(ownerModId); }
export function unpublishModAgentProvider(mod) {
  if (providers.get(mod?.id) === mod) providers.delete(mod.id);
}
export function activeModAgentProvider(agent) {
  const mod = providers.get(agent?.modAgent?.ownerModId);
  return mod?.status === 'loaded' && mod.agentContextSupported === true && mod.host?.isAvailable?.() ? mod : null;
}
export function assertModAgentAvailable(agent) {
  if (!agent?.modAgent) return;
  if (!activeModAgentProvider(agent)) throw unavailable();
}

// A provider supplies only text records, never authority, tools, or a foreign
// agent identity. Reject excess data or malformed output; never silently trim.
function validateRecords(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['profileFiles', 'context'].includes(key)) || !Array.isArray(value.profileFiles) || !Array.isArray(value.context)) throw unavailable();
  let size = 0;
  const records = (entries) => {
    if (entries.length > 64) throw unavailable();
    const names = new Set();
    return entries.map(entry => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry) || Object.keys(entry).some(key => !['name','content'].includes(key)) || typeof entry.name !== 'string' || !entry.name.trim() || entry.name === '.' || entry.name === '..' || entry.name.length > 128 || /[\x00-\x1f\x7f/\\]/.test(entry.name) || typeof entry.content !== 'string' || names.has(entry.name)) throw unavailable();
      names.add(entry.name);
      size += Buffer.byteLength(entry.name) + Buffer.byteLength(entry.content);
      if (size > 1_000_000) throw unavailable();
      return { name: entry.name, content: entry.content };
    });
  };
  return { profileFiles: records(value.profileFiles), context: records(value.context) };
}
export async function resolveModAgentContext(agentRuntime, { sessionId, signal } = {}) {
  const agent = agentRuntime?.agent;
  if (!agent?.modAgent || !agent.id || agentRuntime.agentId !== agent.id || typeof sessionId !== 'string' || !sessionId || sessionId.length > 128) throw unavailable();
  const mod = activeModAgentProvider(agent);
  if (!mod) throw unavailable();
  try {
    const result = await mod.host.invoke('agent-context', { agentId: agent.id, sessionId }, { abortSignal: signal });
    // A replaced, disabled or crashed host must not complete a dependent turn.
    if (activeModAgentProvider(agent) !== mod || signal?.aborted) throw unavailable();
    return validateRecords(result);
  } catch { throw unavailable(); }
}

// Native bridge is intentionally small and does not require an MCP connection or
// catalog grant. The caller identity is taken only from the execution context.
export function modAgentToolSchemas(agentRuntime) {
  const mod = activeModAgentProvider(agentRuntime?.agent);
  if (!mod || agentRuntime?.agentId !== agentRuntime?.agent?.id) throw unavailable();
  if (!mod.tools?.length) return [];
  return [{ type: 'function', function: {
    name: 'mod_agent_tool', description: 'Call a tool provided by the mod that owns this agent.',
    parameters: { type: 'object', additionalProperties: false, required: ['name', 'arguments'], properties: {
      name: { type: 'string', enum: mod.tools.map(tool => tool.name) }, arguments: { type: 'object' },
    }, oneOf: mod.tools.map(tool => ({ properties: { name: { const: tool.name, description: tool.description }, arguments: tool.inputSchema } })) },
  } }];
}
export async function executeModAgentTool(action, executionContext) {
  const agent = executionContext?.agentRuntime?.agent;
  const mod = activeModAgentProvider(agent);
  if (!mod || executionContext?.agentId !== agent?.id) throw unavailable();
  const name = action?.name ?? action?.modToolName;
  const args = action?.arguments ?? action?.modToolArguments;
  if (typeof name !== 'string' || !mod.tools?.some(tool => tool.name === name) || !args || typeof args !== 'object' || Array.isArray(args)) throw new Error('mod_agent_tool_invalid');
  const output = await mod.host.invokeTool(name, args, {
    agentId: agent.id, sessionId: executionContext.sessionId || 'default',
    conversationId: executionContext.conversationId || null, runId: executionContext.parentRunId || null,
  }, { abortSignal: executionContext.abortSignal });
  if (activeModAgentProvider(agent) !== mod || executionContext.abortSignal?.aborted) throw unavailable();
  return output;
}
