import { useUnsavedChanges, useUnsavedNavigation } from '../../app/UnsavedChanges';
import { createPortal } from 'react-dom';
import { useEffect, useRef, useState } from 'react';
import { api } from '../../app/api';
import { SettingSection } from './SettingsPrimitives';

type McpGrant = { connectionId: string; toolName: string; enabled: boolean };

const isMcpGrant = (value: unknown): value is McpGrant => {
  if (!value || typeof value !== 'object') return false;
  const grant = value as Partial<McpGrant>;
  return typeof grant.connectionId === 'string' && grant.connectionId.length > 0
    && typeof grant.toolName === 'string' && grant.toolName.length > 0 && typeof grant.enabled === 'boolean';
};
const grantKey = (grant: McpGrant) => `${grant.connectionId}:${grant.toolName}`;
const grantSignature = (grants: McpGrant[]) => JSON.stringify(grants.map(({ connectionId, toolName, enabled }) => JSON.stringify([connectionId, toolName, enabled])).sort());
const validateAcknowledgement = (value: unknown, agentId: string, expected: McpGrant[]) => {
  const response = value as { ok?: unknown; agentId?: unknown; tools?: unknown } | null;
  if (!response || response.ok !== true || response.agentId !== agentId || !Array.isArray(response.tools)
    || !response.tools.every(isMcpGrant) || grantSignature(response.tools) !== grantSignature(expected)) {
    throw new Error('Invalid MCP tool save acknowledgement. Retry the change.');
  }
};

type McpTool = { name: string; description?: string | null; inputSchema?: Record<string, unknown>; availability?: 'grant-required' | 'mod-authorized' | string };
type McpConnection = { id: string; name: string; transport: 'http' | 'stdio' | 'mod'; baseUrl: string | null; command: string | null; args: string[]; enabled: boolean; apiKeyConfigured: boolean; tools: McpTool[] };

export const isModAuthorizedTool = (connection: Pick<McpConnection, 'transport'>, tool: Pick<McpTool, 'availability'>) => connection.transport === 'mod' && tool.availability === 'mod-authorized';
export const grantableTools = (connection: McpConnection) => connection.tools.filter(tool => !isModAuthorizedTool(connection, tool));

export function AgentMcpTools({ agentId, overflowTarget }: { agentId: string; overflowTarget?: HTMLElement | null }) {
  const resourceId = agentId.includes('::') ? agentId.slice(agentId.indexOf('::') + 2) : agentId;
  const request = <T,>(path: string, init?: RequestInit) => api<T>(path, init);
  const navigate = useUnsavedNavigation();
  const [baseline, setBaseline] = useState<string[]>([]);
  const [connections, setConnections] = useState<McpConnection[]>([]);
  const [selectedConnectionId, setSelectedConnectionId] = useState('');
  const [enabled, setEnabled] = useState<Set<string>>(new Set());
  const [preservedGrants, setPreservedGrants] = useState<McpGrant[]>([]);
  const [state, setState] = useState<'loading' | 'idle' | 'saving' | 'error'>('loading');
  const [retry, setRetry] = useState(0);
  const [error, setError] = useState('');
  const [failedGrants, setFailedGrants] = useState<Record<string, boolean>>({});
  const requestVersion = useRef(0);
  const accepted = useRef<Set<string>>(new Set());
  const failed = useRef<Record<string, boolean>>({});
  const saving = useRef(false);
  useEffect(() => {
    const version = ++requestVersion.current;
    const controller = new AbortController();
    saving.current = false; accepted.current = new Set(); failed.current = {};
    setState('loading'); setError(''); setConnections([]); setEnabled(new Set()); setBaseline([]); setPreservedGrants([]); setFailedGrants({}); setSelectedConnectionId('');
    Promise.all([
      request<{ connections: McpConnection[] }>('/api/settings/mcp-connections', { signal: controller.signal }),
      request<{ tools: McpGrant[] }>(`/api/agents/${encodeURIComponent(resourceId)}/mcp-tools`, { signal: controller.signal }),
    ]).then(([catalog, grants]) => {
      if (controller.signal.aborted || requestVersion.current !== version) return;
      const nextConnections = catalog.connections ?? [];
      setConnections(nextConnections);
      setSelectedConnectionId(current => nextConnections.some(connection => connection.id === current) ? current : (nextConnections[0]?.id ?? ''));
      if (!Array.isArray(grants.tools) || !grants.tools.every(isMcpGrant)) throw new Error('Invalid MCP tool grants response.');
      const editableKeys = new Set(nextConnections.flatMap(connection => grantableTools(connection).map(tool => `${connection.id}:${tool.name}`)));
      // PUT replaces every grant, including tools absent from discovery and historical mod grants.
      // Keep their original enabled values rather than reconstructing them from the visible catalog.
      setPreservedGrants(grants.tools.filter(tool => !editableKeys.has(grantKey(tool))).map(({ connectionId, toolName, enabled }) => ({ connectionId, toolName, enabled })));
      const loaded = grants.tools.filter(tool => tool.enabled && editableKeys.has(grantKey(tool))).map(grantKey).sort();
      accepted.current = new Set(loaded);
      setEnabled(new Set(loaded)); setBaseline(loaded);
      setState('idle');
    }).catch(cause => {
      if (controller.signal.aborted || requestVersion.current !== version) return;
      setError(cause instanceof Error ? `Could not load MCP tools: ${cause.message}` : 'Could not load MCP tools.');
      setState('error');
    });
    return () => controller.abort();
  }, [agentId, retry]);
  const updateFailed = (next: Record<string, boolean>) => {
    failed.current = next;
    setFailedGrants(next);
  };
  const grantRows = (selection: Set<string>) => [
    ...preservedGrants,
    ...connections.flatMap(connection => grantableTools(connection)
      .filter(tool => selection.has(`${connection.id}:${tool.name}`))
      .map(tool => ({ connectionId: connection.id, toolName: tool.name, enabled: true }))),
  ];
  const saveChanges = async (changes: Record<string, boolean>) => {
    if (state !== 'idle' || saving.current) return false;
    const effectiveChanges = Object.fromEntries(Object.entries(changes).filter(([key, value]) => accepted.current.has(key) !== value));
    if (Object.keys(effectiveChanges).length === 0) {
      const nextFailed = { ...failed.current };
      Object.keys(changes).forEach(key => delete nextFailed[key]);
      updateFailed(nextFailed);
      setBaseline([...accepted.current].sort());
      if (Object.keys(nextFailed).length === 0) setError('');
      return true;
    }
    const version = requestVersion.current;
    const nextAccepted = new Set(accepted.current);
    Object.entries(effectiveChanges).forEach(([key, value]) => value ? nextAccepted.add(key) : nextAccepted.delete(key));
    saving.current = true;
    setState('saving'); setError('');
    try {
      const tools = grantRows(nextAccepted);
      const response = await request<unknown>(`/api/agents/${encodeURIComponent(resourceId)}/mcp-tools`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tools }) });
      if (requestVersion.current !== version) return false;
      validateAcknowledgement(response, resourceId, tools);
      accepted.current = nextAccepted;
      setBaseline([...nextAccepted].sort());
      const nextFailed = { ...failed.current };
      Object.keys(changes).forEach(key => delete nextFailed[key]);
      updateFailed(nextFailed);
      if (Object.keys(nextFailed).length > 0) setError('Could not save some MCP tool changes. Retry them before leaving settings.');
      return true;
    } catch (cause) {
      if (requestVersion.current === version) {
        updateFailed({ ...failed.current, ...effectiveChanges });
        setError(cause instanceof Error ? `Could not save MCP tools: ${cause.message}` : 'Could not save MCP tools.');
      }
      return false;
    } finally {
      if (requestVersion.current === version) { saving.current = false; setState('idle'); }
    }
  };
  const toggleConnection = (connection: McpConnection) => {
    const keys = grantableTools(connection).map(tool => `${connection.id}:${tool.name}`);
    const selectAll = !keys.every(key => enabled.has(key));
    const changes = Object.fromEntries(keys.map(key => [key, selectAll]));
    setEnabled(current => {
      const next = new Set(current);
      keys.forEach(key => selectAll ? next.add(key) : next.delete(key));
      return next;
    });
    void saveChanges(changes);
  };
  const toggleTool = (connection: McpConnection, tool: McpTool) => {
    if (isModAuthorizedTool(connection, tool)) return;
    const key = `${connection.id}:${tool.name}`;
    const nextEnabled = !enabled.has(key);
    setEnabled(current => {
      const next = new Set(current);
      nextEnabled ? next.add(key) : next.delete(key);
      return next;
    });
    void saveChanges({ [key]: nextEnabled });
  };
  const save = async () => {
    const keys = new Set([...accepted.current, ...enabled]);
    return saveChanges(Object.fromEntries([...keys].map(key => [key, enabled.has(key)])));
  };
  const retryFailed = () => void saveChanges({ ...failed.current });
  useUnsavedChanges({ dirty: state !== 'loading' && state !== 'error' && JSON.stringify([...enabled].sort()) !== JSON.stringify(baseline), busy: state === 'saving', resumeAfterAutosave: true, save, discard: () => { setEnabled(new Set(baseline)); updateFailed({}); setError(''); } });
  const grantableConnections = connections.filter(connection => grantableTools(connection).length > 0);
  const selectedConnection = grantableConnections.find(connection => connection.id === selectedConnectionId) ?? grantableConnections[0];
  const toolOptions = (connection: McpConnection) => {
    const tools = grantableTools(connection);
    const selectedCount = tools.filter(tool => enabled.has(`${connection.id}:${tool.name}`)).length;
    const allSelected = tools.length > 0 && selectedCount === tools.length;
    const managedCount = connection.tools.length - tools.length;
    if (!tools.length && managedCount) return <p className="settings-description">All {managedCount} {managedCount === 1 ? 'tool is' : 'tools are'} authorized directly by the mod; no agent grants are needed.</p>;
    return tools.length ? <div className="mcp-tool-options"><label className="mcp-tool-select-all"><input type="checkbox" disabled={state !== 'idle'} checked={allSelected} onChange={() => toggleConnection(connection)} /><span><b>{allSelected ? 'Clear all' : 'Select all'}</b><small>{tools.length} grantable {tools.length === 1 ? 'tool' : 'tools'}</small></span></label>{tools.map(tool => { const key = `${connection.id}:${tool.name}`; return <label key={key}><input type="checkbox" disabled={state !== 'idle'} checked={enabled.has(key)} onChange={() => toggleTool(connection, tool)} /><span><b>{tool.name}</b>{tool.description && <small>{tool.description}</small>}</span></label>; })}{managedCount > 0 && <p className="settings-description">{managedCount} mod-authorized {managedCount === 1 ? 'tool is' : 'tools are'} omitted from agent grants.</p>}</div> : <small>No tools discovered yet.</small>;
  };

  if (overflowTarget) {
    const serverList = <SettingSection title="Connected tool servers">{state === 'error' && <button type="button" onClick={() => setRetry(value => value + 1)}>Retry loading</button>}<p className="settings-description">Choose a server to configure its tools.</p>{state === 'loading' ? <p className="settings-empty">Loading MCP tools…</p> : grantableConnections.length === 0 ? <p className="settings-empty">No grantable MCP tools available. Add and discover one under Connections.</p> : <div className="mcp-server-selector">{grantableConnections.map(connection => { const selectedCount = grantableTools(connection).filter(tool => enabled.has(`${connection.id}:${tool.name}`)).length; return <button type="button" className={selectedConnection?.id === connection.id ? 'active' : ''} aria-pressed={selectedConnection?.id === connection.id} onClick={() => { if (selectedConnection?.id !== connection.id) navigate(() => setSelectedConnectionId(connection.id)); }} key={connection.id}><strong>{connection.name}</strong><small>{selectedCount}/{grantableTools(connection).length} grants</small></button>; })}</div>}{error && <p className="settings-request-error" role="alert">{error}</p>}</SettingSection>;
    const overflow = <div className="settings-overflow-content mcp-tools-overflow">{selectedConnection ? <SettingSection title={`${selectedConnection.name} tools`}><p className="settings-description">Choose the discovered tools this agent may use.</p>{toolOptions(selectedConnection)}{error && <p className="settings-request-error" role="alert">{error}</p>}{state === 'saving' && <p role="status">Saving MCP tool grants…</p>}{Object.keys(failedGrants).length > 0 && <div className="card-actions"><button className="secondary" type="button" onClick={retryFailed} disabled={state !== 'idle'}>Retry failed MCP tool changes</button></div>}</SettingSection> : <><strong>Selectable tools</strong><p className="settings-empty">Select a connected tool server.</p></>}</div>;
    return <>{serverList}{createPortal(overflow, overflowTarget)}</>;
  }

  return <SettingSection title="MCP tools">{state === 'error' && <button type="button" onClick={() => setRetry(value => value + 1)}>Retry loading</button>}<p className="settings-description">Choose the discovered MCP tools this agent may use.</p>{state === 'loading' ? <p className="settings-empty">Loading MCP tools…</p> : grantableConnections.length === 0 ? <p className="settings-empty">No grantable MCP tools available. Add and discover one under Connections.</p> : <div className="mcp-tool-list">{grantableConnections.map(connection => { const selectedCount = grantableTools(connection).filter(tool => enabled.has(`${connection.id}:${tool.name}`)).length; return <details className="mcp-tool-group" key={connection.id}><summary><strong>{connection.name}</strong><small>{selectedCount}/{grantableTools(connection).length} grants</small></summary>{toolOptions(connection)}</details>; })}</div>}{error && <p className="settings-request-error" role="alert">{error}</p>}{state === 'saving' && <p role="status">Saving MCP tool grants…</p>}{Object.keys(failedGrants).length > 0 && <div className="card-actions"><button className="secondary" type="button" onClick={retryFailed} disabled={state !== 'idle'}>Retry failed MCP tool changes</button></div>}</SettingSection>;
}
