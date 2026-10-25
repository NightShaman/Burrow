import { useUnsavedChanges, useUnsavedNavigation } from '../../app/UnsavedChanges';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../../app/api';
import { useConfirm } from '../../app/ConfirmDialog';
import { Field, SettingSection } from './SettingsPrimitives';

import { McpHttpHeaders, serializeHttpHeaders, validateHttpHeaders, type HttpHeaderRow } from './McpHttpHeaders';

type McpTool = { name: string; description?: string | null; inputSchema?: Record<string, unknown> };
type McpEnvironmentVariable = { name: string; configured: boolean };
type EnvironmentRow = McpEnvironmentVariable & { value: string };
type McpConnection = { id: string; name: string; transport: 'http' | 'stdio' | 'mod'; lifecycle: 'ephemeral' | 'keep_alive'; baseUrl: string | null; command: string | null; args: string[]; enabled: boolean; apiKeyConfigured: boolean; environmentVariables: McpEnvironmentVariable[]; headerNames?: string[]; tools: McpTool[] };

export const isModManagedMcpConnection = (connection: Pick<McpConnection, 'transport'>) => connection.transport === 'mod';

type McpEnvironmentVariableWrite = { name: string; value?: string };

// The server intentionally never returns secret values. An existing configured
// row with no replacement value must therefore be sent by name to preserve its
// secret, while a new blank row must be omitted entirely.
export function serializeEnvironmentVariables(rows: EnvironmentRow[]): McpEnvironmentVariableWrite[] {
  return rows.flatMap(({ name, value, configured }) => {
    const variableName = name.trim();
    const secret = value.trim();
    if (!variableName || (!secret && !configured)) return [];
    return [{ name: variableName, ...(secret ? { value: secret } : {}) }];
  });
}

export function McpConnections({ overflowTarget }: { overflowTarget?: HTMLElement | null } = {}) {
  const confirm = useConfirm();
  const navigate = useUnsavedNavigation();
  const saving = useRef(false);
  const emptyDraft = JSON.stringify(['', 'http', 'ephemeral', '', '', '', '', [], []]);
  const [baseline, setBaseline] = useState(emptyDraft);
  const nextEnvironmentId = useRef(0);
  const nextHeaderId = useRef(0);
  const [httpHeaders, setHttpHeaders] = useState<HttpHeaderRow[]>([]);
  const [connections, setConnections] = useState<McpConnection[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [transport, setTransport] = useState<'http' | 'stdio'>('http');
  const [lifecycle, setLifecycle] = useState<'ephemeral' | 'keep_alive'>('ephemeral');
  const [baseUrl, setBaseUrl] = useState('');
  const [command, setCommand] = useState('');
  const [argsText, setArgsText] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [apiKeyConfigured, setApiKeyConfigured] = useState(false);
  const [environmentVariables, setEnvironmentVariables] = useState<(EnvironmentRow & { rowId: number })[]>([]);
  const [busy, setBusy] = useState<'idle' | 'saving' | 'discovering' | 'deleting'>('idle');
  const [error, setError] = useState('');
  const [inventoryState, setInventoryState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [savedRefreshPending, setSavedRefreshPending] = useState(false);
  const load = async (afterSave = false) => {
    try {
      const result = await api<{ connections: McpConnection[] }>('/api/settings/mcp-connections');
      setConnections(result.connections ?? []); setInventoryState('ready'); setError('');
      if (savedRefreshPending) { reset(); setSavedRefreshPending(false); }
      return true;
    } catch (cause) {
      const detail = cause instanceof Error ? `: ${cause.message}` : '.';
      setError(afterSave || savedRefreshPending ? `MCP connection saved, but could not refresh MCP connections${detail} Your draft is still open; retry loading before editing again.` : `Could not load MCP connections${detail}`);
      setInventoryState(state => state === 'loading' ? 'failed' : state);
      return false;
    }
  };
  useEffect(() => { void load(); }, []);
  const reset = () => { setBaseline(emptyDraft); setEditingId(null); setName(''); setTransport('http'); setLifecycle('ephemeral'); setBaseUrl(''); setCommand(''); setArgsText(''); setApiKey(''); setApiKeyConfigured(false); setEnvironmentVariables([]); setHttpHeaders([]); setError(''); };
  const edit = (connection: McpConnection) => { if (savedRefreshPending || busy !== 'idle' || isModManagedMcpConnection(connection)) return; setBaseline(JSON.stringify([connection.name, connection.transport === 'stdio' ? 'stdio' : 'http', connection.lifecycle ?? 'ephemeral', connection.baseUrl ?? '', connection.command ?? '', (connection.args ?? []).join('\n'), '', (connection.environmentVariables ?? []).map(variable => ({ ...variable, value: '' })), (connection.headerNames ?? []).map(name => ({ name, value: '', configured: true, replacing: false }))])); setHttpHeaders((connection.headerNames ?? []).map(name => ({ name, value: '', configured: true, replacing: false, rowId: nextHeaderId.current++ }))); setEditingId(connection.id); setName(connection.name); setTransport(connection.transport === 'stdio' ? 'stdio' : 'http'); setLifecycle(connection.lifecycle ?? 'ephemeral'); setBaseUrl(connection.baseUrl ?? ''); setCommand(connection.command ?? ''); setArgsText((connection.args ?? []).join('\n')); setApiKey(''); setApiKeyConfigured(connection.apiKeyConfigured); setEnvironmentVariables((connection.environmentVariables ?? []).map(variable => ({ ...variable, value: '', rowId: nextEnvironmentId.current++ }))); setError(''); };
  const valid = Boolean(name.trim() && (transport === 'http' ? baseUrl.trim() : command.trim()));
  const save = async () => { if (busy !== 'idle' || inventoryState !== 'ready' || savedRefreshPending || saving.current) return false; if (!valid) { setError(name.trim() ? (transport === 'http' ? 'Enter a server URL before saving.' : 'Enter a command before saving.') : 'Enter a name before saving.'); return false; } if (transport === 'http') { const headerError = validateHttpHeaders(httpHeaders); if (headerError) { setError(headerError); return false; } } saving.current = true; setBusy('saving'); setError(''); try { await api('/api/settings/mcp-connections', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...(editingId ? { id: editingId } : {}), name: name.trim(), transport, lifecycle, enabled: true, ...(transport === 'http' ? { baseUrl: baseUrl.trim(), headers: serializeHttpHeaders(httpHeaders), ...(apiKey ? { apiKey } : {}) } : { command: command.trim(), args: argsText.split('\n').map(value => value.trim()).filter(Boolean), environmentVariables: serializeEnvironmentVariables(environmentVariables) }) }) }); if (await load(true)) { reset(); return true; } setSavedRefreshPending(true); return false; } catch (cause) { setError(cause instanceof Error ? `Could not save MCP connection: ${cause.message}` : 'Could not save MCP connection.'); } finally { saving.current = false; setBusy('idle'); } return false; };
  useUnsavedChanges({ dirty: !savedRefreshPending && JSON.stringify([name, transport, lifecycle, baseUrl, command, argsText, apiKey, environmentVariables.map(({ rowId: _rowId, ...variable }) => variable), httpHeaders.map(({ rowId: _rowId, ...header }) => header)]) !== baseline, busy: busy !== 'idle', save, discard: reset });
  const discover = async (id: string) => { if (savedRefreshPending || busy !== 'idle') return; setBusy('discovering'); setError(''); try { await api('/api/settings/mcp-connections/discover', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ connectionId: id }) }); await load(); } catch (cause) { setError(cause instanceof Error ? `Could not discover MCP tools: ${cause.message}` : 'Could not discover MCP tools.'); } finally { setBusy('idle'); } };
  const remove = async (connection: McpConnection) => { if (savedRefreshPending || busy !== 'idle') return; if (!await confirm({ title: 'Delete MCP connection?', message: `Delete ${connection.name}? This also removes its agent tool grants.`, confirmLabel: 'Delete connection', tone: 'danger' })) return; setBusy('deleting'); try { await api(`/api/settings/mcp-connections/${encodeURIComponent(connection.id)}`, { method: 'DELETE' }); setConnections(items => items.filter(item => item.id !== connection.id)); if (editingId === connection.id) reset(); } catch (cause) { setError(cause instanceof Error ? `Could not delete MCP connection: ${cause.message}` : 'Could not delete MCP connection.'); } finally { setBusy('idle'); } };
  const inventoryContents = inventoryState === 'loading' ? <p className="settings-empty">Loading MCP servers…</p> : inventoryState === 'failed' ? <div><p className="settings-request-error" role="alert">{error}</p><button className="secondary" type="button" onClick={() => { setInventoryState('loading'); void load(); }}>Retry</button></div> : connections.length === 0 ? <p className="settings-empty">No MCP servers saved yet.</p> : <div className="memory-connection-list">{connections.map(connection => {
    const modManaged = isModManagedMcpConnection(connection);
    const endpoint = connection.transport === 'stdio' ? [connection.command, ...(connection.args ?? [])].filter(Boolean).join(' ') : connection.baseUrl;
    return <article className={`memory-connection${modManaged ? ' memory-connection-mod-managed' : ''}`} key={connection.id}>
      {modManaged ? <div className="memory-connection-select"><strong>{connection.name}</strong><small>{endpoint} · {connection.tools.length} tools · Managed by mod</small></div> : <button type="button" className="memory-connection-select" aria-label={`Edit ${connection.name}`} aria-pressed={editingId === connection.id} onClick={() => { if (editingId !== connection.id) navigate(() => edit(connection)); }} disabled={busy !== 'idle'}><strong>{connection.name}</strong><small>{endpoint} · {connection.tools.length} tools</small></button>}
      {modManaged ? <span className="memory-connection-managed" aria-label="Read only">Mod managed · Read only</span> : <div className="memory-connection-actions"><button className="secondary memory-edit" onClick={() => void discover(connection.id)} disabled={busy !== 'idle'}>{busy === 'discovering' ? 'Discovering…' : 'Discover tools'}</button><button className="memory-delete" onClick={() => { if (editingId === connection.id) navigate(() => void remove(connection)); else void remove(connection); }} aria-label={`Delete ${connection.name}`} title="Delete">×</button></div>}
    </article>;
  })}</div>;
  const inventory = overflowTarget
    ? <div className="settings-overflow-content memory-saved">{inventoryContents}</div>
    : <details className="memory-saved saved-accordion"><summary><h3>Saved MCP servers</h3><span>{connections.length}</span></summary>{inventoryContents}</details>;
  return <><SettingSection title="MCP"><p className="settings-description">Connect an HTTP or local stdio MCP server, then discover its tools for agent grants. Mod-provided servers are managed by their mod.</p><div className="field-pair"><Field label="Name"><input disabled={savedRefreshPending || busy !== 'idle'} value={name} onChange={event => setName(event.target.value)} placeholder="Home Assistant" /></Field><Field label="Transport"><select disabled={savedRefreshPending || busy !== 'idle'} value={transport} onChange={event => setTransport(event.target.value as 'http' | 'stdio')}><option value="http">HTTP</option><option value="stdio">Local stdio</option></select></Field></div><div className="field-pair"><Field label="Connection lifecycle"><select disabled={savedRefreshPending || busy !== 'idle'} value={lifecycle} onChange={event => setLifecycle(event.target.value as 'ephemeral' | 'keep_alive')}><option value="ephemeral">Ephemeral</option><option value="keep_alive">Keep alive</option></select></Field><div /></div><p className="settings-description mcp-lifecycle-hint">Keep alive preserves a stateful MCP session between calls, so servers such as Chrome DevTools can retain tabs and selection.</p>{transport === 'http' ? <div className="field-pair"><Field label="Server URL"><input disabled={savedRefreshPending || busy !== 'idle'} value={baseUrl} onChange={event => setBaseUrl(event.target.value)} placeholder="http://host:4000/mcp" /></Field><Field label="API key (optional)"><input disabled={savedRefreshPending || busy !== 'idle'} type="password" value={apiKey} onChange={event => setApiKey(event.target.value)} placeholder={apiKeyConfigured ? '•••••••• (configured — enter a new key to replace it)' : 'Enter API key'} /></Field></div> : <div className="field-pair"><Field label="Command"><input disabled={savedRefreshPending || busy !== 'idle'} value={command} onChange={event => setCommand(event.target.value)} placeholder="npx" /></Field><Field label="Arguments"><textarea disabled={savedRefreshPending || busy !== 'idle'} className="mcp-arguments" value={argsText} onChange={event => setArgsText(event.target.value)} placeholder={'-y\n@modelcontextprotocol/server-filesystem\n/path/to/files'} rows={4} /></Field></div>}{transport === 'http' && <McpHttpHeaders rows={httpHeaders} onChange={setHttpHeaders} onAdd={() => setHttpHeaders(rows => [...rows, { rowId: nextHeaderId.current++, name: '', value: '', configured: false, replacing: false }])} disabled={savedRefreshPending || busy !== 'idle'} />}{transport === 'stdio' && <div className="mcp-environment"><div className="mcp-environment-heading"><strong>Environment variables</strong><button className="secondary" type="button" disabled={savedRefreshPending || busy !== 'idle'} onClick={() => setEnvironmentVariables(rows => [...rows, { name: '', value: '', configured: false, rowId: nextEnvironmentId.current++ }])}>Add variable</button></div><p className="settings-description">Provider-scoped secrets are encrypted and never shown after saving.</p>{environmentVariables.map((variable, index) => <div className="mcp-environment-row" key={variable.rowId}><input disabled={savedRefreshPending || busy !== 'idle'} value={variable.name} onChange={event => setEnvironmentVariables(rows => rows.map((row, rowIndex) => rowIndex === index ? { ...row, name: event.target.value } : row))} placeholder="BW_SESSION" aria-label={`Environment variable ${index + 1} name`} /><input disabled={savedRefreshPending || busy !== 'idle'} type="password" value={variable.value} onChange={event => setEnvironmentVariables(rows => rows.map((row, rowIndex) => rowIndex === index ? { ...row, value: event.target.value } : row))} placeholder={variable.configured ? '•••••••• (configured — enter a value to replace it)' : 'Secret value'} aria-label={`Environment variable ${index + 1} value`} /><button className="memory-delete" type="button" disabled={savedRefreshPending || busy !== 'idle'} onClick={() => setEnvironmentVariables(rows => rows.filter((_, rowIndex) => rowIndex !== index))} aria-label={`Remove ${variable.name || 'environment variable'}`} title="Remove">×</button></div>)}</div>}<p className="settings-description mcp-args-hint">{transport === 'stdio' ? 'Use one command argument per line.' : 'Credentials are encrypted and never shown after saving.'}</p><div className="model-actions">{editingId && <button className="secondary" onClick={() => navigate(reset)} disabled={busy !== 'idle' || savedRefreshPending}>Cancel</button>}<button className="primary" onClick={() => void save()} disabled={busy !== 'idle' || inventoryState !== 'ready' || savedRefreshPending || !valid}>{busy === 'saving' ? 'Saving…' : editingId ? 'Save changes' : 'Add MCP server'}</button></div>{error && inventoryState !== 'failed' && <p className="settings-request-error" role="alert">{error} {savedRefreshPending && <button className="secondary" type="button" onClick={() => void load()}>Retry loading</button>}</p>}{!overflowTarget && inventory}</SettingSection>{overflowTarget && createPortal(inventory, overflowTarget)}</>;
}
