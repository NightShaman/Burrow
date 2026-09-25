import type { ReactNode } from 'react';
import type { RuntimeModel } from '../../app/api';
import type { SavedProvider } from '../../app/types';

export const modelConnectionApiTypes = [
  { value: 'openai-chat-completions', label: 'OpenAI Chat Completions' },
  { value: 'openai-responses', label: 'OpenAI Responses' },
  { value: 'anthropic-messages', label: 'Anthropic Messages' },
];

type ModelResultsProps = {
  models: RuntimeModel[];
  manualModel: string;
  selectedModelId?: string | null;
  onSelectModel?: (id: string) => void;
  onManualModelChange: (value: string) => void;
  onAddManualModel: () => void;
  onDeleteManualModel: (id: string) => void;
  onToggleModel: (id: string) => void;
};

const capabilityLabel = (values: string[] | undefined) => values?.length ? values.join(', ') : 'Unknown';

export function ModelResults({ models, manualModel, selectedModelId, onSelectModel, onManualModelChange, onAddManualModel, onDeleteManualModel, onToggleModel }: ModelResultsProps) {
  return <div className={`model-results${models.length === 0 ? ' model-results-empty' : ''}`}>
    {models.length === 0 && <div className="model-empty-state"><strong>No models were discovered.</strong><span>Add a model ID manually to continue.</span></div>}
    <div className="model-options">{models.map((model) => {
      const label = model.displayName ?? model.id;
      return <article className={`model-option${selectedModelId === model.id ? ' selected' : ''}`} key={model.id}>
        <input className="model-option-check" type="checkbox" checked={model.selected !== false} onChange={() => onToggleModel(model.id)} aria-label={`Use ${label}`} />
        <button className="model-option-select" type="button" onClick={() => onSelectModel?.(model.id)} aria-pressed={selectedModelId === model.id}>
          <strong>{label}</strong><small>{model.id}</small>
        </button>
        <div className="model-option-summary"><span>{capabilityLabel(model.discoveredInput ?? model.acceptedInput)}</span><span>{capabilityLabel(model.discoveredOutput ?? model.acceptedOutput)}</span></div>
        {model.manual && <button type="button" className="model-delete" onClick={() => onDeleteManualModel(model.id)} aria-label={`Delete manually added model ${model.id}`} title="Delete model">×</button>}
      </article>;
    })}</div>
    <div className="manual-model">
      <label htmlFor="manual-model-id">Model ID</label>
      <input id="manual-model-id" value={manualModel} onChange={(event) => onManualModelChange(event.target.value)} placeholder="e.g. llama-3.1-8b" onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); onAddManualModel(); } }} />
      <button className="secondary" type="button" onClick={onAddManualModel} disabled={!manualModel.trim()}>Add model</button>
    </div>
  </div>;
}

export function ModelCapabilityEditor({ model, onToggleModelInput, onSetModelInputAuto, onToggleModelOutput, onSetModelOutputAuto, onSetModelContextAuto, onSetModelContextOverride }: { model: RuntimeModel; onToggleModelInput: (id: string, input: 'text' | 'image') => void; onSetModelInputAuto: (id: string, enabled: boolean) => void; onToggleModelOutput: (id: string, output: 'text' | 'audio' | 'image' | 'video' | 'file') => void; onSetModelOutputAuto: (id: string, enabled: boolean) => void; onSetModelContextAuto?: (id: string, enabled: boolean) => void; onSetModelContextOverride?: (id: string, value: number | undefined) => void }) {
  const inputAuto = !model.acceptedInputOverride;
  const outputAuto = !model.acceptedOutputOverride;
  const inputValues = model.acceptedInput ?? ['text'];
  const outputValues = model.acceptedOutput ?? ['text'];
  return <div className="model-capability-editor">
    <div className="model-detail-heading"><div><span className="settings-kicker">Model capabilities</span><h3>{model.displayName ?? model.id}</h3><code>{model.id}</code></div><span className="model-detail-state">{model.manual ? 'Manual model' : 'Discovered model'}</span></div>
    <ContextWindowEditor model={model} onAutoChange={(enabled) => onSetModelContextAuto?.(model.id, enabled)} onOverrideChange={(value) => onSetModelContextOverride?.(model.id, value)} />
    <CapabilityGroup title="Input" discovered={model.discoveredInput} auto={inputAuto} onAutoChange={(enabled) => onSetModelInputAuto(model.id, enabled)}>
      {(['text', 'image'] as const).map((value) => <label key={value}><input type="checkbox" aria-label={`Input ${value}`} checked={inputValues.includes(value)} disabled={inputAuto} onChange={() => onToggleModelInput(model.id, value)} /><span>{value}</span></label>)}
    </CapabilityGroup>
    <CapabilityGroup title="Output" discovered={model.discoveredOutput} auto={outputAuto} onAutoChange={(enabled) => onSetModelOutputAuto(model.id, enabled)}>
      {(['text', 'audio', 'image', 'video', 'file'] as const).map((value) => <label key={value}><input type="checkbox" aria-label={`Output ${value}`} checked={outputValues.includes(value)} disabled={outputAuto} onChange={() => onToggleModelOutput(model.id, value)} /><span>{value}</span></label>)}
    </CapabilityGroup>
    <p className="model-capability-note">Auto uses discovered capabilities when available. Unknown means no capability metadata was returned.</p>
    {capabilityProvenanceLabel(model.capabilityProvenance) && <p className="model-capability-provenance" aria-label="Capability provenance">Source: {capabilityProvenanceLabel(model.capabilityProvenance)}</p>}
  </div>;
}

function ContextWindowEditor({ model, onAutoChange, onOverrideChange }: { model: RuntimeModel; onAutoChange: (enabled: boolean) => void; onOverrideChange: (value: number | undefined) => void }) {
  const auto = model.contextWindowMode !== 'manual' && model.contextWindowOverride == null;
  return <fieldset className="model-capability-group model-context-window"><legend>Context window</legend><div className="model-capability-mode"><label className="model-capability-auto"><input type="radio" name="context-window-mode" checked={auto} onChange={() => onAutoChange(true)} /><span>Auto</span></label><label className="model-capability-auto"><input type="radio" name="context-window-mode" checked={!auto} onChange={() => onAutoChange(false)} /><span>Manual</span></label><span className="model-capability-discovered">{model.discoveredContextWindow ? `Discovered: ${model.discoveredContextWindow.toLocaleString()} tokens` : 'Unknown'}</span></div><label className="context-window-input" htmlFor="context-window-override">Manual token limit<input id="context-window-override" type="number" min="1" step="1" value={model.contextWindowOverride ?? ''} disabled={auto} placeholder="Positive token count" onChange={(event) => { const next = Number(event.target.value); onOverrideChange(Number.isInteger(next) && next > 0 ? next : undefined); }} /></label><p className="model-capability-note">Auto uses the discovered context window when available.{model.capabilityProvenance ? ' Provenance is shown below.' : ''}</p></fieldset>;
}

function CapabilityGroup({ title, discovered, auto, onAutoChange, children }: { title: string; discovered?: string[]; auto: boolean; onAutoChange: (enabled: boolean) => void; children: ReactNode }) {
  return <fieldset className="model-capability-group"><legend>{title}</legend><div className="model-capability-mode"><label className="model-capability-auto"><input type="radio" name={`${title}-capability-mode`} checked={auto} onChange={() => onAutoChange(true)} /><span>Auto</span></label><label className="model-capability-auto"><input type="radio" name={`${title}-capability-mode`} checked={!auto} onChange={() => onAutoChange(false)} /><span>Manual</span></label><span className="model-capability-discovered">{discovered?.length ? `Discovered: ${discovered.join(', ')}` : 'Unknown'}</span></div><div className="model-capability-manual">{children}</div></fieldset>;
}

function capabilityProvenanceLabel(provenance: RuntimeModel['capabilityProvenance']) {
  if (!provenance) return null;
  const source = provenance.source?.trim();
  const match = [provenance.matchedProvider, provenance.matchedModel].filter(Boolean).join(' / ');
  const snapshot = provenance.snapshotAt ? new Date(provenance.snapshotAt).toLocaleDateString() : '';
  const details = [source, match && `match ${match}`, snapshot && `snapshot ${snapshot}`].filter(Boolean);
  return details.length ? details.join(' · ') : null;
}

type SavedProvidersProps = { providers: SavedProvider[]; open: boolean; onOpenChange: (open: boolean) => void; onEdit: (provider: SavedProvider) => void; onDelete: (provider: SavedProvider) => void; expanded?: boolean; selectedId?: string | null };
export function SavedProviders({ providers, open, onOpenChange, onEdit, onDelete, expanded = false, selectedId }: SavedProvidersProps) {
  const contents = providers.length === 0 ? <p className="settings-empty">No providers saved yet.</p> : <div className="provider-list">{providers.map((item) => <article className="provider-card" key={item.id}><button className="provider-card-select" type="button" onClick={() => onEdit(item)} aria-pressed={selectedId === item.id}><strong>{item.provider}</strong><small>{modelConnectionApiTypes.find((type) => type.value === item.apiType)?.label ?? item.apiType} · {item.models.length} {item.models.length === 1 ? 'model' : 'models'}</small>{(item.oauthConfigured || item.auth?.type === 'oauth') && <small>OAuth configured</small>}</button><button className="danger" type="button" onClick={() => onDelete(item)} aria-label={`Delete ${item.provider}`}>Delete</button></article>)}</div>;
  if (expanded) return <div className="settings-overflow-content model-saved">{contents}</div>;
  return <details className="model-saved saved-accordion" open={open} onToggle={(event) => onOpenChange(event.currentTarget.open)}><summary><h3>Saved providers</h3><span>{providers.length}</span></summary>{contents}</details>;
}

export { capabilityLabel };
