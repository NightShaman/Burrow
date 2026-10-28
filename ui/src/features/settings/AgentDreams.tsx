import { useUnsavedChanges } from '../../app/UnsavedChanges';
import { ProviderModelFields } from './ProviderModelFields';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { SavedProvider } from '../../app/types';
import { api } from '../../app/api';
import { Field, SettingSection } from './SettingsPrimitives';

type DreamModel = { modelConnectionId?: string | null; model?: string | null };
type DreamSettings = { enabled: boolean; quietDayDreams: boolean; promoteToMemory: boolean; cron: string; timezone: string | null; effectiveTimezone?: string; prompt: string; memoryEmphasis?: number; memoryPromptOverride?: string | null; defaultMemoryPrompt?: string; effectiveMemoryPrompt?: string } & DreamModel;
type DreamSettingsResponse = { settings: DreamSettings; effectiveModel?: DreamModel | null; modelResolutionError?: string | null };
const normalizeSettings = (settings: DreamSettings): DreamSettings => ({ ...settings, quietDayDreams: settings.quietDayDreams ?? true, promoteToMemory: settings.promoteToMemory ?? true, memoryEmphasis: settings.memoryEmphasis ?? 50, memoryPromptOverride: settings.memoryPromptOverride ?? null });
const editableSettings = (settings: DreamSettings) => ({ enabled: settings.enabled, quietDayDreams: settings.quietDayDreams ?? true, promoteToMemory: settings.promoteToMemory ?? true, cron: settings.cron, prompt: settings.prompt, modelConnectionId: settings.modelConnectionId ?? null, model: settings.model ?? null, memoryEmphasis: settings.memoryEmphasis ?? 50, memoryPromptOverride: settings.memoryPromptOverride ?? null });
const settingsBaseline = (settings: DreamSettings) => JSON.stringify(editableSettings(settings));
type MemoryPreview = { memories: { title: string; content: string; sourceRefs: string[] }[]; sourceToken: string; sourceCount: number; generatedAt: string; evidenceScope: string; persisted: false };
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
  const previewVersion = useRef(0);
  const [preview, setPreview] = useState<MemoryPreview | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewError, setPreviewError] = useState('');
  const [sourceToken, setSourceToken] = useState<string | undefined>();
  const [sourceInvalid, setSourceInvalid] = useState(false);
  const previewInputs = settingsBaseline(settings);
  useEffect(() => {
    ++previewVersion.current;
    setPreview(null); if (!sourceInvalid) setPreviewError(''); setPreviewBusy(false);
  }, [previewInputs]);
  useEffect(() => {
    ++previewVersion.current;
    setPreview(null); setPreviewError(''); setPreviewBusy(false); setSourceToken(undefined); setSourceInvalid(false);
    return () => { ++previewVersion.current; };
  }, [agentId]);
  const generatePreview = async (newSample = false) => {
    if (state !== 'idle' || previewBusy || (sourceInvalid && !newSample)) return;
    const version = ++previewVersion.current;
    setPreviewBusy(true); setPreview(null); setPreviewError('');
    try {
      const result = await request<MemoryPreview>(`/api/agents/${encodeURIComponent(resourceId)}/dream-memory/preview`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ memoryEmphasis: settings.memoryEmphasis ?? 50, memoryPromptOverride: settings.memoryPromptOverride ?? null, ...(!newSample && sourceToken ? { sourceToken } : {}) }),
      });
      if (version !== previewVersion.current) return;
      setPreview(result); setSourceToken(result.sourceToken); setSourceInvalid(false);
    } catch (cause) {
      if (version !== previewVersion.current) return;
      const message = cause instanceof Error ? cause.message : 'Unknown error';
      if (message.includes('dream_memory_preview_source_token_invalid')) {
        setSourceInvalid(true);
        setPreviewError('The source sample expired or changed. Choose Preview new sample to continue; comparisons will use different source material.');
      } else setPreviewError(`Could not preview memories: ${message}`);
    } finally {
      if (version === previewVersion.current) setPreviewBusy(false);
    }
  };

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
      setSettings(normalizeSettings(dreamSettings.settings));
      setBaseline(settingsBaseline(dreamSettings.settings));
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
      const result = await request<DreamSettingsResponse>(`/api/agents/${encodeURIComponent(resourceId)}/dream-settings`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(editableSettings(settings)) });
      if (version !== requestVersion.current) return false;
      setBaseline(settingsBaseline(result.settings));
      setSettings(normalizeSettings(result.settings));
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
  useUnsavedChanges({ dirty: state !== 'loading' && state !== 'error' && baseline !== '' && settingsBaseline(settings) !== baseline, busy: state === 'saving', save, discard: () => { setSettings(current => ({ ...current, ...JSON.parse(baseline) })); setError(''); } });
  const disabled = state !== 'idle';
  const activity = <div className="dream-cycle-activity" aria-label="Recent dream activity">
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
  const memoryControls = <SettingSection title="Dream memory">
      <label className="agent-enabled"><input type="checkbox" checked={settings.promoteToMemory} disabled={disabled} aria-describedby="agent-dream-promotion-help" onChange={(event) => setSettings({ ...settings, promoteToMemory: event.target.checked })} /><span>Promote Dreams to memory</span></label>
      <p id="agent-dream-promotion-help" className="settings-description">Also requires global promotion in Continuity. Turning this off keeps the archive and existing memories; explicit saves still work. Skipped promotions are not caught up later.</p>
      <div className="dream-memory-controls">
        <Field label="Memory emphasis"><span aria-hidden="true" className="field-hint">{settings.memoryEmphasis ?? 50} · {(settings.memoryEmphasis ?? 50) === 50 ? 'Balanced' : (settings.memoryEmphasis ?? 50) < 50 ? 'Analytical' : 'Meaning-focused'}</span><input type="range" min={0} max={100} step={1} aria-describedby="dream-memory-emphasis-help" value={settings.memoryEmphasis ?? 50} disabled={disabled} aria-valuetext={`${settings.memoryEmphasis ?? 50} · ${(settings.memoryEmphasis ?? 50) === 50 ? 'Balanced' : (settings.memoryEmphasis ?? 50) < 50 ? 'Analytical' : 'Meaning-focused'}`} onChange={(event) => setSettings({ ...settings, memoryEmphasis: Number(event.target.value) })} /></Field>
        <div className="dream-emphasis-labels" aria-hidden="true"><span>0 · Analytical</span><span>50 · Balanced</span><span>100 · Meaning-focused</span></div>
        <p id="dream-memory-emphasis-help" className="field-hint">Controls expression, not selection or evidence. SOUL supplies the agent’s voice.</p>
        <div className="dream-memory-heading"><span>{settings.memoryPromptOverride != null ? 'Custom override active' : 'Default prompt'}</span><button type="button" disabled={disabled || settings.memoryPromptOverride == null} onClick={() => setSettings({ ...settings, memoryPromptOverride: null })}>Revert to default</button></div>
        <Field label="Memory prompt override"><textarea maxLength={20000} rows={8} value={settings.memoryPromptOverride ?? settings.defaultMemoryPrompt ?? ''} disabled={disabled} onChange={(event) => setSettings({ ...settings, memoryPromptOverride: event.target.value })} /></Field>
        <div className="dream-memory-preview">
          <p id="dream-memory-preview-help" className="field-hint">Uses recent validated Dream extraction candidates, not full history or existing memories. May make a paid request using the saved Dream model. Nothing is saved.</p>
          <div className="dream-memory-preview-actions">
            <button type="button" disabled={disabled || previewBusy || sourceInvalid} aria-describedby="dream-memory-preview-help" onClick={() => void generatePreview()}>{previewBusy ? 'Generating preview…' : 'Preview memories'}</button>
            {(sourceToken || sourceInvalid) && <button type="button" disabled={disabled || previewBusy} onClick={() => void generatePreview(true)}>Preview new sample</button>}
          </div>
          {sourceToken && !sourceInvalid && <p className="field-hint">Comparisons reuse the same source sample for up to 15 minutes, unless sources change. Model output may vary.</p>}
          {previewBusy && <p role="status" className="field-hint">Generating a no-save preview…</p>}
          {previewError && <p className="settings-request-error" role="alert">{previewError}</p>}
          {preview && <div aria-label="Memory preview results" role="region">
            <p className="field-hint">{preview.sourceCount} source messages · {preview.memories.length} memories · Not saved</p>
            <p className="field-hint">{preview.evidenceScope}</p>
            {preview.memories.length ? preview.memories.map((memory, index) => <article className="dream-entry" key={index}><h4>{memory.title}</h4><p className="dream-memory-content">{memory.content}</p><ul aria-label="Source references">{memory.sourceRefs.map((ref, refIndex) => <li key={refIndex}>{ref}</li>)}</ul></article>) : <p className="settings-description">{preview.sourceCount === 0 ? 'No eligible extracted source material is available. No model request was made.' : 'No memories were produced from this sample.'}</p>}
          </div>}
        </div>
      </div>
  </SettingSection>;
  return <><SettingSection title="Dreams">
    {state === 'error' && <button type="button" onClick={() => setRetry(value => value + 1)}>Retry loading</button>}
    <div className="dream-settings-fields">
      <div className="dream-toggle-group"><div className="dream-scheduled-controls"><label className="agent-enabled"><input type="checkbox" checked={settings.enabled} disabled={disabled} onChange={(event) => setSettings({ ...settings, enabled: event.target.checked })} /><span>Enable scheduled dreaming</span></label><div className="skill-compact-field"><Field label="Cron"><input value={settings.cron} disabled={disabled} onChange={(event) => setSettings({ ...settings, cron: event.target.value })} /></Field><small className="field-hint">Operator timezone{settings.effectiveTimezone ? `: ${settings.effectiveTimezone}` : ''}.</small></div></div>
      <div><label className="agent-enabled"><input type="checkbox" checked={settings.quietDayDreams} disabled={disabled} aria-describedby="quiet-day-dreams-help" onChange={(event) => setSettings({ ...settings, quietDayDreams: event.target.checked })} /><span>Dream on quiet days</span></label>
      <p id="quiet-day-dreams-help" className="settings-description">On quiet days, create a diary from retained continuity without re-extraction. Otherwise, skip model work when there is no new material.</p></div></div>
      <div className="dream-schedule-fields"><ProviderModelFields providers={savedProviders} connectionId={settings.modelConnectionId} model={settings.model} inheritLabel="Use agent chat model" disabled={disabled} onChange={(modelConnectionId, model) => setSettings({ ...settings, modelConnectionId, model })} /></div>
      <p className="settings-description">Effective model: {effectiveModel?.modelConnectionId && effectiveModel.model ? modelLabel(effectiveModel, [{ value: '', label: 'Use agent chat model' }, ...dreamModels.map((option) => ({ value: dreamModelValue(option.connectionId, option.model), label: option.label }))]) : 'Unconfigured'}</p>
      {modelResolutionError && <p className="settings-request-error" role="alert">Model resolution error: {modelResolutionError}</p>}
      <Field label="Dream prompt"><textarea rows={6} value={settings.prompt} disabled={disabled} onChange={(event) => setSettings({ ...settings, prompt: event.target.value })} /></Field>
    </div>
    <div className="dream-actions">
      <button className="primary" onClick={() => void save()} disabled={state !== 'idle'}>{state === 'saving' ? 'Saving…' : 'Save dream settings'}</button>
    </div>
    {error && <p className="settings-request-error" role="alert">{error}</p>}
    <details className="dream-recent-activity"><summary>Recent activity</summary>{activity}</details>
  </SettingSection>{overflowTarget ? createPortal(<div className="settings-overflow-content">{memoryControls}</div>, overflowTarget) : memoryControls}</>;
}

