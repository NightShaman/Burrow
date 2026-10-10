import type { SavedProvider } from '../../app/types';
import { Field } from './SettingsPrimitives';

/** Saved provider is the readable connection name. Duplicate names need only a compact ordinal. */
export function providerOptionLabel(providers: SavedProvider[], item: SavedProvider): string {
  const name = item.provider.trim() || 'Unnamed connection';
  const matches = providers.filter(candidate => (candidate.provider.trim() || 'Unnamed connection') === name);
  return matches.length > 1 ? `${name} · ${matches.findIndex(candidate => candidate.id === item.id) + 1}` : name;
}

/** A connection is chosen before its model; missing saved values remain visible. */
export function ProviderModelFields({ providers, connectionId, model, onChange, inheritLabel, disabled = false, providerLabel = 'Provider', modelLabel = 'Model' }: { providers: SavedProvider[]; connectionId: string | null | undefined; model: string | null | undefined; onChange: (connectionId: string | null, model: string | null) => void; inheritLabel?: string; disabled?: boolean; providerLabel?: string; modelLabel?: string }) {
  const provider = providers.find(item => item.id === connectionId);
  const missingProvider = Boolean(connectionId && !provider);
  const missingModel = Boolean(model && !provider?.models.includes(model));
  return <div className="field-pair provider-model-fields"><Field label={providerLabel}><select value={connectionId ?? ''} disabled={disabled} onChange={event => { const next = providers.find(item => item.id === event.target.value); onChange(next?.id ?? null, next?.models[0] ?? null); }}>
    <option value="">{inheritLabel ?? 'Choose provider'}</option>
    {missingProvider && <option value={connectionId!}>Configured connection (unavailable)</option>}
    {providers.map(item => <option key={item.id} value={item.id}>{providerOptionLabel(providers, item)}</option>)}
  </select></Field><Field label={modelLabel}><select value={model ?? ''} disabled={disabled || !provider} onChange={event => onChange(connectionId ?? null, event.target.value || null)}>
    <option value="">{connectionId ? 'Choose model' : inheritLabel ?? 'Choose provider first'}</option>
    {missingModel && <option value={model!}>Unavailable · {model}</option>}
    {[...new Set(provider?.models ?? [])].map(value => <option key={value} value={value}>{provider?.modelLabels?.[value] ?? value}</option>)}
  </select></Field></div>;
}
