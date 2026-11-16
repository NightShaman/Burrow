import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api, type ModelConnection } from '../../app/api';
import { useUnsavedChanges, useUnsavedNavigation } from '../../app/UnsavedChanges';
import { Field, SettingSection } from './SettingsPrimitives';
import { ProviderModelFields } from './ProviderModelFields';
import { MinionProfiles, minionProviders, type MinionProfile } from './MinionProfiles';

type Selection = MinionProfile['model'];
type Defaults = {
  maxDepth: number;
  defaultHarness: MinionProfile['harness'];
  codexModel: Selection;
  claudeModel: Selection;
  defaultMinionProfileId: string | null;
};
type Overrides = Record<string, Partial<Omit<MinionProfile, 'id'>>>;
type Settings = Defaults & {
  ok: boolean;
  overrideEnabled?: boolean;
  profileOverrides?: Overrides;
  effective?: Defaults;
};
const fields = [
  'maxDepth',
  'defaultHarness',
  'codexModel',
  'claudeModel',
  'defaultMinionProfileId',
] as const;
function canonical(value: unknown): string | undefined {
  return JSON.stringify(value, (_, item) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, item[key]]),
        )
      : item,
  );
}
function validate(result: Settings, agent: boolean) {
  const defaults = (d: Defaults | undefined) =>
    d &&
    [0, 1, 2].includes(d.maxDepth) &&
    ['burrow', 'codex', 'claude'].includes(d.defaultHarness) &&
    (d.defaultMinionProfileId === null || typeof d.defaultMinionProfileId === 'string') &&
    [d.codexModel, d.claudeModel].every(
      (m) => m === null || (m && typeof m.connectionId === 'string' && typeof m.model === 'string'),
    );
  if (
    !result ||
    !result.ok ||
    !defaults(result) ||
    (agent &&
      (typeof result.overrideEnabled !== 'boolean' ||
        !result.profileOverrides ||
        typeof result.profileOverrides !== 'object' ||
        Array.isArray(result.profileOverrides) ||
        !defaults(result.effective)))
  )
    throw new Error('Invalid minion settings response.');
  return result;
}
export function MinionSettings({
  agentId,
  overflowTarget,
}: {
  agentId?: string;
  overflowTarget?: HTMLElement | null;
}) {
  const [saved, setSaved] = useState<Settings | null>(null);
  const [draft, setDraft] = useState<Settings | null>(null);
  const [profiles, setProfiles] = useState<MinionProfile[]>([]);
  const [connections, setConnections] = useState<ModelConnection[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState(0);
  const [revision, setRevision] = useState(0);
  const owner = useRef<object | null>(null);
  const saving = useRef(false);
  const navigate = useUnsavedNavigation();
  const path = agentId
    ? `/api/agents/${encodeURIComponent(agentId)}/minion-settings`
    : '/api/settings/minion-settings';
  const rosterPath = `/api/settings/minions${agentId ? `?agentId=${encodeURIComponent(agentId)}` : ''}`;
  useEffect(() => {
    const token = {};
    owner.current = token;
    const controller = new AbortController();
    setSaved(null);
    setDraft(null);
    setError('');
    setBusy(false);
    saving.current = false;
    void (async () => {
      try {
        // Roster reads reconcile legacy settings before reading the saved default.
        const roster = await api<{ ok: boolean; profiles: MinionProfile[] }>(rosterPath, {
          signal: controller.signal,
        });
        const [settings, catalog] = await Promise.all([
          api<Settings>(path, { signal: controller.signal }),
          api<{ connections: ModelConnection[] }>('/api/settings/model-connections', {
            signal: controller.signal,
          }),
        ]);
        validate(settings, !!agentId);
        if (!roster.ok || !Array.isArray(roster.profiles) || !Array.isArray(catalog.connections))
          throw new Error('Invalid minion catalog response.');
        if (owner.current !== token) return;
        setSaved(settings);
        setDraft(settings);
        setProfiles(roster.profiles);
        setConnections(catalog.connections);
      } catch (e) {
        if (owner.current === token) setError(String(e));
      }
    })();
    return () => {
      owner.current = null;
      controller.abort();
    };
  }, [path, rosterPath, agentId, retry]);
  const patch = Object.fromEntries(
    fields
      .filter((key) => canonical(draft?.[key]) !== canonical(saved?.[key]))
      .map((key) => [key, draft?.[key]]),
  );
  const dirty = !!saved && Object.keys(patch).length > 0;
  async function write(body: object) {
    if (!saved || saving.current) return false;
    const token = owner.current;
    saving.current = true;
    setBusy(true);
    setError('');
    try {
      const result = validate(
        await api<Settings>(path, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
        !!agentId,
      );
      if (
        Object.entries(body).some(
          ([key, value]) => canonical(result[key as keyof Settings]) !== canonical(value),
        )
      )
        throw new Error('Minion settings were not acknowledged.');
      if (owner.current !== token) return false;
      setSaved(result);
      setDraft((current) => {
        const retained = Object.fromEntries(
          fields
            .filter((key) => !(key in body) && canonical(current?.[key]) !== canonical(saved[key]))
            .map((key) => [key, current?.[key]]),
        );
        return { ...result, ...retained };
      });
      return true;
    } catch (e) {
      if (owner.current === token) setError(String(e));
      return false;
    } finally {
      if (owner.current === token) {
        saving.current = false;
        setBusy(false);
      }
    }
  }
  const valid =
    !draft ||
    (['codex', 'claude'] as const).every((h) => {
      if (
        !(`${h}Model` in patch) &&
        !('defaultHarness' in patch && draft.defaultHarness === h && !draft.defaultMinionProfileId)
      )
        return true;
      const model = draft[`${h}Model`];
      return (
        (!model && draft.defaultHarness !== h) ||
        (!!model &&
          minionProviders(connections, h).some(
            (p) => p.id === model.connectionId && p.models.includes(model.model),
          ))
      );
    });
  const save = async () => !dirty || (valid && (await write(patch)));
  useUnsavedChanges({
    dirty,
    busy,
    save,
    discard: () => {
      setDraft(saved);
      setError('');
    },
  });
  const change = (body: Partial<Defaults>) => setDraft((d) => (d ? { ...d, ...body } : d));
  const enabled = !agentId || saved?.overrideEnabled === true;
  const shown = enabled ? draft : saved?.effective;
  const defaultEditor = (
    <fieldset disabled={busy || !enabled} className="minion-model-settings">
      <Field label="Maximum minion depth">
        <select
          value={shown?.maxDepth ?? 1}
          onChange={(e) => change({ maxDepth: Number(e.target.value) })}
        >
          <option value={0}>0 — No minions</option>
          <option value={1}>1 — Direct minions</option>
          <option value={2}>2 — Nested minions</option>
        </select>
      </Field>
      <Field label="Default minion type">
        <select
          value={shown?.defaultHarness ?? 'burrow'}
          onChange={(e) => change({ defaultHarness: e.target.value as Defaults['defaultHarness'] })}
        >
          <option value="burrow">Burrow</option>
          <option value="codex">Codex</option>
          <option value="claude">Claude</option>
        </select>
      </Field>
      {(['codex', 'claude'] as const).map((h) => (
        <ProviderModelFields
          key={h}
          providers={minionProviders(connections, h)}
          connectionId={shown?.[`${h}Model`]?.connectionId}
          model={shown?.[`${h}Model`]?.model}
          providerLabel={`${h === 'codex' ? 'Codex' : 'Claude'} provider`}
          modelLabel={`${h === 'codex' ? 'Codex' : 'Claude'} model`}
          inheritLabel="No native model configured"
          onChange={(connectionId, model) =>
            change({
              [`${h}Model`]: connectionId ? { connectionId, model: model ?? '' } : null,
            })
          }
        />
      ))}
      <Field label="Default minion profile">
        <select
          value={shown?.defaultMinionProfileId ?? ''}
          onChange={(e) => change({ defaultMinionProfileId: e.target.value || null })}
        >
          <option value="">Use default minion type</option>
          {shown?.defaultMinionProfileId &&
            !profiles.some((p) => p.id === shown.defaultMinionProfileId) && (
              <option value={shown.defaultMinionProfileId}>
                Missing profile · {shown.defaultMinionProfileId}
              </option>
            )}
          {profiles.map((p) => (
            <option
              key={p.id}
              value={p.id}
              disabled={!p.enabled && p.id !== shown?.defaultMinionProfileId}
            >
              {p.name}
              {p.enabled ? '' : ' (disabled)'}
            </option>
          ))}
        </select>
      </Field>
      {shown?.defaultMinionProfileId &&
        !profiles.some((p) => p.id === shown.defaultMinionProfileId && p.enabled) && (
          <p role="alert">Default profile is missing or disabled. Spawning is blocked.</p>
        )}
      {!valid && enabled && (
        <p role="alert">Choose an enabled eligible native model before saving.</p>
      )}
      <button
        type="button"
        className="primary"
        disabled={busy || !dirty || !valid}
        onClick={() => void save()}
      >
        Save minion defaults
      </button>
    </fieldset>
  );
  return (
    <>
      <SettingSection title="Minion defaults">
        {error && <p role="alert">{error}</p>}
        {!saved && !error && <p role="status">Loading minion settings…</p>}
        {!saved && error && (
          <button type="button" onClick={() => setRetry((n) => n + 1)}>
            Retry minion settings
          </button>
        )}
        {saved && draft && (
          <>
            {agentId && (
              <label className="minion-profile-enabled">
                <input
                  type="checkbox"
                  checked={saved.overrideEnabled}
                  disabled={busy}
                  onChange={(e) => {
                    const next = e.target.checked;
                    navigate(() => {
                      void (async () => {
                        if (await write({ overrideEnabled: next })) {
                          setRevision((n) => n + 1);
                          const token = owner.current;
                          try {
                            const roster = await api<{ ok: boolean; profiles: MinionProfile[] }>(
                              rosterPath,
                            );
                            if (!roster.ok || !Array.isArray(roster.profiles))
                              throw new Error('Invalid effective minion roster response.');
                            if (owner.current === token) setProfiles(roster.profiles);
                          } catch (e) {
                            if (owner.current === token) setError(String(e));
                          }
                        }
                      })();
                    });
                  }}
                />
                Override global minion settings
              </label>
            )}
            {agentId && !enabled && (
              <p>Inheriting global defaults and specialists. Saved overrides are preserved.</p>
            )}
            {enabled && agentId && overflowTarget
              ? createPortal(defaultEditor, overflowTarget)
              : defaultEditor}
          </>
        )}
      </SettingSection>
      {saved && enabled && (
        <MinionProfiles
          key={`${path}:${revision}`}
          agentId={agentId}
          overflowTarget={overflowTarget}
          profileOverrides={saved.profileOverrides}
          onProfilesChanged={setProfiles}
          onSaveOverride={
            agentId
              ? async (id, body) => {
                  const token = owner.current;
                  const result = await write({
                    profileOverrides: {
                      ...saved.profileOverrides,
                      [id]: { ...saved.profileOverrides?.[id], ...body },
                    },
                  });
                  if (result && owner.current === token)
                    setProfiles((items) =>
                      items.map((p) =>
                        p.id === id
                          ? {
                              ...p,
                              ...body,
                              id: p.id,
                              enabled: p.enabled && (body.enabled ?? p.enabled),
                            }
                          : p,
                      ),
                    );
                  return result;
                }
              : undefined
          }
        />
      )}
    </>
  );
}
