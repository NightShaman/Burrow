import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../../app/api';
import { useConfirm } from '../../app/ConfirmDialog';
import { Field, SettingSection } from './SettingsPrimitives';
import './apiTokensSettings.css';

type ApiTokenMetadata = { id: string; name: string; scopes: string[]; createdAt?: string | null; expiresAt?: string | null; lastUsedAt?: string | null; revokedAt?: string | null };
type ApiTokensResponse = { ok: boolean; supportedScopes: string[]; tokens: ApiTokenMetadata[] };
type CreatedTokenResponse = { ok: boolean; token: ApiTokenMetadata & { token: string } };

function formatDate(value?: string | null) {
  if (!value) return 'Never';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Unknown' : date.toLocaleString();
}

export function ApiTokensSettings({ overflowTarget }: { overflowTarget?: HTMLElement | null } = {}) {
  const confirm = useConfirm();
  const [tokens, setTokens] = useState<ApiTokenMetadata[]>([]);
  const [supportedScopes, setSupportedScopes] = useState<string[]>([]);
  const [name, setName] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [revealed, setRevealed] = useState<{ id: string; value: string } | null>(null);
  const [busy, setBusy] = useState<'idle' | 'loading' | 'creating' | 'revoking'>('loading');
  const [error, setError] = useState('');
  const load = async () => {
    setBusy('loading'); setError('');
    try { const result = await api<ApiTokensResponse>('/api/settings/api-tokens'); setTokens(result.tokens ?? []); setSupportedScopes(result.supportedScopes ?? []); }
    catch (cause) { setError(cause instanceof Error ? `Could not load API tokens: ${cause.message}` : 'Could not load API tokens.'); }
    finally { setBusy('idle'); }
  };
  useEffect(() => { void load(); }, []);
  const create = async () => {
    if (!name.trim() || !supportedScopes.includes('diagnostics:read')) return;
    setBusy('creating'); setError(''); setRevealed(null);
    try {
      const result = await api<CreatedTokenResponse>('/api/settings/api-tokens', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: name.trim(), scopes: ['diagnostics:read'], ...(expiresAt ? { expiresAt: new Date(`${expiresAt}T23:59:59`).toISOString() } : {}) }) });
      setTokens(items => [result.token, ...items]); setRevealed({ id: result.token.id, value: result.token.token }); setName(''); setExpiresAt('');
    } catch (cause) { setError(cause instanceof Error ? `Could not create API token: ${cause.message}` : 'Could not create API token.'); }
    finally { setBusy('idle'); }
  };
  const revoke = async (token: ApiTokenMetadata) => {
    if (token.revokedAt || !await confirm({ title: 'Revoke API token?', message: `Revoke ${token.name}? Any clients using it will stop working.`, confirmLabel: 'Revoke token', tone: 'danger' })) return;
    setBusy('revoking'); setError('');
    try { await api(`/api/settings/api-tokens/${encodeURIComponent(token.id)}`, { method: 'DELETE' }); setTokens(items => items.map(item => item.id === token.id ? { ...item, revokedAt: new Date().toISOString() } : item)); if (revealed?.id === token.id) setRevealed(null); }
    catch (cause) { setError(cause instanceof Error ? `Could not revoke API token: ${cause.message}` : 'Could not revoke API token.'); }
    finally { setBusy('idle'); }
  };
  const copy = async () => { if (!revealed) return; try { await navigator.clipboard.writeText(revealed.value); } catch { setError('Could not copy token. Copy it manually from the field.'); } };
  const contents = <SettingSection title="API tokens"><p className="settings-description">Create Core API tokens for trusted integrations. Plaintext is shown only once and is never saved by Burrow UI.</p>
    <div className="field-pair api-token-create-fields"><Field label="Token name"><input value={name} onChange={event => setName(event.target.value)} placeholder="Diagnostics dashboard" /></Field><Field label="Expires (optional)"><input type="date" value={expiresAt} onChange={event => setExpiresAt(event.target.value)} /></Field></div>
    <p className="settings-description api-token-scope">Scope: <code>diagnostics:read</code></p>
    <div className="model-actions"><button className="primary" type="button" onClick={() => void create()} disabled={busy !== 'idle' || !name.trim() || !supportedScopes.includes('diagnostics:read')}>{busy === 'creating' ? 'Creating…' : 'Create API token'}</button></div>
    {revealed && <div className="api-token-reveal" role="status"><strong>Copy this token now</strong><span>For your security, the plaintext will not be shown again. Store it in your secret manager, not browser storage.</span><div className="api-token-reveal-row"><input readOnly value={revealed.value} aria-label="New API token plaintext"/><button className="secondary" type="button" onClick={() => void copy()}>Copy</button></div></div>}
    {error && <p className="settings-request-error" role="alert">{error}</p>}
    <div className="api-token-list" aria-live="polite">{tokens.length === 0 ? <p className="settings-empty">No API tokens created yet.</p> : tokens.map(token => <article className={`api-token-row${token.revokedAt ? ' revoked' : ''}`} key={token.id}><div className="api-token-details"><strong>{token.name}</strong><small>{token.scopes.join(', ') || 'No scopes'} · Created {formatDate(token.createdAt)}</small><small>Expires {formatDate(token.expiresAt)} · Last used {formatDate(token.lastUsedAt)}</small></div><div className="api-token-actions">{token.revokedAt ? <span className="api-token-status">Revoked {formatDate(token.revokedAt)}</span> : <button className="danger" type="button" disabled={busy !== 'idle'} onClick={() => void revoke(token)}>Revoke</button>}</div></article>)}</div>
  </SettingSection>;
  return overflowTarget ? createPortal(contents, overflowTarget) : contents;
}

export { formatDate };
export type { ApiTokenMetadata };
