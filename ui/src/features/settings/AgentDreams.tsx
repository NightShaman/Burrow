import { useEffect, useRef, useState } from 'react';
import type { SavedProvider } from '../../app/types';
import { apiForTarget } from '../../app/api';
import { targetForResource, type ApiTarget } from '../../app/apiTargets';
import { Field, SettingSection } from './SettingsPrimitives';

type DreamSettings = { enabled: boolean; cron: string; timezone: string; prompt: string; modelConnectionId?: string | null; model?: string | null };
function dreamModelValue(connectionId: string, model: string) { return JSON.stringify([connectionId, model]); }
function settingsModelValue(settings: DreamSettings) { return settings.modelConnectionId && settings.model ? dreamModelValue(settings.modelConnectionId, settings.model) : ''; }
function dreamModelFromValue(value: string) {
  if (!value) return { modelConnectionId: null, model: null };
  try {
    const [modelConnectionId, model] = JSON.parse(value) as [string, string];
    return modelConnectionId && model ? { modelConnectionId, model } : { modelConnectionId: null, model: null };
  } catch { return { modelConnectionId: null, model: null }; }
}

function DreamModelSelect({ value, options, onChange }: { value: string; options: { value: string; label: string }[]; onChange: (value: string) => void }) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const selected = options.find((option) => option.value === value) ?? options[0];

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  return <div className="dream-model-select" ref={menuRef}>
    <button type="button" className="dream-model-trigger" aria-haspopup="listbox" aria-expanded={open} aria-label="Dream model" onClick={() => setOpen((current) => !current)}>
      <span>{selected?.label ?? 'Use agent chat model'}</span><span className="dream-phase-chevron" aria-hidden="true">⌄</span>
    </button>
    {open && <div className="dream-model-menu" role="listbox" aria-label="Dream model">
      {options.map((option) => <button type="button" role="option" aria-selected={option.value === value} className={option.value === value ? 'selected' : ''} key={option.value} onClick={() => { onChange(option.value); setOpen(false); }}>{option.label}</button>)}
    </div>}
  </div>;
}

export function AgentDreams({ agentId, targets, savedProviders }: { agentId: string; targets: ApiTarget[]; savedProviders: SavedProvider[] }) {
  const owner = targetForResource(targets, agentId);
  const request = <T,>(path: string, init?: RequestInit) => apiForTarget<T>(owner.target, path, init);
  const dreamModels = savedProviders.flatMap((provider) => provider.models.map((model) => ({ connectionId: provider.id, model, label: `${provider.provider} · ${provider.modelLabels?.[model] ?? model}` })));
  const [settings, setSettings] = useState<DreamSettings>({ enabled: false, cron: '0 4 * * *', timezone: 'UTC', prompt: '', modelConnectionId: null, model: null });
  const selectedDreamModel = settingsModelValue(settings);
  const [state, setState] = useState<'loading' | 'idle' | 'saving'>('loading');
  const [error, setError] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    setState('loading'); setError('');
    request<{ settings: DreamSettings }>(`/api/agents/${encodeURIComponent(owner.resourceId)}/dream-settings`, { signal: controller.signal }).then(dreamSettings => {
      if (controller.signal.aborted) return;
      setSettings(dreamSettings.settings);
      setState('idle');
    }).catch(cause => {
      if (controller.signal.aborted) return;
      setError(cause instanceof Error ? `Could not load dream settings: ${cause.message}` : 'Could not load dream settings.');
      setState('idle');
    });
    return () => controller.abort();
  }, [owner.target.id, owner.resourceId]);
  const save = async () => {
    setState('saving'); setError('');
    try { const result = await request<{ settings: DreamSettings }>(`/api/agents/${encodeURIComponent(owner.resourceId)}/dream-settings`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(settings) }); setSettings(result.settings); }
    catch (cause) { setError(cause instanceof Error ? `Could not save dream settings: ${cause.message}` : 'Could not save dream settings.'); }
    finally { setState('idle'); }
  };
  return <SettingSection title="Dreams">
    <p className="settings-description">Configure scheduled dreaming for this agent.</p>
    <div className="dream-settings-fields">
      <label className="agent-enabled"><input type="checkbox" checked={settings.enabled} onChange={(event) => setSettings({ ...settings, enabled: event.target.checked })} /><span>Enable scheduled dreaming</span></label>
      <div className="dream-schedule-fields"><Field label="Cron"><input value={settings.cron} onChange={(event) => setSettings({ ...settings, cron: event.target.value })} /></Field><Field label="Timezone"><input value={settings.timezone} onChange={(event) => setSettings({ ...settings, timezone: event.target.value })} /></Field><Field label="Model"><DreamModelSelect value={selectedDreamModel} options={[{ value: '', label: 'Use agent chat model' }, ...dreamModels.map((option) => ({ value: dreamModelValue(option.connectionId, option.model), label: option.label }))]} onChange={(value) => setSettings({ ...settings, ...dreamModelFromValue(value) })} /></Field></div>
      <Field label="Dream prompt"><textarea rows={6} value={settings.prompt} onChange={(event) => setSettings({ ...settings, prompt: event.target.value })} /></Field>
    </div>
    <div className="dream-actions">
      <button className="primary" onClick={() => void save()} disabled={state !== 'idle'}>{state === 'saving' ? 'Saving…' : 'Save dream settings'}</button>
    </div>
    {error && <p className="settings-request-error" role="alert">{error}</p>}
  </SettingSection>;
}

