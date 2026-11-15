import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api, type MinionHarness } from '../../app/api';
import { useUnsavedChanges, useUnsavedNavigation } from '../../app/UnsavedChanges';
import { Field } from './SettingsPrimitives';
import { CodexMinionModel } from './CodexMinionModel';
import { ClaudeMinionModel } from './ClaudeMinionModel';

function responseHarness(value: unknown, legacy = false): MinionHarness {
  const result = value as { ok?: unknown; defaultHarness?: unknown } | null;
  if (result?.ok !== true) throw new Error('Invalid minion type response.');
  if (legacy && result.defaultHarness === undefined) return 'burrow';
  if (
    result.defaultHarness !== 'burrow' &&
    result.defaultHarness !== 'codex' &&
    result.defaultHarness !== 'claude'
  )
    throw new Error('Invalid minion type response.');
  return result.defaultHarness;
}

export function MinionTypeSettings({
  resourceId,
  children,
}: {
  resourceId: string;
  children: ReactNode;
}) {
  const [value, setValue] = useState<MinionHarness>('burrow');
  const [baseline, setBaseline] = useState<MinionHarness>('burrow');
  const [state, setState] = useState<'loading' | 'idle' | 'saving' | 'error'>('loading');
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [retry, setRetry] = useState(0);
  const owner = useRef<object | null>(null);
  const busy = useRef(false);
  const navigate = useUnsavedNavigation();
  const path = `/api/agents/${encodeURIComponent(resourceId)}/minion-settings`;
  useEffect(() => {
    const token = {};
    owner.current = token;
    const controller = new AbortController();
    busy.current = false;
    setState('loading');
    setValue('burrow');
    setBaseline('burrow');
    setError('');
    setSaved(false);
    api<unknown>(path, { signal: controller.signal })
      .then((result) => {
        if (owner.current !== token) return;
        const loaded = responseHarness(result, true);
        setValue(loaded);
        setBaseline(loaded);
        setState('idle');
      })
      .catch((cause) => {
        if (owner.current !== token) return;
        setError(
          `Could not load default minion type: ${cause instanceof Error ? cause.message : 'Unknown error'}`,
        );
        setState('error');
      });
    return () => {
      owner.current = null;
      controller.abort();
    };
  }, [path, retry]);
  const save = async (next = value) => {
    if (state !== 'idle' || busy.current || !owner.current) return false;
    if (next === baseline) {
      setError('');
      setSaved(false);
      return true;
    }
    const token = owner.current;
    busy.current = true;
    setState('saving');
    setError('');
    setSaved(false);
    try {
      const result = await api<unknown>(path, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ defaultHarness: next }),
      });
      if (owner.current !== token) return false;
      const accepted = responseHarness(result);
      if (accepted !== next) throw new Error('Minion type was not acknowledged.');
      setValue(accepted);
      setBaseline(accepted);
      setSaved(true);
      return true;
    } catch (cause) {
      if (owner.current === token)
        setError(
          `Could not save default minion type: ${cause instanceof Error ? cause.message : 'Unknown error'}`,
        );
    } finally {
      if (owner.current === token) {
        busy.current = false;
        setState('idle');
      }
    }
    return false;
  };
  const dirty = (state === 'idle' || state === 'saving') && value !== baseline;
  useUnsavedChanges({
    dirty,
    busy: state === 'saving',
    resumeAfterAutosave: true,
    save: () => save(),
    discard: () => {
      setValue(baseline);
      setError('');
      setSaved(false);
    },
  });
  return (
    <>
      <Field label="Default minion type">
        <select
          value={value}
          disabled={state !== 'idle'}
          onChange={(event) => {
            const next = event.target.value as MinionHarness;
            const token = owner.current;
            // Changing type may remove the current model editor. Protect its failed drafts first.
            navigate(() => {
              if (owner.current !== token) return;
              setValue(next);
              void save(next);
            });
          }}
        >
          <option value="burrow">Burrow Minion</option>
          <option value="codex">Codex Minion</option>
          <option value="claude">Claude Minion</option>
        </select>
      </Field>
      {state === 'loading' && <p role="status">Loading default minion type…</p>}
      {state === 'saving' && <p role="status">Saving default minion type…</p>}
      {state === 'error' && (
        <button type="button" className="secondary" onClick={() => setRetry((n) => n + 1)}>
          Retry minion type
        </button>
      )}
      {error && (
        <p className="settings-request-error" role="alert">
          {error}
        </p>
      )}
      {dirty && state === 'idle' && (
        <button type="button" className="secondary" onClick={() => void save()}>
          Retry saving minion type
        </button>
      )}
      {saved && <p role="status">Default minion type saved.</p>}
      {state !== 'loading' &&
        state !== 'error' &&
        (baseline === 'burrow' ? (
          <fieldset className="minion-model-settings" disabled={state === 'saving'}>
            {children}
          </fieldset>
        ) : (
          <fieldset className="minion-model-settings" disabled={state === 'saving'}>
            {baseline === 'claude' ? (
              <ClaudeMinionModel resourceId={resourceId} />
            ) : (
              <CodexMinionModel resourceId={resourceId} />
            )}
          </fieldset>
        ))}
    </>
  );
}
