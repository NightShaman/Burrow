import { useEffect, useState } from 'react';
import { apiForTarget } from '../../app/api';
import { targetForResource, type ApiTarget } from '../../app/apiTargets';
import { SettingSection } from './SettingsPrimitives';

type McpTool = { name: string; description?: string | null; inputSchema?: Record<string, unknown> };
type McpConnection = { id: string; name: string; transport: 'http' | 'stdio'; baseUrl: string | null; command: string | null; args: string[]; enabled: boolean; apiKeyConfigured: boolean; tools: McpTool[] };

export function AgentMcpTools({ agentId, targets }: { agentId: string; targets: ApiTarget[] }) {
  const owner = targetForResource(targets, agentId);
  const request = <T,>(path: string, init?: RequestInit) => apiForTarget<T>(owner.target, path, init);
  const [connections, setConnections] = useState<McpConnection[]>([]); const [enabled, setEnabled] = useState<Set<string>>(new Set()); const [state, setState] = useState<'loading' | 'idle' | 'saving'>('loading'); const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    setState('loading'); setError('');
    Promise.all([
      request<{ connections: McpConnection[] }>('/api/settings/mcp-connections', { signal: controller.signal }),
      request<{ tools: { connectionId: string; toolName: string; enabled: boolean }[] }>(`/api/agents/${encodeURIComponent(owner.resourceId)}/mcp-tools`, { signal: controller.signal }),
    ]).then(([catalog, grants]) => {
      if (controller.signal.aborted) return;
      setConnections(catalog.connections ?? []);
      setEnabled(new Set((grants.tools ?? []).filter(tool => tool.enabled).map(tool => `${tool.connectionId}:${tool.toolName}`)));
      setState('idle');
    }).catch(cause => {
      if (controller.signal.aborted) return;
      setError(cause instanceof Error ? `Could not load MCP tools: ${cause.message}` : 'Could not load MCP tools.');
      setState('idle');
    });
    return () => controller.abort();
  }, [owner.target.id, owner.resourceId]);
  const toggleConnection = (connection: McpConnection) => setEnabled(current => {
    const keys = connection.tools.map(tool => `${connection.id}:${tool.name}`);
    const selectAll = !keys.every(key => current.has(key));
    const next = new Set(current);
    keys.forEach(key => selectAll ? next.add(key) : next.delete(key));
    return next;
  });
  const save = async () => { setState('saving'); setError(''); try { const tools = connections.flatMap(connection => connection.tools.filter(tool => enabled.has(`${connection.id}:${tool.name}`)).map(tool => ({ connectionId: connection.id, toolName: tool.name, enabled: true }))); await request(`/api/agents/${encodeURIComponent(owner.resourceId)}/mcp-tools`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tools }) }); } catch (cause) { setError(cause instanceof Error ? `Could not save MCP tools: ${cause.message}` : 'Could not save MCP tools.'); } finally { setState('idle'); } };
  return <SettingSection title="MCP tools"><p className="settings-description">Choose the discovered MCP tools this agent may use.</p>{state === 'loading' ? <p className="settings-empty">Loading MCP tools…</p> : connections.length === 0 ? <p className="settings-empty">No MCP servers available. Add and discover one under Connections.</p> : <div className="mcp-tool-list">{connections.map(connection => { const selectedCount = connection.tools.filter(tool => enabled.has(`${connection.id}:${tool.name}`)).length; const allSelected = connection.tools.length > 0 && selectedCount === connection.tools.length; return <details className="mcp-tool-group" key={connection.id}><summary><strong>{connection.name}</strong><small>{selectedCount}/{connection.tools.length} enabled</small></summary>{connection.tools.length ? <div className="mcp-tool-options"><label className="mcp-tool-select-all"><input type="checkbox" checked={allSelected} onChange={() => toggleConnection(connection)} /><span><b>{allSelected ? 'Clear all' : 'Select all'}</b><small>{connection.tools.length} {connection.tools.length === 1 ? 'tool' : 'tools'}</small></span></label>{connection.tools.map(tool => { const key = `${connection.id}:${tool.name}`; return <label key={key}><input type="checkbox" checked={enabled.has(key)} onChange={() => setEnabled(current => { const next = new Set(current); next.has(key) ? next.delete(key) : next.add(key); return next; })} /><span><b>{tool.name}</b>{tool.description && <small>{tool.description}</small>}</span></label>; })}</div> : <small>No tools discovered yet.</small>}</details>; })}</div>}{error && <p className="settings-request-error" role="alert">{error}</p>}<div className="card-actions"><button className="primary" onClick={() => void save()} disabled={state !== 'idle'}>{state === 'saving' ? 'Saving…' : 'Save MCP tools'}</button></div></SettingSection>;
}

