import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api, type ModelConnection } from '../../app/api';
import { useUnsavedChanges, useUnsavedNavigation } from '../../app/UnsavedChanges';
import { Field, SettingSection } from './SettingsPrimitives';
import { ProviderModelFields } from './ProviderModelFields';
import { minionProviders } from './minionProviders';

type Selection = { connectionId: string; model: string } | null;
type Defaults = {
  maxDepth: number;
  defaultHarness: 'burrow' | 'codex' | 'claude';
  burrowModel: Selection;
  codexEnabled: boolean;
  claudeEnabled: boolean;
  geminiEnabled: boolean;
  codexModel: Selection;
  claudeModel: Selection;
  geminiModel: Selection;
};
type Settings = Defaults & {
  ok: boolean;
  overrideEnabled?: boolean;
  effective?: Defaults;
};
const fields = [
  'maxDepth',
  'codexModel',
  'claudeModel',
  'geminiModel',
  'burrowModel',
  'codexEnabled',
  'claudeEnabled',
  'geminiEnabled',
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
    typeof d.codexEnabled === 'boolean' &&
    typeof d.claudeEnabled === 'boolean' &&
    typeof d.geminiEnabled === 'boolean' &&
    [d.burrowModel, d.codexModel, d.claudeModel, d.geminiModel].every(
      (m) => m === null || (m && typeof m.connectionId === 'string' && typeof m.model === 'string'),
    );
  if (
    !result ||
    !result.ok ||
    !defaults(result) ||
    (agent && (typeof result.overrideEnabled !== 'boolean' || !defaults(result.effective)))
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
  const [connections, setConnections] = useState<ModelConnection[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState(0);
  const owner = useRef<object | null>(null);
  const saving = useRef(false);
  const navigate = useUnsavedNavigation();
  const path = agentId
    ? `/api/agents/${encodeURIComponent(agentId)}/minion-settings`
    : '/api/settings/minion-settings';
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
        const [settings, catalog] = await Promise.all([
          api<Settings>(path, { signal: controller.signal }),
          api<{ connections: ModelConnection[] }>('/api/settings/model-connections', {
            signal: controller.signal,
          }),
        ]);
        validate(settings, !!agentId);
        if (!Array.isArray(catalog.connections))
          throw new Error('Invalid minion catalog response.');
        if (owner.current !== token) return;
        setSaved(settings);
        setDraft(settings);
        setConnections(catalog.connections);
      } catch (e) {
        if (owner.current === token) setError(String(e));
      }
    })();
    return () => {
      owner.current = null;
      controller.abort();
    };
  }, [path, agentId, retry]);
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
    (['burrow', 'codex', 'claude', 'gemini'] as const).every((h) => {
      if (!(`${h}Model` in patch)) return true;
      const model = draft[`${h}Model`];
      return (
        !model ||
        minionProviders(connections, h).some(
          (p) => p.id === model.connectionId && p.models.includes(model.model),
        )
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
  const nativeEditor = (
    <fieldset disabled={busy || !enabled} className="minion-model-settings">
      {(['codex', 'claude', 'gemini'] as const).map((h) => {
        const label = h === 'codex' ? 'Codex' : h === 'claude' ? 'Claude' : 'Gemini';
        return (
          <div key={h}>
            <h3>{label} defaults</h3>
            <label className="minion-default-enabled">
              <input
                type="checkbox"
                checked={shown?.[`${h}Enabled`] ?? false}
                onChange={(e) => change({ [`${h}Enabled`]: e.target.checked })}
              />
              {label} Enabled
            </label>
            <ProviderModelFields
              providers={minionProviders(connections, h)}
              connectionId={shown?.[`${h}Model`]?.connectionId}
              model={shown?.[`${h}Model`]?.model}
              providerLabel={`${label} provider`}
              modelLabel={`${label} model`}
              inheritLabel="No native model configured"
              onChange={(connectionId, model) =>
                change({
                  [`${h}Model`]: connectionId ? { connectionId, model: model ?? '' } : null,
                })
              }
            />
          </div>
        );
      })}
    </fieldset>
  );
  const defaultEditor = (
    <fieldset disabled={busy || !enabled} className="minion-model-settings">
      <Field label={`Maximum minion depth (${shown?.maxDepth ?? 1})`}>
        <input
          aria-label="Maximum minion depth"
          aria-valuetext={`${shown?.maxDepth ?? 1}: ${['No minions', 'Direct minions', 'Nested minions'][shown?.maxDepth ?? 1]}`}
          type="range"
          min="0"
          max="2"
          step="1"
          value={shown?.maxDepth ?? 1}
          onChange={(e) => change({ maxDepth: Number(e.target.value) })}
        />
        <span className="minion-depth-marks" aria-hidden="true">
          <span>0</span>
          <span>1</span>
          <span>2</span>
        </span>
      </Field>
      <h3>Burrow defaults</h3>
      <ProviderModelFields
        providers={minionProviders(connections, 'burrow')}
        connectionId={shown?.burrowModel?.connectionId}
        model={shown?.burrowModel?.model}
        providerLabel="Burrow provider"
        modelLabel="Burrow model"
        inheritLabel="Inherit parent turn model"
        onChange={(connectionId, model) =>
          change({ burrowModel: connectionId ? { connectionId, model: model ?? '' } : null })
        }
      />
      {!overflowTarget && nativeEditor}
      {!valid && enabled && (
        <p role="alert">Choose an enabled eligible provider and model before saving.</p>
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
              <label className="minion-default-enabled">
                <input
                  type="checkbox"
                  checked={saved.overrideEnabled}
                  disabled={busy}
                  onChange={(e) => {
                    const next = e.target.checked;
                    navigate(() => {
                      void write({ overrideEnabled: next });
                    });
                  }}
                />
                Override global minion settings
              </label>
            )}
            {agentId && !enabled && (
              <p>Inheriting global defaults. Saved overrides are preserved.</p>
            )}
            {defaultEditor}
            {overflowTarget &&
              createPortal(
                <SettingSection title="Native minion defaults">{nativeEditor}</SettingSection>,
                overflowTarget,
              )}
          </>
        )}
      </SettingSection>
    </>
  );
}
