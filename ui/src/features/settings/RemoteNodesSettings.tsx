import { useEffect, useRef, useState } from 'react';
import { api } from '../../app/api';
import type { Agent } from '../../app/types';
import { Field, SettingSection } from './SettingsPrimitives';
import './remote-nodes.css';

type TlsState = { configured: boolean; ready: boolean; keyConfigured: boolean; certConfigured: boolean; caConfigured: boolean };
type Controller = { enabled: boolean; host: string; port: number; running: boolean; error?: string; tls?: TlsState };
type PendingController = Pick<Controller, 'enabled' | 'host' | 'port'>;
type Trust = { gatewayId: string; controllerId: string; trusted?: boolean; approved?: boolean; revoked?: boolean; status?: string };
type Gateway = { gatewayId: string; status: string; connected?: boolean; connectedAt?: string | null; lastSeenAt?: string | null; activeOperations?: string[]; name?: string | null; version?: string | null; protocolVersion?: string | null };
type Operation = { gatewayId: string; operationId: string; kind: 'process' | 'filesystem' | string; state: 'dispatching' | 'running' | 'interrupted' | 'terminal' | string; replay?: boolean; reconnectRequired?: boolean; terminalOutcome?: string | null; startedAt?: string | null; acceptedAt?: string | null; endedAt?: string | null; durationMs?: number | null };
type Pairing = { id?: string; pairingId?: string; nodeId?: string | null; gatewayId?: string | null; controllerId?: string | null; status?: string; requestedAt?: string | null; name?: string | null; hostname?: string | null; platform?: string | null; metadata?: { name?: string | null; version?: string | null; protocolVersion?: string | null }; pairingCode?: string | null; code?: string | null; expiresAt?: string | null };

export type RemoteNodesSection = 'controller' | 'pairings' | 'gateways' | 'assignments' | 'operations';
type Props = { agents: Agent[]; targets?: unknown[]; onAgentsChanged: () => Promise<void>; section?: RemoteNodesSection };
const headers = { 'content-type': 'application/json' };
const message = (error: unknown, fallback: string) => error instanceof Error ? `${fallback}: ${error.message}` : fallback;
const formatTime = (value?: string | null) => value ? new Date(value).toLocaleString() : '—';
const formatDuration = (value?: number | null) => value == null ? '—' : value < 1000 ? `${value} ms` : `${(value / 1000).toFixed(1)} s`;
const trustState = (item: Trust, connection?: Gateway) => {
  const connected = Boolean(connection?.connected);
  const explicitlyRevoked = Boolean(item.revoked) || String(item.status || '').toLowerCase() === 'revoked';
  const configuredApproved = Boolean(item.approved ?? item.trusted);
  const approved = configuredApproved || connected;
  return {
    connected,
    revoked: explicitlyRevoked && !connected,
    approved,
    label: explicitlyRevoked && !connected ? 'Revoked' : configuredApproved ? 'Approved / trusted' : connected ? 'Authenticated / approved' : 'Approval status unavailable',
  };
};

export function RemoteNodesSettings({ agents, onAgentsChanged, section = 'controller' }: Props) {
  const [controller, setController] = useState<Controller | null>(null);
  const [pendingController, setPendingController] = useState<PendingController | null>(null);
  const pendingControllerRef = useRef<PendingController | null>(null);
  const [trust, setTrust] = useState<Trust[]>([]);
  const [gateways, setGateways] = useState<Gateway[]>([]);
  const [operations, setOperations] = useState<Operation[]>([]);
  const [pairings, setPairings] = useState<Pairing[]>([]);
  const [enabled, setEnabled] = useState(false); const [host, setHost] = useState('127.0.0.1'); const [port, setPort] = useState('7443');
  const [gatewayId, setGatewayId] = useState(''); const [controllerId, setControllerId] = useState('controller'); const [secret, setSecret] = useState('');
  const [tlsKey, setTlsKey] = useState(''); const [tlsCert, setTlsCert] = useState(''); const [tlsCa, setTlsCa] = useState('');
  const [busy, setBusy] = useState(''); const [error, setError] = useState(''); const [notice, setNotice] = useState('');

  const load = async () => { try {
    const [c, t, g, o, p] = await Promise.all([
      api<{ controller: Controller }>('/api/mods/remote-nodes/controller'),
      api<{ gateways: Trust[] }>('/api/mods/remote-nodes/gateway-trust'),
      api<{ gateways: Gateway[] }>('/api/mods/remote-nodes/gateways'),
      api<{ operations: Operation[] }>('/api/mods/remote-nodes/operations?limit=50'),
      api<{ pairings?: Pairing[] }>('/api/mods/remote-nodes/pairings?limit=50'),
    ]);
    setController(c.controller);
    const savedPending = pendingControllerRef.current;
    const caughtUp = savedPending && savedPending.enabled === c.controller.enabled && savedPending.host === c.controller.host && savedPending.port === c.controller.port;
    if (caughtUp) { pendingControllerRef.current = null; setPendingController(null); }
    const displayed = caughtUp ? c.controller : savedPending ?? c.controller;
    setEnabled(displayed.enabled); setHost(displayed.host); setPort(String(displayed.port));
    setTrust(t.gateways ?? []); setGateways(g.gateways ?? []); setOperations(o.operations ?? []); setPairings(p.pairings ?? []);
  } catch (cause) { setError(message(cause, 'Could not load controller status')); } };
  useEffect(() => { void load(); const timer = window.setInterval(() => { void load(); }, 10000); return () => window.clearInterval(timer); }, []);
  const request = async (key: string, path: string, init: RequestInit, success: string) => { setBusy(key); setError(''); setNotice(''); try { const result = await api<{ restartRequired?: boolean }>(path, init); setNotice(`${success}${result.restartRequired ? ' Burrow restart required.' : ''}`); await load(); return true; } catch (cause) { setError(message(cause, 'Request failed')); return false; } finally { setBusy(''); } };
  const saveController = async () => {
    const next: PendingController = { enabled, host: host.trim(), port: Number(port) };
    const saved = await request('controller', '/api/mods/remote-nodes/controller', { method: 'PUT', headers, body: JSON.stringify(next) }, 'Controller configuration saved.');
    if (saved) { pendingControllerRef.current = next; setEnabled(next.enabled); setHost(next.host); setPort(String(next.port)); setPendingController(next); }
  };
  const saveTls = () => { if (!tlsKey.trim() || !tlsCert.trim()) { setError('TLS private key and certificate are required.'); return; } void request('tls', '/api/mods/remote-nodes/controller/tls', { method: 'PUT', headers, body: JSON.stringify({ key: tlsKey, cert: tlsCert, ...(tlsCa ? { ca: tlsCa } : {}) }) }, 'TLS credentials saved.').then(() => { setTlsKey(''); setTlsCert(''); setTlsCa(''); }); };
  const saveGateway = () => { if (!gatewayId.trim() || !secret) { setError('Gateway ID and enrollment secret are required.'); return; } void request('gateway', `/api/mods/remote-nodes/gateway-trust/${encodeURIComponent(gatewayId.trim())}`, { method: 'PUT', headers, body: JSON.stringify({ controllerId: controllerId.trim(), secret }) }, 'Gateway enrolled or rotated.').then(() => { setSecret(''); }); };
  const revoke = (id: string) => { if (!window.confirm(`Revoke ${id}? Existing connections remain until restart.`)) return; void request('revoke', `/api/mods/remote-nodes/gateway-trust/${encodeURIComponent(id)}`, { method: 'DELETE' }, 'Gateway revoked.'); };
  const clearTls = () => { if (!window.confirm('Clear controller TLS credentials?')) return; void request('clear-tls', '/api/mods/remote-nodes/controller/tls', { method: 'DELETE' }, 'TLS credentials cleared.'); };
  const pairingAction = (pairing: Pairing, action: 'approve' | 'reject') => {
    const id = pairing.gatewayId || pairing.nodeId;
    if (!id) { setError('This pairing has no usable gateway identity.'); return; }
    const verb = action === 'approve' ? 'Approve' : 'Reject';
    const warning = action === 'approve' ? `Approve ${id}? This enables the node to execute operations on its host.` : `Reject pairing request from ${id}?`;
    if (!window.confirm(`${verb} this pending Node Goblin pairing?\\n\\n${warning}`)) return;
    void request(`pairing-${action}`, `/api/mods/remote-nodes/pairings/${encodeURIComponent(id)}/${action}`, { method: 'POST', headers }, action === 'approve' ? 'Node Goblin approved; execution is now enabled.' : 'Pairing request rejected.');
  };
  const tls = controller?.tls;
  return <div className="remote-nodes-settings">
    {section === 'controller' && <><SettingSection title="Host gateway controller"><p className="settings-description">The listener snapshots configuration and trust at activation. Changes take effect after a Burrow restart.</p><div className="field-pair"><Field label="Enabled"><label className="agent-enabled"><input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} /><span>Listen for gateways</span></label></Field><Field label="Bind host"><input value={host} onChange={e => setHost(e.target.value)} /></Field></div><div className="field-pair"><Field label="Port"><input type="number" min="1" max="65535" value={port} onChange={e => setPort(e.target.value)} /></Field><div /></div><div className="setting-actions"><button className="primary" type="button" disabled={Boolean(busy)} onClick={saveController}>{busy === 'controller' ? 'Saving…' : 'Save controller'}</button></div>{controller && <div className={`remote-status ${controller.running ? 'ok' : controller.error ? 'error' : ''}`} role="status"><strong>{controller.running ? 'Listening' : controller.enabled ? 'Not listening' : 'Disabled'}</strong><span>Active listener: {controller.host}:{controller.port}{controller.error ? ` · ${controller.error}` : ''}</span>{pendingController && <span className="remote-pending-config">Saved configuration: {pendingController.host}:{pendingController.port} · {pendingController.enabled ? 'enabled' : 'disabled'} · restart required to activate</span>}</div>}</SettingSection>
    <SettingSection title="Controller TLS"><p className="settings-description">Secrets are sent once and never displayed after saving. Listener readiness is evaluated from the active process.</p>{tls && <div className={`tls-summary ${tls.ready ? 'ok' : tls.configured ? 'warning' : ''}`} role="status"><strong>{tls.ready ? 'TLS ready' : tls.configured ? 'TLS configured; restart required' : 'TLS not configured'}</strong><span>Key {tls.keyConfigured ? 'configured' : 'missing'} · certificate {tls.certConfigured ? 'configured' : 'missing'} · CA {tls.caConfigured ? 'configured' : 'not configured'}</span></div>}<Field label="Private key"><textarea value={tlsKey} onChange={e => setTlsKey(e.target.value)} rows={3} placeholder="Paste PEM key to set or replace" /></Field><Field label="Certificate"><textarea value={tlsCert} onChange={e => setTlsCert(e.target.value)} rows={3} placeholder="Paste PEM certificate to set or replace" /></Field><Field label="CA certificate (optional)"><textarea value={tlsCa} onChange={e => setTlsCa(e.target.value)} rows={2} placeholder="Optional trust chain" /></Field><div className="setting-actions"><button className="secondary" type="button" disabled={Boolean(busy)} onClick={clearTls}>Clear TLS</button><button className="primary" type="button" disabled={Boolean(busy)} onClick={saveTls}>{busy === 'tls' ? 'Saving…' : 'Save TLS'}</button></div></SettingSection>
    </>}{section === 'pairings' && <SettingSection title="Pending Node Goblin pairings"><p className="settings-description">Review these requests before a new node can execute operations. Compare the exact code with the node, then intentionally approve or reject it. Public-key and transport internals stay hidden.</p>{pairings.length === 0 ? <p className="settings-empty">No pending pairing requests.</p> : <div className="remote-pairing-list">{pairings.slice(0, 50).map(pairing => { const id = pairing.gatewayId || pairing.nodeId || pairing.id || 'unknown-node'; const code = pairing.pairingCode || pairing.code || 'Code unavailable'; const metadata = pairing.metadata; return <article className="remote-pairing-card" key={pairing.gatewayId || pairing.nodeId || pairing.id}><div className="remote-pairing-identity"><strong>{metadata?.name || id}</strong><small>Node Goblin · Gateway ID <b>{id}</b>{pairing.controllerId ? ` · Controller ${pairing.controllerId}` : ''}</small>{metadata?.version || metadata?.protocolVersion ? <small>{metadata.version ? `Daemon ${metadata.version}` : ''}{metadata.version && metadata.protocolVersion ? ' · ' : ''}{metadata.protocolVersion ? `Protocol ${metadata.protocolVersion}` : ''}</small> : null}<small>Requested {formatTime(pairing.requestedAt)}{pairing.expiresAt ? ` · Expires ${formatTime(pairing.expiresAt)}` : ''}</small></div><div className="remote-pairing-code" aria-label={`Pairing code ${code}`}>{code}</div><div className="remote-pairing-actions"><button className="danger" type="button" disabled={Boolean(busy)} onClick={() => pairingAction(pairing, 'reject')}>Reject</button><button className="primary" type="button" disabled={Boolean(busy) || !pairing.gatewayId && !pairing.nodeId} onClick={() => pairingAction(pairing, 'approve')}>Approve & enable execution</button></div></article>; })}</div>}</SettingSection>}
    {section === 'gateways' && <SettingSection title="Configured gateways"><p className="settings-description">Configured trust and live connections are separate. Disconnected gateways remain visible so their assignment and health are not lost.</p>{trust.length === 0 ? <p className="settings-empty">No gateways enrolled yet.</p> : <div className="remote-gateway-list">{trust.map(item => { const connection = gateways.find(g => g.gatewayId === item.gatewayId); const state = trustState(item, connection); return <article className={`remote-gateway-card ${state.revoked ? 'revoked' : state.connected ? 'connected' : ''}`} key={item.gatewayId}><div><strong>{item.gatewayId}</strong><small>{item.controllerId} · {state.label} · {state.connected ? `Connected · ${connection?.status || 'authenticated'}` : 'Disconnected'}</small>{connection && <><small>{connection.name || 'Gateway daemon'}{connection.version ? ` · v${connection.version}` : ''}{connection.protocolVersion ? ` · protocol ${connection.protocolVersion}` : ''}</small><small>Connected {formatTime(connection.connectedAt)} · Last seen {formatTime(connection.lastSeenAt)}</small><small>{connection.activeOperations?.length ?? 0} active operation{connection.activeOperations?.length === 1 ? '' : 's'}</small></>}</div><button className="danger" type="button" onClick={() => revoke(item.gatewayId)} disabled={Boolean(busy) || state.revoked}>Revoke</button></article>; })}</div>}<div className="field-pair"><Field label="Gateway ID"><input value={gatewayId} onChange={e => setGatewayId(e.target.value)} placeholder="host-123" /></Field><Field label="Controller ID"><input value={controllerId} onChange={e => setControllerId(e.target.value)} /></Field></div><Field label="Enrollment / rotation secret"><input type="password" value={secret} onChange={e => setSecret(e.target.value)} placeholder="One-time secret input" /></Field><div className="setting-actions"><button className="primary" type="button" disabled={Boolean(busy)} onClick={saveGateway}>{busy === 'gateway' ? 'Saving…' : 'Enroll or rotate gateway'}</button></div></SettingSection>}
    {section === 'assignments' && <SettingSection title="Agent execution environments"><p className="settings-description">Controller-owned assignment for future turns. The model cannot switch hosts mid-turn.</p>{agents.length === 0 ? <p className="settings-empty">No agents configured.</p> : agents.map(agent => <AgentEnvironment key={agent.id} agent={agent} gateways={trust.filter(item => item.approved ?? item.trusted ?? false)} onSaved={onAgentsChanged} onError={setError} />)}</SettingSection>}
    {section === 'operations' && <SettingSection title="Gateway operation activity"><p className="settings-description">Newest-first, bounded controller activity. Prompts, request parameters, protected values, and command output are intentionally omitted.</p>{operations.length === 0 ? <p className="settings-empty">No gateway operations recorded.</p> : <div className="remote-operation-list">{operations.map(operation => <article className="remote-operation-card" key={`${operation.gatewayId}:${operation.operationId}`}><div className="remote-operation-heading"><strong>{operation.kind}</strong><span className={`operation-state operation-${operation.state}`}>{operation.state}</span></div><small>Gateway <b>{operation.gatewayId}</b> · Operation <code>{operation.operationId}</code></small><small>Started {formatTime(operation.startedAt)} · Ended {formatTime(operation.endedAt)} · Duration {formatDuration(operation.durationMs)}</small><small>{operation.terminalOutcome ? `Outcome: ${operation.terminalOutcome}` : operation.reconnectRequired ? 'Reconnect required' : operation.replay ? 'Replayed from gateway journal' : 'Controller dispatch tracked'}</small></article>)}</div>}</SettingSection>}
    {notice && <p className="settings-success" role="status">{notice}</p>}{error && <p className="settings-request-error" role="alert">{error}</p>}
  </div>;
}

function AgentEnvironment({ agent, gateways, onSaved, onError }: { agent: Agent; gateways: Trust[]; onSaved: () => Promise<void>; onError: (error: string) => void }) {
  const current = agent.executionEnvironment; const [kind, setKind] = useState<'local' | 'gateway'>(current?.kind === 'gateway' ? 'gateway' : 'local'); const [hostId, setHostId] = useState(current?.kind === 'gateway' ? current.hostId : ''); const [workspaceRoot, setWorkspaceRoot] = useState(current?.workspaceRoot ?? ''); const [saving, setSaving] = useState(false);
  useEffect(() => { setKind(current?.kind === 'gateway' ? 'gateway' : 'local'); setHostId(current?.kind === 'gateway' ? current.hostId : ''); setWorkspaceRoot(current?.workspaceRoot ?? ''); }, [agent.executionEnvironment]);
  const save = async () => { if (!workspaceRoot.trim() || (kind === 'gateway' && !hostId)) { onError('Execution environment needs an absolute workspace root and gateway.'); return; } setSaving(true); onError(''); try { await api(`/api/agents/${encodeURIComponent(agent.id)}`, { method: 'PATCH', headers, body: JSON.stringify({ executionEnvironment: { kind, workspaceRoot: workspaceRoot.trim(), ...(kind === 'gateway' ? { hostId } : {}) } }) }); await onSaved(); } catch (cause) { onError(message(cause, 'Could not save execution environment')); } finally { setSaving(false); } };
  return <div className="agent-environment"><strong>{agent.name}</strong><div className="field-pair"><Field label="Runs on"><select value={kind} onChange={e => setKind(e.target.value as 'local' | 'gateway')}><option value="local">Local controller</option><option value="gateway">Configured gateway</option></select></Field>{kind === 'gateway' ? <Field label="Gateway"><select value={hostId} onChange={e => setHostId(e.target.value)}><option value="">Choose gateway</option>{gateways.map(g => <option key={g.gatewayId} value={g.gatewayId}>{g.gatewayId}</option>)}</select></Field> : <div />}</div><Field label="Default workspace root"><input value={workspaceRoot} onChange={e => setWorkspaceRoot(e.target.value)} placeholder="/srv/burrow/agent" /></Field><button className="secondary" type="button" disabled={saving} onClick={() => void save()}>{saving ? 'Saving…' : 'Save assignment'}</button></div>;
}
