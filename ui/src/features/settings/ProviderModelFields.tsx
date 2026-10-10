import type { SavedProvider } from '../../app/types';
import { Field } from './SettingsPrimitives';

/** A connection is chosen before its model; missing saved values remain visible. */
export function ProviderModelFields({ providers, connectionId, model, onChange, inheritLabel, disabled = false, providerLabel = 'Provider', modelLabel = 'Model' }: { providers: SavedProvider[]; connectionId: string | null | undefined; model: string | null | undefined; onChange: (connectionId: string | null, model: string | null) => void; inheritLabel?: string; disabled?: boolean; providerLabel?: string; modelLabel?: string }) {
  const provider = providers.find(item => item.id === connectionId);
  const missingProvider = Boolean(connectionId && !provider);
  const missingModel = Boolean(model && !provider?.models.includes(model));
  return <><Field label={providerLabel}><select value={connectionId ?? ''} disabled={disabled} onChange={event => { const next = providers.find(item => item.id === event.target.value); onChange(next?.id ?? null, next?.models[0] ?? null); }}>
    <option value="">{inheritLabel ?? 'Choose provider'}</option>
    {missingProvider && <option value={connectionId!}>Unavailable · {connectionId}</option>}
    {providers.map(item => <option key={item.id} value={item.id}>{item.provider} · {item.id}</option>)}
  </select></Field><Field label={modelLabel}><select value={model ?? ''} disabled={disabled || !provider} onChange={event => onChange(connectionId ?? null, event.target.value || null)}>
    <option value="">{connectionId ? 'Choose model' : inheritLabel ?? 'Choose provider first'}</option>
    {missingModel && <option value={model!}>Unavailable · {model}</option>}
    {[...new Set(provider?.models ?? [])].map(value => <option key={value} value={value}>{provider?.modelLabels?.[value] ?? value}</option>)}
  </select></Field></>;
}
