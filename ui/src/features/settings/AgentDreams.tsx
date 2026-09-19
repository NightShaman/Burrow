import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { SavedProvider } from '../../app/types';
import { apiForTarget } from '../../app/api';
import { targetForResource, type ApiTarget } from '../../app/apiTargets';
import { Field, SettingSection } from './SettingsPrimitives';

type DreamModel = { modelConnectionId?: string | null; model?: string | null };
type DreamSettings = { enabled: boolean; cron: string; timezone: string; prompt: string } & DreamModel;
type DreamSettingsResponse = { settings: DreamSettings; effectiveModel?: DreamModel | null; modelResolutionError?: string | null };
type DreamCycleReceipt = {
  runId: string;
  status?: 'running' | 'completed' | 'partial' | 'failed' | 'interrupted' | string | null;
  error?: string | null;
  trigger?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
};
type DreamCycleResponse = { receipts: DreamCycleReceipt[] };
function dreamModelValue(connectionId: string, model: string) { return JSON.stringify([connectionId, model]); }
function settingsModelValue(settings: DreamModel) { return settings.modelConnectionId && settings.model ? dreamModelValue(settings.modelConnectionId, settings.model) : ''; }
function dreamModelFromValue(value: string) {
  if (!value) return { modelConnectionId: null, model: null };
  try {
    const [modelConnectionId, model] = JSON.parse(value) as [string, string];
    return modelConnectionId && model ? { modelConnectionId, model } : { modelConnectionId: null, model: null };
  } catch { return { modelConnectionId: null, model: null }; }
}

function modelLabel(model: DreamModel, options: { value: string; label: string }[]) {
  const value = settingsModelValue(model);
  const selected = options.find((option) => option.value === value);
  if (selected) return selected.label;
  return model.modelConnectionId && model.model ? `Unavailable model · ${model.modelConnectionId} · ${model.model}` : 'Use agent chat model';
}

function DreamModelSelect({ value, model, options, onChange, disabled }: { value: string; model: DreamModel; options: { value: string; label: string }[]; onChange: (value: string) => void; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const selected = options.find((option) => option.value === value);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);

  return <div className="dream-model-select" ref={menuRef}>
    <button type="button" className="dream-model-trigger" aria-haspopup="listbox" aria-expanded={open} aria-label="Dream model" disabled={disabled} onClick={() => setOpen((current) => !current)}>
      <span>{selected?.label ?? modelLabel(model, options)}</span><span className="dream-phase-chevron" aria-hidden="true">⌄</span>
    </button>
    {open && <div className="dream-model-menu" role="listbox" aria-label="Dream model">
      {options.map((option) => <button type="button" role="option" aria-selected={option.value === value} className={option.value === value ? 'selected' : ''} key={option.value} onClick={() => { onChange(option.value); setOpen(false); }}>{option.label}</button>)}
    </div>}
  </div>;
}

export function AgentDreams({ agentId, targets, savedProviders, overflowTarget }: { agentId: string; targets: ApiTarget[]; savedProviders: SavedProvider[]; overflowTarget?: HTMLElement | null }) {
  const owner = targetForResource(targets, agentId);
  const request = <T,>(path: string, init?: RequestInit) => apiForTarget<T>(owner.target, path, init);
  const dreamModels = savedProviders.flatMap((provider) => provider.models.map((model) => ({ connectionId: provider.id, model, label: `${provider.provider} · ${provider.modelLabels?.[model] ?? model}` })));
  const [settings, setSettings] = useState<DreamSettings>({ enabled: false, cron: '0 4 * * *', timezone: 'UTC', prompt: '', modelConnectionId: null, model: null });
  const selectedDreamModel = settingsModelValue(settings);
  const [state, setState] = useState<'loading' | 'idle' | 'saving'>('loading');
  const [error, setError] = useState('');
  const [effectiveModel, setEffectiveModel] = useState<DreamModel | null>(null);
  const [modelResolutionError, setModelResolutionError] = useState<string | null>(null);
  const [receipts, setReceipts] = useState<DreamCycleReceipt[]>([]);
  const [receiptError, setReceiptError] = useState('');
  const requestVersion = useRef(0);

  useEffect(() => {
    const version = ++requestVersion.current;
    const controller = new AbortController();
    setState('loading'); setError(''); setReceiptError(''); setReceipts([]);
    Promise.all([
      request<DreamSettingsResponse>(`/api/agents/${encodeURIComponent(owner.resourceId)}/dream-settings`, { signal: controller.signal }),
      request<DreamCycleResponse>(`/api/agents/${encodeURIComponent(owner.resourceId)}/dream-cycle?limit=5`, { signal: controller.signal }).catch((cause) => {
        if (!controller.signal.aborted && version === requestVersion.current) setReceiptError(cause instanceof Error ? `Could not load recent dream activity: ${cause.message}` : 'Could not load recent dream activity.');
        return { receipts: [] };
      }),
    ]).then(([dreamSettings, dreamCycles]) => {
      if (controller.signal.aborted || version !== requestVersion.current) return;
      setSettings(dreamSettings.settings);
      setEffectiveModel(dreamSettings.effectiveModel ?? null);
      setModelResolutionError(dreamSettings.modelResolutionError ?? null);
      setReceipts(Array.isArray(dreamCycles.receipts) ? dreamCycles.receipts : []);
      setState('idle');
    }).catch(cause => {
      if (controller.signal.aborted || version !== requestVersion.current) return;
      setError(cause instanceof Error ? `Could not load dream settings: ${cause.message}` : 'Could not load dream settings.');
      setState('idle');
    });
    return () => controller.abort();
  }, [owner.target.id, owner.resourceId]);
  const save = async () => {
    const version = requestVersion.current;
    setState('saving'); setError('');
    try {
      const result = await request<DreamSettingsResponse>(`/api/agents/${encodeURIComponent(owner.resourceId)}/dream-settings`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(settings) });
      if (version !== requestVersion.current) return;
      setSettings(result.settings);
      setEffectiveModel(result.effectiveModel ?? null);
      setModelResolutionError(result.modelResolutionError ?? null);
    } catch (cause) {
      if (version !== requestVersion.current) return;
      setError(cause instanceof Error ? `Could not save dream settings: ${cause.message}` : 'Could not save dream settings.');
    } finally {
      if (version === requestVersion.current) setState('idle');
    }
  };
  const disabled = state !== 'idle';
  const activity = <div className="dream-cycle-activity" aria-label="Recent dream activity">
      {!overflowTarget && <h3>Recent activity</h3>}
      {receipts.length ? <div className="dream-cycle-list">
        {receipts.map((receipt) => {
          const at = receipt.completedAt || receipt.startedAt;
          const status = typeof receipt.status === 'string' && receipt.status.trim() ? receipt.status.trim().toLowerCase() : 'unknown';
          const label = status === 'running' ? 'Running' : status === 'interrupted' ? 'Interrupted' : status.charAt(0).toUpperCase() + status.slice(1);
          return <div className={`dream-cycle-receipt dream-cycle-${status}`} key={receipt.runId}>
            <div className="dream-cycle-receipt-heading"><strong>{label}</strong>{at && <time dateTime={at}>{new Date(at).toLocaleString()}</time>}</div>
            {receipt.error && <p role={status === 'interrupted' || status === 'failed' ? 'alert' : undefined}>{receipt.error}</p>}
          </div>;
        })}
      </div> : <p className="settings-description">No dream activity recorded yet.</p>}
      {receiptError && <p className="settings-request-error" role="alert">{receiptError}</p>}
    </div>;
  return <><SettingSection title="Dreams">
    <p className="settings-description">Configure scheduled dreaming for this agent.</p>
    <div className="dream-settings-fields">
      <label className="agent-enabled"><input type="checkbox" checked={settings.enabled} disabled={disabled} onChange={(event) => setSettings({ ...settings, enabled: event.target.checked })} /><span>Enable scheduled dreaming</span></label>
      <div className="dream-schedule-fields"><Field label="Cron"><input value={settings.cron} disabled={disabled} onChange={(event) => setSettings({ ...settings, cron: event.target.value })} /></Field><Field label="Timezone"><input value={settings.timezone} disabled={disabled} onChange={(event) => setSettings({ ...settings, timezone: event.target.value })} /></Field><Field label="Model"><DreamModelSelect value={selectedDreamModel} model={settings} options={[{ value: '', label: 'Use agent chat model' }, ...dreamModels.map((option) => ({ value: dreamModelValue(option.connectionId, option.model), label: option.label }))]} onChange={(value) => setSettings({ ...settings, ...dreamModelFromValue(value) })} disabled={disabled} /></Field></div>
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

