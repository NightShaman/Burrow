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
  onManualModelChange: (value: string) => void;
  onAddManualModel: () => void;
  onDeleteManualModel: (id: string) => void;
  onToggleModel: (id: string) => void;
  onToggleModelInput: (id: string, input: 'text' | 'image') => void;
  onSetModelInputAuto: (id: string, enabled: boolean) => void;
};

export function ModelResults({ models, manualModel, onManualModelChange, onAddManualModel, onDeleteManualModel, onToggleModel, onToggleModelInput, onSetModelInputAuto }: ModelResultsProps) {
  return <div className={`model-results${models.length === 0 ? ' model-results-empty' : ''}`}>
    {models.length === 0 && <div className="model-empty-state"><strong>No models were discovered.</strong><span>Add a model ID manually to continue.</span></div>}
    <div className="model-options">{models.map((model) => {
      const label = model.displayName ?? model.id;
      return <div className="model-option" key={model.id}>
        <label className="model-selection"><input type="checkbox" checked={model.selected !== false} onChange={() => onToggleModel(model.id)} /><span>{label}</span></label>
        <fieldset className="model-capabilities" aria-label={`Capabilities for ${label}`}>
          <label className="model-capability-auto"><input type="checkbox" checked={!model.acceptedInputOverride} onChange={(event) => onSetModelInputAuto(model.id, event.target.checked)} /><span>Auto</span></label>
          {model.acceptedInputOverride && <div className="model-capability-manual">
            <label><input type="checkbox" checked={(model.acceptedInput ?? ['text']).includes('text')} onChange={() => onToggleModelInput(model.id, 'text')} /><span>Text</span></label>
            <label><input type="checkbox" checked={(model.acceptedInput ?? ['text']).includes('image')} onChange={() => onToggleModelInput(model.id, 'image')} /><span>Image</span></label>
          </div>}
        </fieldset>
        {model.manual && <button type="button" className="model-delete" onClick={() => onDeleteManualModel(model.id)} aria-label={`Delete manually added model ${model.id}`} title="Delete model">×</button>}
      </div>;
    })}</div>
    <div className="manual-model">
      <label htmlFor="manual-model-id">Model ID</label>
      <input id="manual-model-id" value={manualModel} onChange={(event) => onManualModelChange(event.target.value)} placeholder="e.g. llama-3.1-8b" onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); onAddManualModel(); } }} />
      <button className="secondary" type="button" onClick={onAddManualModel} disabled={!manualModel.trim()}>Add model</button>
    </div>
  </div>;
}

type SavedProvidersProps = {
  providers: SavedProvider[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onEdit: (provider: SavedProvider) => void;
  onDelete: (provider: SavedProvider) => void;
};

export function SavedProviders({ providers, open, onOpenChange, onEdit, onDelete }: SavedProvidersProps) {
  return <details className="model-saved saved-accordion" open={open} onToggle={(event) => onOpenChange(event.currentTarget.open)}>
    <summary><h3>Saved providers</h3><span>{providers.length}</span></summary>
    {providers.length === 0 ? <p className="settings-empty">No providers saved yet.</p> : <div className="provider-list">{providers.map((item) => <article className="provider-card" key={item.id}>
      <div>
        <strong>{item.provider}</strong>
        <small>{modelConnectionApiTypes.find((type) => type.value === item.apiType)?.label ?? item.apiType} · {item.url}</small>
        {(item.oauthConfigured || item.auth?.type === 'oauth') && <small>Auth: OAuth configured</small>}
        {(item.authSource || item.auth?.source) && <small>Source: {item.authSource || item.auth?.source}</small>}
        {(item.expiresAt || item.auth?.expiresAt) && <small>Expires: {new Date((item.expiresAt || item.auth?.expiresAt) as string).toLocaleString()}</small>}
      </div>
      <div className="provider-models">{item.models.map((model) => <span key={model}>{model}</span>)}</div>
      <div className="card-actions"><button className="secondary" onClick={() => onEdit(item)}>Edit</button><button className="danger" onClick={() => onDelete(item)}>Delete</button></div>
    </article>)}</div>}
  </details>;
}
