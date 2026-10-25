import { useUnsavedChanges } from '../../app/UnsavedChanges';
import { ProviderModelFields } from './ProviderModelFields';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { SavedProvider } from '../../app/types';
import { api } from '../../app/api';
import { Field, SettingSection } from './SettingsPrimitives';

type DreamModel = { modelConnectionId?: string | null; model?: string | null };
type DreamSettings = { enabled: boolean; quietDayDreams: boolean; promoteToMemory: boolean; cron: string; timezone: string | null; effectiveTimezone?: string; prompt: string } & DreamModel;
type DreamSettingsResponse = { settings: DreamSettings; effectiveModel?: DreamModel | null; modelResolutionError?: string | null };
type DreamCycleReceipt = {
  runId: string;
  status?: 'running' | 'completed' | 'partial' | 'failed' | 'interrupted' | string | null;
  error?: string | null;
  phases?: { phase?: string; extractionError?: string | null; diaryError?: string | null; modelResponses?: { ok?: boolean; provider?: string | null; model?: string | null; status?: string | number | null; error?: string | null }[] }[];
  trigger?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
};
type DreamCycleResponse = { receipts: DreamCycleReceipt[] };
function dreamModelValue(connectionId: string, model: string) { return JSON.stringify([connectionId, model]); }
function settingsModelValue(settings: DreamModel) { return settings.modelConnectionId && settings.model ? dreamModelValue(settings.modelConnectionId, settings.model) : ''; }
function modelLabel(model: DreamModel, options: { value: string; label: string }[]) {
  const value = settingsModelValue(model);
  const selected = options.find((option) => option.value === value);
  if (selected) return selected.label;
  return model.modelConnectionId && model.model ? `Unavailable model · ${model.modelConnectionId} · ${model.model}` : 'Use agent chat model';
}

export function AgentDreams({ agentId, savedProviders, overflowTarget }: { agentId: string; savedProviders: SavedProvider[]; overflowTarget?: HTMLElement | null }) {
  const resourceId = agentId.includes('::') ? agentId.slice(agentId.indexOf('::') + 2) : agentId;
  const request = <T,>(path: string, init?: RequestInit) => api<T>(path, init);
  const dreamModels = savedProviders.flatMap((provider) => provider.models.map((model) => ({ connectionId: provider.id, model, label: `${provider.provider} · ${provider.modelLabels?.[model] ?? model}` })));
  const [settings, setSettings] = useState<DreamSettings>({ enabled: false, quietDayDreams: true, promoteToMemory: true, cron: '0 4 * * *', timezone: null, prompt: '', modelConnectionId: null, model: null });
  const [baseline, setBaseline] = useState('');
  const [state, setState] = useState<'loading' | 'idle' | 'saving' | 'error'>('loading');
  const [retry, setRetry] = useState(0);
  const [error, setError] = useState('');
  const [effectiveModel, setEffectiveModel] = useState<DreamModel | null>(null);
  const [modelResolutionError, setModelResolutionError] = useState<string | null>(null);
  const [receipts, setReceipts] = useState<DreamCycleReceipt[]>([]);
  const [receiptError, setReceiptError] = useState('');
  const requestVersion = useRef(0);

  useEffect(() => {
    const version = ++requestVersion.current;
    const controller = new AbortController();
    setState('loading'); setError(''); setSettings({ enabled: false, quietDayDreams: true, promoteToMemory: true, cron: '0 4 * * *', timezone: null, prompt: '', modelConnectionId: null, model: null }); setEffectiveModel(null); setModelResolutionError(null); setReceiptError(''); setReceipts([]);
    Promise.all([
      request<DreamSettingsResponse>(`/api/agents/${encodeURIComponent(resourceId)}/dream-settings`, { signal: controller.signal }),
      request<DreamCycleResponse>(`/api/agents/${encodeURIComponent(resourceId)}/dream-cycle?limit=5`, { signal: controller.signal }).catch((cause) => {
        if (!controller.signal.aborted && version === requestVersion.current) setReceiptError(cause instanceof Error ? `Could not load recent dream activity: ${cause.message}` : 'Could not load recent dream activity.');
        return { receipts: [] };
      }),
    ]).then(([dreamSettings, dreamCycles]) => {
      if (controller.signal.aborted || version !== requestVersion.current) return;
      setSettings({ ...dreamSettings.settings, quietDayDreams: dreamSettings.settings.quietDayDreams ?? true, promoteToMemory: dreamSettings.settings.promoteToMemory ?? true });
      setBaseline(JSON.stringify([dreamSettings.settings.enabled, dreamSettings.settings.quietDayDreams ?? true, dreamSettings.settings.promoteToMemory ?? true, dreamSettings.settings.cron, dreamSettings.settings.prompt, dreamSettings.settings.modelConnectionId ?? null, dreamSettings.settings.model ?? null]));
      setEffectiveModel(dreamSettings.effectiveModel ?? null);
      setModelResolutionError(dreamSettings.modelResolutionError ?? null);
      setReceipts(Array.isArray(dreamCycles.receipts) ? dreamCycles.receipts : []);
      setState('idle');
    }).catch(cause => {
      if (controller.signal.aborted || version !== requestVersion.current) return;
      setError(cause instanceof Error ? `Could not load dream settings: ${cause.message}` : 'Could not load dream settings.');
      setState('error');
    });
    return () => controller.abort();
  }, [agentId, retry]);
  const save = async () => {
    if (state !== 'idle') return false;
    if (settings.modelConnectionId && !settings.model) { setError('Choose a model for the selected provider or use the agent chat model.'); return false; }
    const version = requestVersion.current;
    setState('saving'); setError('');
    try {
      const result = await request<DreamSettingsResponse>(`/api/agents/${encodeURIComponent(resourceId)}/dream-settings`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: settings.enabled, quietDayDreams: settings.quietDayDreams, promoteToMemory: settings.promoteToMemory, cron: settings.cron, prompt: settings.prompt, modelConnectionId: settings.modelConnectionId ?? null, model: settings.model ?? null }) });
      if (version !== requestVersion.current) return false;
      setBaseline(JSON.stringify([result.settings.enabled, result.settings.quietDayDreams ?? true, result.settings.promoteToMemory ?? true, result.settings.cron, result.settings.prompt, result.settings.modelConnectionId ?? null, result.settings.model ?? null]));
      setSettings({ ...result.settings, quietDayDreams: result.settings.quietDayDreams ?? true, promoteToMemory: result.settings.promoteToMemory ?? true });
      setEffectiveModel(result.effectiveModel ?? null);
      setModelResolutionError(result.modelResolutionError ?? null);
      return true;
    } catch (cause) {
      if (version !== requestVersion.current) return false;
      setError(cause instanceof Error ? `Could not save dream settings: ${cause.message}` : 'Could not save dream settings.');
    } finally {
      if (version === requestVersion.current) setState('idle');
    }
    return false;
  };
  useUnsavedChanges({ dirty: state !== 'loading' && state !== 'error' && baseline !== '' && JSON.stringify([settings.enabled, settings.quietDayDreams, settings.promoteToMemory, settings.cron, settings.prompt, settings.modelConnectionId ?? null, settings.model ?? null]) !== baseline, busy: state === 'saving', save, discard: () => { const [enabled, quietDayDreams, promoteToMemory, cron, prompt, modelConnectionId, model] = JSON.parse(baseline) as [boolean, boolean, boolean, string, string, string | null, string | null]; setSettings(current => ({ ...current, enabled, quietDayDreams, promoteToMemory, cron, prompt, modelConnectionId, model })); setError(''); } });
  const disabled = state !== 'idle';
  const activity = <div className="dream-cycle-activity" aria-label="Recent dream activity">
      {!overflowTarget && <h3>Recent activity</h3>}
      {receipts.length ? <div className="dream-cycle-list">
        {receipts.map((receipt) => {
          const at = receipt.completedAt || receipt.startedAt;
          const status = typeof receipt.status === 'string' && receipt.status.trim() ? receipt.status.trim().toLowerCase() : 'unknown';
          const label = status === 'running' ? 'Running' : status === 'interrupted' ? 'Interrupted' : status.charAt(0).toUpperCase() + status.slice(1);
          const failures = (receipt.phases ?? []).flatMap((phase) => {
            const responses = (phase.modelResponses ?? []).filter((response) => response.ok === false || response.error);
            const fallback = [...new Set([phase.extractionError, phase.diaryError].filter(Boolean))].join(' · ');
            return responses.length ? responses.map((response) => [phase.phase || 'Unknown phase', response.provider, response.model, response.status != null ? `HTTP ${response.status}` : null, response.error || fallback || 'Model request failed'].filter(Boolean).join(' · ')) : fallback ? [`${phase.phase || 'Unknown phase'} · ${fallback}`] : [];
          });
          return <div className={`dream-cycle-receipt dream-cycle-${status}`} key={receipt.runId}>
            <div className="dream-cycle-receipt-heading"><strong>{label}</strong>{at && <time dateTime={at}>{new Date(at).toLocaleString()}</time>}</div>
            {failures.length > 0 && <ul aria-label="Dream phase failures">{failures.map((failure, index) => <li key={index}>{failure}</li>)}</ul>}
            {receipt.error && !failures.some((failure) => failure.includes(receipt.error!)) && <p role={status === 'interrupted' || status === 'failed' ? 'alert' : undefined}>{receipt.error}</p>}
          </div>;
        })}
      </div> : <p className="settings-description">No dream activity recorded yet.</p>}
      {receiptError && <p className="settings-request-error" role="alert">{receiptError}</p>}
    </div>;
  return <><SettingSection title="Dreams">
    <p className="settings-description">Configure scheduled dreaming for this agent.</p>{state === 'error' && <button type="button" onClick={() => setRetry(value => value + 1)}>Retry loading</button>}
    <div className="dream-settings-fields">
      <label className="agent-enabled"><input type="checkbox" checked={settings.enabled} disabled={disabled} onChange={(event) => setSettings({ ...settings, enabled: event.target.checked })} /><span>Enable scheduled dreaming</span></label>
      <label className="agent-enabled"><input type="checkbox" checked={settings.quietDayDreams} disabled={disabled} aria-describedby="quiet-day-dreams-help" onChange={(event) => setSettings({ ...settings, quietDayDreams: event.target.checked })} /><span>Dream on quiet days</span></label>
      <p id="quiet-day-dreams-help" className="settings-description">When enabled, quiet days generate a diary from retained continuity without re-extraction. When disabled, days with no new material skip model work.</p>
      <label className="agent-enabled"><input type="checkbox" checked={settings.promoteToMemory} disabled={disabled} aria-describedby="agent-dream-promotion-help" onChange={(event) => setSettings({ ...settings, promoteToMemory: event.target.checked })} /><span>Promote Dreams to memory</span></label>
      <p id="agent-dream-promotion-help" className="settings-description">Requires global promotion in Brain memory too. Off keeps Dreams and their archive; existing memories and explicit saves are unchanged. Re-enabling does not catch up skipped promotions.</p>
      <div className="dream-schedule-fields"><div className="skill-compact-field"><Field label="Cron"><input value={settings.cron} disabled={disabled} onChange={(event) => setSettings({ ...settings, cron: event.target.value })} /></Field><small className="field-hint">Uses the operator timezone{settings.effectiveTimezone ? ` (${settings.effectiveTimezone})` : ''}. Follows operator timezone changes.</small></div><ProviderModelFields providers={savedProviders} connectionId={settings.modelConnectionId} model={settings.model} inheritLabel="Use agent chat model" disabled={disabled} onChange={(modelConnectionId, model) => setSettings({ ...settings, modelConnectionId, model })} /></div>
      <p className="settings-description">Effective model: {effectiveModel?.modelConnectionId && effectiveModel.model ? modelLabel(effectiveModel, [{ value: '', label: 'Use agent chat model' }, ...dreamModels.map((option) => ({ value: dreamModelValue(option.connectionId, option.model), label: option.label }))]) : 'Unconfigured'}</p>
      {modelResolutionError && <p className="settings-request-error" role="alert">Model resolution error: {modelResolutionError}</p>}
      <Field label="Dream prompt"><textarea rows={6} value={settings.prompt} disabled={disabled} onChange={(event) => setSettings({ ...settings, prompt: event.target.value })} /></Field>
    </div>
    {!overflowTarget && activity}
    <div className="dream-actions">
      <button className="primary" onClick={() => void save()} disabled={state !== 'idle'}>{state === 'saving' ? 'Saving…' : 'Save dream settings'}</button>
    </div>
    {error && <p className="settings-request-error" role="alert">{error}</p>}
  </SettingSection>{overflowTarget && createPortal(<div className="settings-overflow-content"><SettingSection title="Recent activity">{activity}</SettingSection></div>, overflowTarget)}</>;
}

