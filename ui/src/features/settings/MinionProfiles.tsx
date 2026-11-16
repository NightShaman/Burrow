import './minionProfiles.css';
import { useEffect, useRef, useState } from 'react';
import { api, type ModelConnection } from '../../app/api';
import type { SavedProvider } from '../../app/types';
import { useUnsavedChanges, useUnsavedNavigation } from '../../app/UnsavedChanges';
import { Field, SettingSection } from './SettingsPrimitives';
import { ProviderModelFields } from './ProviderModelFields';
import { createPortal } from 'react-dom';

export type MinionProfile = {
  id: string;
  name: string;
  harness: 'burrow' | 'codex' | 'claude';
  enabled: boolean;
  model: { connectionId: string; model: string } | null;
  executionHostId: string | null;
  instructions: string;
};
function isProfile(value: unknown): value is MinionProfile {
  if (!value || typeof value !== 'object') return false;
  const p = value as MinionProfile;
  return (
    typeof p.id === 'string' &&
    !!p.id.trim() &&
    typeof p.name === 'string' &&
    !!p.name.trim() &&
    ['burrow', 'codex', 'claude'].includes(p.harness) &&
    typeof p.enabled === 'boolean' &&
    (p.executionHostId === null ||
      (typeof p.executionHostId === 'string' && !!p.executionHostId)) &&
    typeof p.instructions === 'string' &&
    (p.model === null ||
      (!!p.model &&
        typeof p.model.connectionId === 'string' &&
        !!p.model.connectionId &&
        typeof p.model.model === 'string' &&
        !!p.model.model))
  );
}
const empty = (): MinionProfile => ({
  id: '',
  name: '',
  harness: 'burrow',
  enabled: true,
  model: null,
  executionHostId: null,
  instructions: '',
});
export function minionProviders(
  connections: ModelConnection[],
  harness: MinionProfile['harness'],
): SavedProvider[] {
  return connections
    .filter(
      (c) =>
        c.enabled !== false &&
        (harness === 'burrow' ||
          (harness === 'codex'
            ? (c.apiType === 'openai-lb' && c.codexEligible === true) ||
              (['openai-responses', 'openai-chat-completions'].includes(c.apiType) &&
                c.auth?.type?.toLowerCase() === 'oauth' &&
                c.auth?.provider?.toLowerCase() === 'openai')
            : (c.apiType === 'anthropic-lb' && c.claudeEligible === true) ||
              (c.apiType === 'anthropic-messages' &&
                c.auth?.type?.toLowerCase() === 'oauth' &&
                ['anthropic', 'claude'].includes(c.auth?.provider?.toLowerCase() ?? '')))),
    )
    .map((c) => ({
      id: c.id,
      provider: c.provider,
      apiType: c.apiType,
      url: c.baseUrl,
      apiKey: '',
      models: c.models.filter((m) => m.selected !== false).map((m) => m.id),
      modelLabels: Object.fromEntries(c.models.map((m) => [m.id, m.displayName ?? m.id])),
    }));
}
export function MinionProfiles({
  agentId,
  defaultOnly = false,
  overflowTarget,
  profileOverrides,
  onSaveOverride,
  onProfilesChanged,
}: {
  agentId?: string;
  defaultOnly?: boolean;
  onProfilesChanged?: (profiles: MinionProfile[]) => void;
  overflowTarget?: HTMLElement | null;
  profileOverrides?: Record<string, Partial<Omit<MinionProfile, 'id'>>>;
  onSaveOverride?: (id: string, patch: Partial<Omit<MinionProfile, 'id'>>) => Promise<boolean>;
}) {
  const [legacyIds, setLegacyIds] = useState<string[]>([]);
  const [globallyDisabled, setGloballyDisabled] = useState<string[]>([]);
  const [profiles, setProfiles] = useState<MinionProfile[]>([]);
  const [connections, setConnections] = useState<ModelConnection[]>([]);
  const [draft, setDraft] = useState<MinionProfile | null>(null);
  const [baseline, setBaseline] = useState<MinionProfile | null>(null);
  const [defaultId, setDefaultId] = useState<string | null>(null);
  const [savedDefault, setSavedDefault] = useState<string | null>(null);
  const [state, setState] = useState<'loading' | 'idle' | 'saving' | 'error'>('loading');
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [hosts, setHosts] = useState<{ id: string; connected: boolean }[]>([]);
  const [hostError, setHostError] = useState('');
  const [hostLoading, setHostLoading] = useState(false);
  const [hostRetry, setHostRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setHosts([]);
    setHostError('');
    setHostLoading(!defaultOnly);
    if (!defaultOnly)
      void (async () => {
        try {
          type Gateway = { gatewayId: string; connected?: boolean; revoked?: boolean };
          const [trust, live] = await Promise.all([
            api<{ ok: boolean; gateways: Gateway[] }>('/api/mods/node-goblin/gateway-trust', {
              signal: controller.signal,
            }),
            api<{ ok: boolean; gateways: Gateway[] }>('/api/mods/node-goblin/gateways', {
              signal: controller.signal,
            }),
          ]);
          if (
            !trust.ok ||
            !live.ok ||
            !Array.isArray(trust.gateways) ||
            !Array.isArray(live.gateways) ||
            [...trust.gateways, ...live.gateways].some(
              (g) => !g || typeof g.gatewayId !== 'string' || !g.gatewayId,
            )
          )
            throw new Error('Invalid execution host catalog response.');
          if (active)
            setHosts(
              trust.gateways
                .filter(
                  (g, i, all) =>
                    (!g.revoked ||
                      live.gateways.some((l) => l.gatewayId === g.gatewayId && l.connected)) &&
                    all.findIndex((other) => other.gatewayId === g.gatewayId) === i,
                )
                .map((g) => ({
                  id: g.gatewayId,
                  connected: live.gateways.some(
                    (l) => l.gatewayId === g.gatewayId && l.connected === true,
                  ),
                })),
            );
        } catch (e) {
          if (active) setHostError(`Execution host catalog failed: ${String(e)}`);
        } finally {
          if (active) setHostLoading(false);
        }
      })();
    return () => {
      active = false;
      controller.abort();
    };
  }, [defaultOnly, hostRetry]);
  const owner = useRef<object | null>(null);
  const busy = useRef(false);
  const navigate = useUnsavedNavigation();
  const contextQuery = agentId ? `?agentId=${encodeURIComponent(agentId)}` : '';
  const path = `/api/settings/minions${onSaveOverride ? '' : contextQuery}`;
  const settingsPath = agentId
    ? `/api/agents/${encodeURIComponent(agentId)}/minion-settings`
    : '/api/settings/minion-settings';
  useEffect(() => {
    const token = {};
    owner.current = token;
    busy.current = false;
    const controller = new AbortController();
    setState('loading');
    setError('');
    setDraft(null);
    setBaseline(null);
    void (async () => {
      try {
        // Read profiles first: this may migrate the agent's legacy default.
        const roster = await api<{ ok: boolean; profiles: MinionProfile[] }>(path, {
          signal: controller.signal,
        });
        if (!roster.ok || !Array.isArray(roster.profiles) || !roster.profiles.every(isProfile))
          throw new Error('Invalid minion roster response.');
        const effective = onSaveOverride
          ? await api<{ ok: boolean; profiles: MinionProfile[] }>(
              `/api/settings/minions${contextQuery}`,
              { signal: controller.signal },
            )
          : roster;
        if (
          !effective.ok ||
          !Array.isArray(effective.profiles) ||
          !effective.profiles.every(isProfile)
        )
          throw new Error('Invalid effective minion roster response.');
        const legacy = effective.profiles.filter(
          (p) => !roster.profiles.some((shared) => shared.id === p.id),
        );
        const [settings, catalog] = await Promise.all([
          defaultOnly
            ? api<{ ok: boolean; defaultMinionProfileId?: string | null }>(settingsPath, {
                signal: controller.signal,
              })
            : Promise.resolve({ ok: true, defaultMinionProfileId: null }),
          defaultOnly
            ? Promise.resolve({ connections: [] as ModelConnection[] })
            : api<{ connections: ModelConnection[] }>('/api/settings/model-connections', {
                signal: controller.signal,
              }),
        ]);
        if (owner.current !== token) return;
        if (!settings.ok || !Array.isArray(catalog.connections))
          throw new Error('Invalid minion settings response.');
        setGloballyDisabled(roster.profiles.filter((p) => !p.enabled).map((p) => p.id));
        setLegacyIds(legacy.map((p) => p.id));
        const items = [
          ...roster.profiles.map((p) => ({
            ...p,
            ...profileOverrides?.[p.id],
            id: p.id,
            enabled: p.enabled && (profileOverrides?.[p.id]?.enabled ?? p.enabled),
          })),
          ...legacy,
        ];
        setProfiles(items);
        setConnections(catalog.connections);
        setDefaultId(settings.defaultMinionProfileId ?? null);
        setSavedDefault(settings.defaultMinionProfileId ?? null);
        setDraft(items[0] ?? null);
        setBaseline(items[0] ?? null);
        setState('idle');
      } catch (e) {
        if (owner.current === token) {
          setError(String(e));
          setState('error');
        }
      }
    })();
    return () => {
      owner.current = null;
      controller.abort();
    };
  }, [path, settingsPath, defaultOnly, retry]);
  const providers = minionProviders(connections, draft?.harness ?? 'burrow');
  const valid =
    !!draft &&
    !!draft.name.trim() &&
    (draft.model
      ? providers.some(
          (p) => p.id === draft.model?.connectionId && p.models.includes(draft.model.model),
        )
      : draft.harness === 'burrow');
  const dirty = defaultOnly
    ? defaultId !== savedDefault
    : JSON.stringify(draft) !== JSON.stringify(baseline);
  async function save() {
    if (state !== 'idle' || busy.current || (!defaultOnly && !valid)) return false;
    if (!dirty) return true;
    const token = owner.current;
    busy.current = true;
    setState('saving');
    setError('');
    try {
      if (defaultOnly) {
        const result = await api<{ ok: boolean; defaultMinionProfileId: string | null }>(
          settingsPath,
          {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ defaultMinionProfileId: defaultId }),
          },
        );
        if (!result.ok || result.defaultMinionProfileId !== defaultId)
          throw new Error('Default was not acknowledged.');
        if (owner.current !== token) return false;
        setSavedDefault(result.defaultMinionProfileId);
      } else if (draft) {
        const { id, ...body } = draft;
        if (onSaveOverride && !legacyIds.includes(id)) {
          const patch = Object.fromEntries(
            Object.entries(body).filter(
              ([key, value]) =>
                JSON.stringify(value) !== JSON.stringify(baseline?.[key as keyof MinionProfile]),
            ),
          );
          if (!(await onSaveOverride(id, patch))) return false;
          if (owner.current !== token) return false;
          setProfiles((items) => items.map((p) => (p.id === id ? draft : p)));
          setBaseline(draft);
          onProfilesChanged?.(profiles.map((p) => (p.id === id ? draft : p)));
          return true;
        }
        const result = await api<{ ok: boolean; profile: MinionProfile }>(
          `/api/settings/minions${id ? `/${encodeURIComponent(id)}` : ''}${contextQuery}`,
          {
            method: id ? 'PUT' : 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ ...body, name: body.name.trim() }),
          },
        );
        if (
          !result.ok ||
          !isProfile(result.profile) ||
          (id && result.profile.id !== id) ||
          (!id && profiles.some((p) => p.id === result.profile.id)) ||
          result.profile.name !== body.name.trim() ||
          result.profile.harness !== body.harness ||
          result.profile.enabled !== body.enabled ||
          result.profile.instructions !== body.instructions ||
          result.profile.executionHostId !== body.executionHostId ||
          result.profile.model?.connectionId !== body.model?.connectionId ||
          result.profile.model?.model !== body.model?.model
        )
          throw new Error('Profile was not acknowledged.');
        if (owner.current !== token) return false;
        setProfiles((items) =>
          id ? items.map((p) => (p.id === id ? result.profile : p)) : [...items, result.profile],
        );
        onProfilesChanged?.(
          id
            ? profiles.map((p) => (p.id === id ? result.profile : p))
            : [...profiles, result.profile],
        );
        setDraft(result.profile);
        setBaseline(result.profile);
      }
      return true;
    } catch (e) {
      if (owner.current === token) setError(String(e));
      return false;
    } finally {
      if (owner.current === token) {
        busy.current = false;
        setState('idle');
      }
    }
  }
  useUnsavedChanges({
    dirty,
    busy: state === 'saving',
    save,
    discard: () => {
      setDraft(baseline);
      setDefaultId(savedDefault);
      setError('');
    },
  });
  const change = (patch: Partial<MinionProfile>) => setDraft((d) => (d ? { ...d, ...patch } : d));
  const selectedDefault = profiles.find((p) => p.id === defaultId);
  function renderEditor() {
    const content = (
      <SettingSection title={onSaveOverride ? 'Specialist override' : 'Specialist profile'}>
        {draft && (
          <fieldset disabled={state !== 'idle'} className="minion-model-settings">
            <Field label="Name">
              <input value={draft.name} onChange={(e) => change({ name: e.target.value })} />
            </Field>
            <label className="minion-profile-enabled">
              <input
                type="checkbox"
                checked={draft.enabled}
                disabled={!!onSaveOverride && globallyDisabled.includes(draft.id)}
                onChange={(e) => change({ enabled: e.target.checked })}
              />
              Enabled
            </label>
            <Field label="Harness">
              <select
                value={draft.harness}
                onChange={(e) =>
                  change({ harness: e.target.value as MinionProfile['harness'], model: null })
                }
              >
                <option value="burrow">Burrow</option>
                <option value="codex">Codex</option>
                <option value="claude">Claude</option>
              </select>
            </Field>
            <ProviderModelFields
              providers={providers}
              connectionId={draft.model?.connectionId}
              model={draft.model?.model}
              inheritLabel={
                draft.harness === 'burrow'
                  ? 'Inherit caller model'
                  : 'Choose eligible account or pool'
              }
              onChange={(connectionId, model) =>
                change({ model: connectionId ? { connectionId, model: model ?? '' } : null })
              }
            />
            {draft.harness !== 'burrow' && !valid && (
              <p className="settings-help">
                Native minions require an enabled eligible model or pool.
              </p>
            )}
            <Field label="Execution host">
              <select
                value={draft.executionHostId ?? ''}
                onChange={(e) => change({ executionHostId: e.target.value || null })}
              >
                <option value="">Inherit caller execution context</option>
                <option value="local">Core / local (explicit)</option>
                {draft.executionHostId &&
                  draft.executionHostId !== 'local' &&
                  !hosts.some((h) => h.id === draft.executionHostId) && (
                    <option value={draft.executionHostId}>
                      {draft.executionHostId} — unavailable
                    </option>
                  )}
                {hosts
                  .filter((h) => h.id !== 'local')
                  .map((h) => (
                    <option key={h.id} value={h.id}>
                      {h.id} — {h.connected ? 'Connected' : 'Disconnected'}
                    </option>
                  ))}
              </select>
            </Field>
            {hostLoading && <p role="status">Loading execution hosts…</p>}
            {hostError && (
              <>
                <p role="alert">{hostError}</p>
                <button
                  type="button"
                  className="secondary"
                  onClick={() => setHostRetry((n) => n + 1)}
                >
                  Retry execution hosts
                </button>
              </>
            )}
            {draft.executionHostId &&
              draft.executionHostId !== 'local' &&
              !hostLoading &&
              !hostError &&
              !hosts.some((h) => h.id === draft.executionHostId && h.connected) && (
                <p role="alert" className="settings-help">
                  The pinned host is unavailable. Spawning is blocked until it reconnects or you
                  choose another host.
                </p>
              )}
            <Field label="Standing instructions">
              <textarea
                value={draft.instructions}
                onChange={(e) => change({ instructions: e.target.value })}
              />
            </Field>
          </fieldset>
        )}
        <button
          type="button"
          className="primary"
          disabled={state !== 'idle' || !dirty || (!defaultOnly && !valid)}
          onClick={() => void save()}
        >
          {state === 'saving' ? 'Saving…' : defaultOnly ? 'Save default minion' : 'Save minion'}
        </button>
      </SettingSection>
    );
    return overflowTarget ? createPortal(content, overflowTarget) : content;
  }
  return (
    <SettingSection title={defaultOnly ? 'Default minion' : 'Minions'}>
      {state === 'loading' && <p role="status">Loading minions…</p>}
      {error && (
        <p role="alert" className="settings-request-error">
          {error}
        </p>
      )}
      {state === 'error' && (
        <button type="button" className="secondary" onClick={() => setRetry((n) => n + 1)}>
          Retry minions
        </button>
      )}
      {state !== 'loading' && state !== 'error' && (
        <>
          {defaultOnly ? (
            <>
              <Field label="Default minion profile">
                <select
                  disabled={state !== 'idle'}
                  value={defaultId ?? ''}
                  onChange={(e) => setDefaultId(e.target.value || null)}
                >
                  <option value="">No profile (legacy settings)</option>
                  {defaultId && !selectedDefault && (
                    <option value={defaultId}>Missing profile · {defaultId}</option>
                  )}
                  {profiles.map((p) => (
                    <option key={p.id} value={p.id} disabled={!p.enabled && p.id !== defaultId}>
                      {p.name}
                      {!p.enabled ? ' (disabled)' : ''}
                    </option>
                  ))}
                </select>
              </Field>
              {defaultId && (!selectedDefault || !selectedDefault.enabled) && (
                <p role="alert">
                  The default profile is {selectedDefault ? 'disabled' : 'missing'}. Spawning is
                  blocked; no fallback will be used.
                </p>
              )}
            </>
          ) : (
            <>
              <p className="settings-help">
                {onSaveOverride
                  ? 'Saved specialist overrides apply only to this agent. Globally disabled specialists remain disabled.'
                  : 'Named specialists are shared across agents. All enabled specialists remain available, regardless of the default.'}
              </p>
              <nav className="minion-profile-list" aria-label="Minion profiles">
                {profiles.map((p) => (
                  <button
                    type="button"
                    key={p.id}
                    className={draft?.id === p.id ? 'active' : ''}
                    aria-pressed={draft?.id === p.id}
                    onClick={() =>
                      navigate(() => {
                        setDraft(p);
                        setBaseline(p);
                        setError('');
                      })
                    }
                  >
                    {p.name}
                    {p.enabled ? '' : ' (disabled)'}
                  </button>
                ))}
                {!onSaveOverride && (
                  <button
                    type="button"
                    className="secondary"
                    disabled={state !== 'idle'}
                    onClick={() =>
                      navigate(() => {
                        setDraft(empty());
                        setBaseline(null);
                        setError('');
                      })
                    }
                  >
                    Add minion
                  </button>
                )}
              </nav>
              {!draft && <p>No minion profiles. Add one to get started.</p>}
              {renderEditor()}
            </>
          )}
          {defaultOnly && (
            <button
              type="button"
              className="primary"
              disabled={state !== 'idle' || !dirty || (!defaultOnly && !valid)}
              onClick={() => void save()}
            >
              {state === 'saving' ? 'Saving…' : defaultOnly ? 'Save default minion' : 'Save minion'}
            </button>
          )}
        </>
      )}
    </SettingSection>
  );
}
