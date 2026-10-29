import { isUnsavedChangesModalTarget, useUnsavedChanges } from '../../app/UnsavedChanges';
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
type EditableDreamSettings = ReturnType<typeof editableSettings>;
type EditableDreamKey = keyof EditableDreamSettings;
const settingsBaseline = (settings: DreamSettings) => JSON.stringify(editableSettings(settings));
const editableKeys = ['enabled', 'quietDayDreams', 'promoteToMemory', 'cron', 'prompt', 'modelConnectionId', 'model', 'memoryEmphasis', 'memoryPromptOverride'] as const satisfies readonly EditableDreamKey[];
function validCron(value: string) {
  const ranges = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]] as const;
  const fields = value.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  return fields.every((field, index) => {
    const [min, max] = ranges[index];
    return field.split(',').every(part => {
      const pieces = part.split('/');
      if (pieces.length > 2) return false;
      const step = pieces[1] === undefined ? 1 : Number(pieces[1]);
      if (!Number.isInteger(step) || step < 1 || step > max - min + 1) return false;
      if (pieces[0] === '*') return true;
      const match = /^(\d+)(?:-(\d+))?$/.exec(pieces[0]);
      if (!match) return false;
      const start = Number(match[1]);
      const end = match[2] === undefined ? start : Number(match[2]);
      return start >= min && end <= max && end >= start;
    });
  });
}
function validateSettings(settings: EditableDreamSettings) {
  if (typeof settings.enabled !== 'boolean' || typeof settings.quietDayDreams !== 'boolean' || typeof settings.promoteToMemory !== 'boolean') return 'Dream toggle values are invalid.';
  if (typeof settings.cron !== 'string' || !validCron(settings.cron)) return 'Enter a valid five-field cron schedule.';
  if (typeof settings.prompt !== 'string' || !settings.prompt.trim() || settings.prompt.length > 20_000) return 'Dream prompt must contain text and use 20,000 characters or fewer.';
  if (!Number.isInteger(settings.memoryEmphasis) || settings.memoryEmphasis < 0 || settings.memoryEmphasis > 100) return 'Memory emphasis must be from 0 to 100.';
  if (settings.memoryPromptOverride != null && (typeof settings.memoryPromptOverride !== 'string' || settings.memoryPromptOverride.length > 20_000)) return 'Memory prompt override must use 20,000 characters or fewer.';
  if ((settings.modelConnectionId != null && typeof settings.modelConnectionId !== 'string') || (settings.model != null && typeof settings.model !== 'string') || ((settings.modelConnectionId || settings.model) && (!settings.modelConnectionId || !settings.model || settings.modelConnectionId.length > 256 || settings.model.length > 256))) return 'Choose a complete Dream provider and model, or use the agent chat model.';
  return '';
}
type MemoryPreview = { memories: { title: string; content: string; sourceRefs: string[] }[]; sourceToken: string; sourceCount: number; generatedAt: string; evidenceScope: string; persisted: false };
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
  const [notice, setNotice] = useState('');
  const [failedKeys, setFailedKeys] = useState<EditableDreamKey[]>([]);
  const [effectiveModel, setEffectiveModel] = useState<DreamModel | null>(null);
  const [modelResolutionError, setModelResolutionError] = useState<string | null>(null);
  const requestVersion = useRef(0);
  const accepted = useRef<DreamSettings | null>(null);
  const draft = useRef(settings);
  const saving = useRef(false);
  const emphasisInteraction = useRef(false);
  const changeSettings = (changes: Partial<EditableDreamSettings>) => {
    draft.current = { ...draft.current, ...changes };
    setSettings(current => ({ ...current, ...changes }));
    setNotice('');
    setFailedKeys(current => current.filter(key => !(key in changes)));
  };
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
    saving.current = false; emphasisInteraction.current = false; accepted.current = null;
    const empty: DreamSettings = { enabled: false, quietDayDreams: true, promoteToMemory: true, cron: '0 4 * * *', timezone: null, prompt: '', modelConnectionId: null, model: null };
    draft.current = empty;
    setState('loading'); setError(''); setNotice(''); setFailedKeys([]); setSettings(empty); setBaseline(''); setEffectiveModel(null); setModelResolutionError(null);
    request<DreamSettingsResponse>(`/api/agents/${encodeURIComponent(resourceId)}/dream-settings`, { signal: controller.signal }).then((dreamSettings) => {
      if (controller.signal.aborted || version !== requestVersion.current) return;
      if (!dreamSettings?.settings) throw new Error('Invalid dream settings response.');
      const loaded = normalizeSettings(dreamSettings.settings);
      accepted.current = loaded; draft.current = loaded;
      setSettings(loaded);
      setBaseline(settingsBaseline(loaded));
      setEffectiveModel(dreamSettings.effectiveModel ?? null);
      setModelResolutionError(dreamSettings.modelResolutionError ?? null);
      setState('idle');
    }).catch(cause => {
      if (controller.signal.aborted || version !== requestVersion.current) return;
      setError(cause instanceof Error ? `Could not load dream settings: ${cause.message}` : 'Could not load dream settings.');
      setState('error');
    });
    return () => controller.abort();
  }, [agentId, retry]);
  const saveChanges = async (changes: Partial<EditableDreamSettings>, keys: EditableDreamKey[], message = 'Dream setting saved.') => {
    if (state !== 'idle' || saving.current || !accepted.current) return false;
    const payload = { ...editableSettings(accepted.current), ...changes };
    const validationError = validateSettings(payload) || (payload.modelConnectionId && !savedProviders.some(provider => provider.id === payload.modelConnectionId && provider.models.includes(payload.model!)) ? 'Choose an available Dream provider and model, or use the agent chat model.' : '');
    if (validationError) { setError(validationError); setNotice(''); return false; }
    if (keys.every(key => editableSettings(accepted.current!)[key] === payload[key])) {
      setError(''); setNotice(''); setFailedKeys(current => current.filter(key => !keys.includes(key)));
      return true;
    }
    const version = requestVersion.current;
    saving.current = true;
    setState('saving'); setError(''); setNotice(''); setFailedKeys(current => current.filter(key => !keys.includes(key)));
    try {
      const result = await request<DreamSettingsResponse>(`/api/agents/${encodeURIComponent(resourceId)}/dream-settings`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
      if (version !== requestVersion.current) return false;
      if (!result?.settings) throw new Error('Invalid dream settings response.');
      const nextAccepted = normalizeSettings(result.settings);
      const invalidResponse = validateSettings(editableSettings(nextAccepted));
      if (invalidResponse) throw new Error(`Invalid dream settings response: ${invalidResponse}`);
      accepted.current = nextAccepted;
      setBaseline(settingsBaseline(nextAccepted));
      setSettings(current => {
        const committed = Object.fromEntries(keys.map(key => [key, editableSettings(nextAccepted)[key]])) as Partial<EditableDreamSettings>;
        const next = normalizeSettings({ ...current, timezone: nextAccepted.timezone, effectiveTimezone: nextAccepted.effectiveTimezone, defaultMemoryPrompt: nextAccepted.defaultMemoryPrompt, effectiveMemoryPrompt: nextAccepted.effectiveMemoryPrompt, ...committed });
        draft.current = next;
        return next;
      });
      setEffectiveModel(result.effectiveModel ?? null);
      setModelResolutionError(result.modelResolutionError ?? null);
      setNotice(message);
      return true;
    } catch (cause) {
      if (version === requestVersion.current) {
        setFailedKeys(current => [...new Set([...current, ...keys])]);
        setError(cause instanceof Error ? `Could not save dream settings: ${cause.message}` : 'Could not save dream settings.');
      }
      return false;
    } finally {
      if (version === requestVersion.current) { saving.current = false; setState('idle'); }
    }
  };
  const save = () => saveChanges(editableSettings(draft.current), [...editableKeys], 'Dream settings saved.');
  const retryFailed = () => {
    const current = editableSettings(draft.current);
    const changes = Object.fromEntries(failedKeys.map(key => [key, current[key]])) as Partial<EditableDreamSettings>;
    void saveChanges(changes, failedKeys);
  };
  useUnsavedChanges({ dirty: state !== 'loading' && state !== 'error' && baseline !== '' && settingsBaseline(settings) !== baseline, busy: state === 'saving', resumeAfterAutosave: true, save, discard: () => {
    if (!accepted.current) return;
    emphasisInteraction.current = false; draft.current = accepted.current; setSettings(accepted.current); setError(''); setNotice(''); setFailedKeys([]);
  } });
  const commitEmphasis = () => {
    if (!emphasisInteraction.current) return;
    emphasisInteraction.current = false;
    void saveChanges({ memoryEmphasis: draft.current.memoryEmphasis ?? 50 }, ['memoryEmphasis']);
  };
  // Focus moves before click/change. Do not let a blur save disable an
  // independent action (or turn a no-save preview into an implicit write).
  // relatedTarget also covers keyboard navigation and touch-generated focus.
  const commitsOnBlur = (relatedTarget: EventTarget | null) => !isUnsavedChangesModalTarget(relatedTarget)
    && !(relatedTarget instanceof Element && relatedTarget.closest('[data-dream-independent-action]'));
  const disabled = state !== 'idle';
  const memoryControls = <SettingSection title="Dream memory">
      <label className="agent-enabled"><input type="checkbox" data-dream-independent-action checked={settings.promoteToMemory} disabled={disabled} aria-describedby="agent-dream-promotion-help" onChange={(event) => { const promoteToMemory = event.target.checked; changeSettings({ promoteToMemory }); void saveChanges({ promoteToMemory }, ['promoteToMemory']); }} /><span>Promote Dreams to memory</span></label>
      <p id="agent-dream-promotion-help" className="settings-description">Also requires global promotion in Continuity. Turning this off keeps the archive and existing memories; explicit saves still work. Skipped promotions are not caught up later.</p>
      <div className="dream-memory-controls">
        <Field label="Memory emphasis"><span aria-hidden="true" className="field-hint">{settings.memoryEmphasis ?? 50} · {(settings.memoryEmphasis ?? 50) === 50 ? 'Balanced' : (settings.memoryEmphasis ?? 50) < 50 ? 'Analytical' : 'Meaning-focused'}</span><input type="range" data-dream-independent-action min={0} max={100} step={1} aria-describedby="dream-memory-emphasis-help" value={settings.memoryEmphasis ?? 50} disabled={disabled} aria-valuetext={`${settings.memoryEmphasis ?? 50} · ${(settings.memoryEmphasis ?? 50) === 50 ? 'Balanced' : (settings.memoryEmphasis ?? 50) < 50 ? 'Analytical' : 'Meaning-focused'}`} onPointerDown={(event) => { emphasisInteraction.current = true; event.currentTarget.setPointerCapture?.(event.pointerId); }} onPointerUp={commitEmphasis} onPointerCancel={commitEmphasis} onLostPointerCapture={commitEmphasis} onKeyDown={(event) => { if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) emphasisInteraction.current = true; }} onKeyUp={(event) => { if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) commitEmphasis(); }} onBlur={(event) => { if (commitsOnBlur(event.relatedTarget)) commitEmphasis(); else emphasisInteraction.current = false; }} onChange={(event) => { emphasisInteraction.current = true; changeSettings({ memoryEmphasis: Number(event.target.value) }); }} /></Field>
        <div className="dream-emphasis-labels" aria-hidden="true"><span>0 · Analytical</span><span>50 · Balanced</span><span>100 · Meaning-focused</span></div>
        <p id="dream-memory-emphasis-help" className="field-hint">Controls expression, not selection or evidence. SOUL supplies the agent’s voice.</p>
        <div className="dream-memory-heading"><span>{settings.memoryPromptOverride != null ? 'Custom override active' : 'Default prompt'}</span><button type="button" data-dream-independent-action disabled={disabled || settings.memoryPromptOverride == null} onMouseDown={(event) => event.preventDefault()} onClick={() => { changeSettings({ memoryPromptOverride: null }); void saveChanges({ memoryPromptOverride: null }, ['memoryPromptOverride']); }}>Revert to default</button></div>
        <Field label="Memory prompt override"><textarea maxLength={20000} rows={8} value={settings.memoryPromptOverride ?? settings.defaultMemoryPrompt ?? ''} disabled={disabled} onChange={(event) => changeSettings({ memoryPromptOverride: event.target.value })} onBlur={(event) => { if (commitsOnBlur(event.relatedTarget)) void saveChanges({ memoryPromptOverride: draft.current.memoryPromptOverride ?? null }, ['memoryPromptOverride']); }} /></Field>
        <div className="dream-memory-preview">
          <p id="dream-memory-preview-help" className="field-hint">Uses recent validated Dream extraction candidates, not full history or existing memories. May make a paid request using the saved Dream model. Nothing is saved.</p>
          <div className="dream-memory-preview-actions">
            <button type="button" data-dream-independent-action disabled={disabled || previewBusy || sourceInvalid} aria-describedby="dream-memory-preview-help" onMouseDown={(event) => event.preventDefault()} onClick={() => void generatePreview()}>{previewBusy ? 'Generating preview…' : 'Preview memories'}</button>
            {(sourceToken || sourceInvalid) && <button type="button" data-dream-independent-action disabled={disabled || previewBusy} onMouseDown={(event) => event.preventDefault()} onClick={() => void generatePreview(true)}>Preview new sample</button>}
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
      <div className="dream-toggle-group"><div className="dream-scheduled-controls"><label className="agent-enabled"><input type="checkbox" data-dream-independent-action checked={settings.enabled} disabled={disabled} onChange={(event) => { const enabled = event.target.checked; changeSettings({ enabled }); void saveChanges({ enabled }, ['enabled']); }} /><span>Enable scheduled dreaming</span></label><div className="skill-compact-field"><Field label="Cron"><input value={settings.cron} disabled={disabled} onChange={(event) => changeSettings({ cron: event.target.value })} onBlur={(event) => { if (commitsOnBlur(event.relatedTarget)) void saveChanges({ cron: draft.current.cron }, ['cron']); }} /></Field><small className="field-hint">Operator timezone{settings.effectiveTimezone ? `: ${settings.effectiveTimezone}` : ''}.</small></div></div>
      <div><label className="agent-enabled"><input type="checkbox" data-dream-independent-action checked={settings.quietDayDreams} disabled={disabled} aria-describedby="quiet-day-dreams-help" onChange={(event) => { const quietDayDreams = event.target.checked; changeSettings({ quietDayDreams }); void saveChanges({ quietDayDreams }, ['quietDayDreams']); }} /><span>Dream on quiet days</span></label>
      <p id="quiet-day-dreams-help" className="settings-description">On quiet days, create a diary from retained continuity without re-extraction. Otherwise, skip model work when there is no new material.</p></div></div>
      <div className="dream-schedule-fields" data-dream-independent-action><ProviderModelFields providers={savedProviders} connectionId={settings.modelConnectionId} model={settings.model} inheritLabel="Use agent chat model" disabled={disabled} onChange={(modelConnectionId, model) => { changeSettings({ modelConnectionId, model }); if ((!modelConnectionId && !model) || (modelConnectionId && model)) void saveChanges({ modelConnectionId, model }, ['modelConnectionId', 'model']); }} /></div>
      <p className="settings-description">Effective model: {effectiveModel?.modelConnectionId && effectiveModel.model ? modelLabel(effectiveModel, [{ value: '', label: 'Use agent chat model' }, ...dreamModels.map((option) => ({ value: dreamModelValue(option.connectionId, option.model), label: option.label }))]) : 'Unconfigured'}</p>
      {modelResolutionError && <p className="settings-request-error" role="alert">Model resolution error: {modelResolutionError}</p>}
      <Field label="Dream prompt"><textarea rows={6} value={settings.prompt} disabled={disabled} onChange={(event) => changeSettings({ prompt: event.target.value })} onBlur={(event) => { if (commitsOnBlur(event.relatedTarget)) void saveChanges({ prompt: draft.current.prompt }, ['prompt']); }} /></Field>
    </div>
    {state === 'saving' && <p role="status">Saving dream settings…</p>}
    {state === 'idle' && failedKeys.length > 0 && <div className="dream-actions"><button className="secondary" type="button" data-dream-independent-action disabled={state !== 'idle'} onClick={retryFailed}>Retry saving dream settings</button></div>}
    {error && <p className="settings-request-error" role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
  </SettingSection>{overflowTarget ? createPortal(<div className="settings-overflow-content">{memoryControls}</div>, overflowTarget) : memoryControls}</>;
}

