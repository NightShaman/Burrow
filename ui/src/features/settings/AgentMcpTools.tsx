import { createPortal } from 'react-dom';
import { useEffect, useState } from 'react';
import { apiForTarget } from '../../app/api';
import { targetForResource, type ApiTarget } from '../../app/apiTargets';
import { SettingSection } from './SettingsPrimitives';

type McpTool = { name: string; description?: string | null; inputSchema?: Record<string, unknown>; availability?: 'grant-required' | 'mod-authorized' | string };
type McpConnection = { id: string; name: string; transport: 'http' | 'stdio' | 'mod'; baseUrl: string | null; command: string | null; args: string[]; enabled: boolean; apiKeyConfigured: boolean; tools: McpTool[] };

export const isModAuthorizedTool = (connection: Pick<McpConnection, 'transport'>, tool: Pick<McpTool, 'availability'>) => connection.transport === 'mod' && tool.availability === 'mod-authorized';
export const grantableTools = (connection: McpConnection) => connection.tools.filter(tool => !isModAuthorizedTool(connection, tool));

export function AgentMcpTools({ agentId, targets, overflowTarget }: { agentId: string; targets: ApiTarget[]; overflowTarget?: HTMLElement | null }) {
  const owner = targetForResource(targets, agentId);
  const request = <T,>(path: string, init?: RequestInit) => apiForTarget<T>(owner.target, path, init);
  const [connections, setConnections] = useState<McpConnection[]>([]);
  const [selectedConnectionId, setSelectedConnectionId] = useState('');
  const [enabled, setEnabled] = useState<Set<string>>(new Set());
  const [historicalModGrants, setHistoricalModGrants] = useState<{ connectionId: string; toolName: string; enabled: boolean }[]>([]);
  const [state, setState] = useState<'loading' | 'idle' | 'saving'>('loading');
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    setState('loading'); setError('');
    Promise.all([
      request<{ connections: McpConnection[] }>('/api/settings/mcp-connections', { signal: controller.signal }),
      request<{ tools: { connectionId: string; toolName: string; enabled: boolean }[] }>(`/api/agents/${encodeURIComponent(owner.resourceId)}/mcp-tools`, { signal: controller.signal }),
    ]).then(([catalog, grants]) => {
      if (controller.signal.aborted) return;
      const nextConnections = catalog.connections ?? [];
      setConnections(nextConnections);
      setSelectedConnectionId(current => nextConnections.some(connection => connection.id === current) ? current : (nextConnections[0]?.id ?? ''));
      const modAuthorizedKeys = new Set(nextConnections.flatMap(connection => connection.tools.filter(tool => isModAuthorizedTool(connection, tool)).map(tool => `${connection.id}:${tool.name}`)));
      setHistoricalModGrants((grants.tools ?? []).filter(tool => modAuthorizedKeys.has(`${tool.connectionId}:${tool.toolName}`)));
      setEnabled(new Set((grants.tools ?? []).filter(tool => tool.enabled && !modAuthorizedKeys.has(`${tool.connectionId}:${tool.toolName}`)).map(tool => `${tool.connectionId}:${tool.toolName}`)));
      setState('idle');
    }).catch(cause => {
      if (controller.signal.aborted) return;
      setError(cause instanceof Error ? `Could not load MCP tools: ${cause.message}` : 'Could not load MCP tools.');
      setState('idle');
    });
    return () => controller.abort();
  }, [owner.target.id, owner.resourceId]);
  const toggleConnection = (connection: McpConnection) => setEnabled(current => {
    const keys = grantableTools(connection).map(tool => `${connection.id}:${tool.name}`);
    const selectAll = !keys.every(key => current.has(key));
    const next = new Set(current);
    keys.forEach(key => selectAll ? next.add(key) : next.delete(key));
    return next;
  });
  const toggleTool = (connection: McpConnection, tool: McpTool) => {
    if (isModAuthorizedTool(connection, tool)) return;
    setEnabled(current => {
    const key = `${connection.id}:${tool.name}`;
    const next = new Set(current);
    next.has(key) ? next.delete(key) : next.add(key);
    return next;
    });
  };
  const save = async () => { setState('saving'); setError(''); try { const tools = [...historicalModGrants, ...connections.flatMap(connection => grantableTools(connection).filter(tool => enabled.has(`${connection.id}:${tool.name}`)).map(tool => ({ connectionId: connection.id, toolName: tool.name, enabled: true })))]; await request(`/api/agents/${encodeURIComponent(owner.resourceId)}/mcp-tools`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tools }) }); } catch (cause) { setError(cause instanceof Error ? `Could not save MCP tools: ${cause.message}` : 'Could not save MCP tools.'); } finally { setState('idle'); } };
  const grantableConnections = connections.filter(connection => grantableTools(connection).length > 0);
  const selectedConnection = grantableConnections.find(connection => connection.id === selectedConnectionId) ?? grantableConnections[0];
  const toolOptions = (connection: McpConnection) => {
    const tools = grantableTools(connection);
    const selectedCount = tools.filter(tool => enabled.has(`${connection.id}:${tool.name}`)).length;
    const allSelected = tools.length > 0 && selectedCount === tools.length;
    const managedCount = connection.tools.length - tools.length;
    if (!tools.length && managedCount) return <p className="settings-description">All {managedCount} {managedCount === 1 ? 'tool is' : 'tools are'} authorized directly by the mod; no agent grants are needed.</p>;
    return tools.length ? <div className="mcp-tool-options"><label className="mcp-tool-select-all"><input type="checkbox" checked={allSelected} onChange={() => toggleConnection(connection)} /><span><b>{allSelected ? 'Clear all' : 'Select all'}</b><small>{tools.length} grantable {tools.length === 1 ? 'tool' : 'tools'}</small></span></label>{tools.map(tool => { const key = `${connection.id}:${tool.name}`; return <label key={key}><input type="checkbox" checked={enabled.has(key)} onChange={() => toggleTool(connection, tool)} /><span><b>{tool.name}</b>{tool.description && <small>{tool.description}</small>}</span></label>; })}{managedCount > 0 && <p className="settings-description">{managedCount} mod-authorized {managedCount === 1 ? 'tool is' : 'tools are'} omitted from agent grants.</p>}</div> : <small>No tools discovered yet.</small>;
  };

  if (overflowTarget) {
    const serverList = <SettingSection title="Connected tool servers"><p className="settings-description">Choose a server to configure its tools.</p>{state === 'loading' ? <p className="settings-empty">Loading MCP tools…</p> : grantableConnections.length === 0 ? <p className="settings-empty">No grantable MCP tools available. Add and discover one under Connections.</p> : <div className="mcp-server-selector">{grantableConnections.map(connection => { const selectedCount = grantableTools(connection).filter(tool => enabled.has(`${connection.id}:${tool.name}`)).length; return <button type="button" className={selectedConnection?.id === connection.id ? 'active' : ''} aria-pressed={selectedConnection?.id === connection.id} onClick={() => setSelectedConnectionId(connection.id)} key={connection.id}><strong>{connection.name}</strong><small>{selectedCount}/{grantableTools(connection).length} grants</small></button>; })}</div>}{error && <p className="settings-request-error" role="alert">{error}</p>}</SettingSection>;
    const overflow = <div className="settings-overflow-content mcp-tools-overflow">{selectedConnection ? <SettingSection title={`${selectedConnection.name} tools`}><p className="settings-description">Choose the discovered tools this agent may use.</p>{toolOptions(selectedConnection)}{error && <p className="settings-request-error" role="alert">{error}</p>}<div className="card-actions"><button className="primary" onClick={() => void save()} disabled={state !== 'idle'}>{state === 'saving' ? 'Saving…' : 'Save MCP tools'}</button></div></SettingSection> : <><strong>Selectable tools</strong><p className="settings-empty">Select a connected tool server.</p></>}</div>;
    return <>{serverList}{createPortal(overflow, overflowTarget)}</>;
  }

  return <SettingSection title="MCP tools"><p className="settings-description">Choose the discovered MCP tools this agent may use.</p>{state === 'loading' ? <p className="settings-empty">Loading MCP tools…</p> : grantableConnections.length === 0 ? <p className="settings-empty">No grantable MCP tools available. Add and discover one under Connections.</p> : <div className="mcp-tool-list">{grantableConnections.map(connection => { const selectedCount = grantableTools(connection).filter(tool => enabled.has(`${connection.id}:${tool.name}`)).length; return <details className="mcp-tool-group" key={connection.id}><summary><strong>{connection.name}</strong><small>{selectedCount}/{grantableTools(connection).length} grants</small></summary>{toolOptions(connection)}</details>; })}</div>}{error && <p className="settings-request-error" role="alert">{error}</p>}<div className="card-actions"><button className="primary" onClick={() => void save()} disabled={state !== 'idle'}>{state === 'saving' ? 'Saving…' : 'Save MCP tools'}</button></div></SettingSection>;
}
