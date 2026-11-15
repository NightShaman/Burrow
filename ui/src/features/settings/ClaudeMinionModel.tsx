import { useEffect, useRef, useState } from 'react';
import { api, type ModelConnection } from '../../app/api';
import type { SavedProvider } from '../../app/types';
import { useUnsavedChanges } from '../../app/UnsavedChanges';
import { ProviderModelFields } from './ProviderModelFields';

type Selection = { connectionId: string; model: string } | null;
const sameSelection = (left: Selection, right: Selection) =>
  left?.connectionId === right?.connectionId && left?.model === right?.model;

function responseSelection(value: unknown, legacy = false): Selection {
  const response = value as { ok?: unknown; claudeModel?: unknown } | null;
  if (response?.ok !== true) throw new Error('Invalid Claude model response.');
  if (response.claudeModel === null || (legacy && response.claudeModel === undefined)) return null;
  const selection = response.claudeModel as Partial<NonNullable<Selection>> | undefined;
  if (
    !selection ||
    typeof selection.connectionId !== 'string' ||
    !selection.connectionId.trim() ||
    typeof selection.model !== 'string' ||
    !selection.model.trim()
  )
    throw new Error('Invalid Claude model response.');
  return { connectionId: selection.connectionId, model: selection.model };
}

export function ClaudeMinionModel({ resourceId }: { resourceId: string }) {
  const [selection, setSelection] = useState<Selection>(null);
  const [baseline, setBaseline] = useState<Selection>(null);
  const [providers, setProviders] = useState<SavedProvider[]>([]);
  const [state, setState] = useState<'loading' | 'idle' | 'saving' | 'error'>('loading');
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [retry, setRetry] = useState(0);
  const owner = useRef<object | null>(null);
  const busy = useRef(false);
  const path = `/api/agents/${encodeURIComponent(resourceId)}/minion-settings`;
  useEffect(() => {
    const token = {};
    owner.current = token;
    busy.current = false;
    const controller = new AbortController();
    setState('loading');
    setSelection(null);
    setBaseline(null);
    setProviders([]);
    setError('');
    setSaved(false);
    Promise.all([
      api<unknown>(path, { signal: controller.signal }),
      api<{ ok?: boolean; connections: ModelConnection[] }>('/api/settings/model-connections', {
        signal: controller.signal,
      }),
    ])
      .then(([settings, catalog]) => {
        if (owner.current !== token) return;
        const loaded = responseSelection(settings, true);
        if (catalog.ok === false || !Array.isArray(catalog.connections))
          throw new Error('Invalid model connections response.');
        const eligible = catalog.connections.filter(
          (connection) =>
            connection.claudeEligible === true &&
            connection.enabled !== false &&
            (connection.apiType === 'anthropic-lb' ||
              (connection.apiType === 'anthropic-messages' &&
                connection.auth?.type === 'oauth' &&
                ['anthropic', 'claude'].includes(connection.auth?.provider?.toLowerCase() ?? ''))),
        );
        setProviders(
          eligible.map((connection) => ({
            id: connection.id,
            provider: connection.provider,
            apiType: connection.apiType,
            url: connection.baseUrl,
            apiKey: '',
            models: connection.models
              .filter((model) => model.selected !== false)
              .map((model) => model.id),
            modelLabels: Object.fromEntries(
              connection.models.map((model) => [model.id, model.displayName ?? model.id]),
            ),
          })),
        );
        setSelection(loaded);
        setBaseline(loaded);
        setState('idle');
      })
      .catch((cause) => {
        if (owner.current !== token) return;
        setError(
          `Could not load Claude model: ${cause instanceof Error ? cause.message : 'Unknown error'}`,
        );
        setState('error');
      });
    return () => {
      owner.current = null;
      controller.abort();
    };
  }, [path, retry]);
  const valid = (value: Selection) =>
    !value ||
    Boolean(
      providers
        .find((provider) => provider.id === value.connectionId)
        ?.models.includes(value.model),
    );
  const save = async (next = selection) => {
    if (state !== 'idle' || busy.current || !owner.current || !valid(next)) return false;
    if (sameSelection(next, baseline)) return true;
    const token = owner.current;
    busy.current = true;
    setState('saving');
    setError('');
    setSaved(false);
    try {
      const result = await api<unknown>(path, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ claudeModel: next }),
      });
      if (owner.current !== token) return false;
      const accepted = responseSelection(result);
      if (!sameSelection(next, accepted)) throw new Error('Claude model was not acknowledged.');
      setSelection(accepted);
      setBaseline(accepted);
      setSaved(true);
      return true;
    } catch (cause) {
      if (owner.current === token)
        setError(
          `Could not save Claude model: ${cause instanceof Error ? cause.message : 'Unknown error'}`,
        );
    } finally {
      if (owner.current === token) {
        busy.current = false;
        setState('idle');
      }
    }
    return false;
  };
  const dirty = (state === 'idle' || state === 'saving') && !sameSelection(selection, baseline);
  useUnsavedChanges({
    dirty,
    busy: state === 'saving',
    resumeAfterAutosave: true,
    save: () => save(),
    discard: () => {
      setSelection(baseline);
      setError('');
      setSaved(false);
    },
  });
  return (
    <>
      <ProviderModelFields
        providers={providers}
        connectionId={selection?.connectionId}
        model={selection?.model}
        providerLabel="Account"
        modelLabel="Model"
        inheritLabel="Not configured"
        disabled={state !== 'idle'}
        onChange={(connectionId, model) => {
          const next = connectionId ? { connectionId, model: model ?? '' } : null;
          setSelection(next);
          setError('');
          setSaved(false);
          void save(next);
        }}
      />
      {state === 'loading' && <p role="status">Loading Claude model…</p>}
      {state === 'saving' && <p role="status">Saving Claude model…</p>}
      {state === 'idle' && !providers.length && (
        <p className="settings-help">Connect an Anthropic OAuth account in Models.</p>
      )}
      {state === 'idle' &&
        providers.length > 0 &&
        !providers.some((provider) => provider.models.length) && (
          <p className="settings-help">Enable a model on an Anthropic OAuth account in Models.</p>
        )}
      {state === 'idle' && !valid(selection) && (
        <p className="settings-help">
          The selected account or model is unavailable. Choose an enabled model or clear the
          account.
        </p>
      )}
      {state === 'error' && (
        <button type="button" className="secondary" onClick={() => setRetry((value) => value + 1)}>
          Retry Claude model
        </button>
      )}
      {error && (
        <p className="settings-request-error" role="alert">
          {error}
        </p>
      )}
      {dirty && state === 'idle' && valid(selection) && (
        <button type="button" className="secondary" onClick={() => void save()}>
          Retry saving Claude model
        </button>
      )}
      {saved && <p role="status">Claude model saved.</p>}
    </>
  );
}
