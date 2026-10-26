import { useEffect, useRef, useState } from 'react';
import { api, jsonMutation } from '../../app/api';
import { useUnsavedChanges } from '../../app/UnsavedChanges';
import { Field, SettingSection } from './SettingsPrimitives';

export type ReceiverSettings = {
  deliveryUrl: string; webhookPath: string; secretConfigured: boolean; storedSecretConfigured: boolean;
  secretSource: 'settings' | 'environment' | 'none'; environmentOverride: boolean;
  ready: boolean; readiness: 'ready' | 'secret_missing' | 'secret_unavailable';
};
type Response = { ok: boolean; settings: ReceiverSettings };
const message = (cause: unknown) => cause instanceof Error ? cause.message : 'Request failed.';

export function WorkflowReceiverSettings() {
  const [settings, setSettings] = useState<ReceiverSettings | null>(null);
  const [deliveryUrl, setDeliveryUrl] = useState('');
  const [secret, setSecret] = useState('');
  const [clearSecret, setClearSecret] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const lifetime = useRef(new AbortController());
  const lock = useRef(false);
  const load = async () => {
    const { signal } = lifetime.current;
    setLoading(true); setError('');
    try {
      const result = await api<Response>('/api/events/settings', { signal });
      if (!result.ok || !result.settings) throw new Error('Invalid receiver response.');
      if (!signal.aborted) { setSettings(result.settings); setDeliveryUrl(result.settings.deliveryUrl); }
    } catch (cause) { if (!signal.aborted) setError(`Could not load receiver: ${message(cause)}`); }
    finally { if (!signal.aborted) setLoading(false); }
  };
  useEffect(() => {
    lifetime.current = new AbortController(); void load();
    return () => lifetime.current.abort();
  }, []);
  const discard = () => { setDeliveryUrl(settings?.deliveryUrl ?? ''); setSecret(''); setClearSecret(false); setError(''); };
  const save = async (): Promise<boolean> => {
    if (lock.current || !settings || loading) return false;
    const url = deliveryUrl.trim();
    if (url) {
      try {
        const parsed = new URL(url);
        if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password || url.includes('?') || url.includes('#') || parsed.pathname !== settings.webhookPath) throw new Error();
      } catch { setError(`Use an absolute HTTP(S) delivery URL ending in ${settings.webhookPath}, without credentials, query, or fragment.`); return false; }
    }
    lock.current = true; setBusy(true); setError(''); setNotice('');
    try {
      const result = await api<Response>('/api/events/settings', jsonMutation('POST', {
        deliveryUrl: url, ...(clearSecret ? { clearSecret: true } : secret.trim() ? { secret } : {}),
      }));
      if (!result.ok || !result.settings) throw new Error('Receiver was not saved.');
      if (lifetime.current.signal.aborted) return false;
      setSettings(result.settings); setDeliveryUrl(result.settings.deliveryUrl); setSecret(''); setClearSecret(false);
      setNotice('Receiver saved. Settings apply without a restart.'); return true;
    } catch (cause) { if (!lifetime.current.signal.aborted) setError(`Could not save receiver: ${message(cause)}`); return false; }
    finally { lock.current = false; if (!lifetime.current.signal.aborted) setBusy(false); }
  };
  const dirty = Boolean(settings && (deliveryUrl !== settings.deliveryUrl || secret || clearSecret));
  useUnsavedChanges({ dirty, busy, save, discard });
  return <SettingSection title="Webhook receiver · global">
    <p className="settings-description">Shared by all agents’ workflow watches.</p>
    {loading ? <p role="status">Loading receiver…</p> : settings ? <>
      <div className="workflow-event-status">
        <span>Secret: <b>{settings.secretConfigured ? 'Configured' : 'Not configured'}</b></span>
        <span>Source: <b>{settings.secretSource === 'environment' ? 'Environment override' : settings.secretSource === 'settings' ? 'Settings' : 'None'}</b></span>
        <span>Signature verification: <b>{settings.ready ? 'Ready' : settings.readiness === 'secret_unavailable' ? 'Stored secret unavailable' : 'Secret missing'}</b></span>
      </div>
      {settings.environmentOverride && <p className="settings-description">BURROW_GITHUB_WEBHOOK_SECRET overrides the stored secret. Changes here affect the stored secret only; changing the environment requires a process restart.</p>}
      {settings.readiness === 'secret_unavailable' && <p className="settings-request-error" role="alert">The stored secret cannot be decrypted. Replace it or check the server credential key.</p>}
      <div className="schedule-form">
        <Field label="Delivery URL"><input type="url" value={deliveryUrl} onChange={event => { setDeliveryUrl(event.target.value); setNotice(''); }} placeholder={`https://your-host${settings.webhookPath}`} disabled={busy} /><small className="field-hint">Optional record of the GitHub delivery URL. Does not configure ingress or test connectivity.</small></Field>
        <Field label="Webhook secret"><input type="password" autoComplete="new-password" value={secret} onChange={event => { setSecret(event.target.value); setNotice(''); }} disabled={busy || clearSecret} placeholder="Leave blank to preserve" /><small className="field-hint">Write-only. Use the same secret in GitHub; blank preserves the stored value.</small></Field>
        {settings.storedSecretConfigured && <label className="schedule-enabled"><input type="checkbox" checked={clearSecret} onChange={event => { setClearSecret(event.target.checked); setSecret(''); setNotice(''); }} disabled={busy} /><span>Clear stored secret on save</span></label>}
        {clearSecret && <p className="settings-description">{settings.environmentOverride ? 'The environment override will remain active.' : 'Incoming webhook deliveries will be rejected until a secret is configured.'}</p>}
        <div className="setting-actions"><button type="button" className="secondary" onClick={discard} disabled={busy || !dirty}>Discard receiver changes</button><button type="button" className="primary" onClick={() => void save()} disabled={busy || !dirty}>{busy ? 'Saving…' : 'Save receiver'}</button></div>
      </div>
      <small className="field-hint">Readiness covers local signature verification only, not GitHub connectivity or agent handling.</small>
    </> : null}
    {error && <p className="settings-request-error" role="alert">{error} {!settings && !loading && <button type="button" onClick={() => void load()}>Retry receiver</button>}</p>}
    {notice && <p role="status">{notice}</p>}
  </SettingSection>;
}
