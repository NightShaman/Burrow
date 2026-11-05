import './continuitySettings.css';
import { useUnsavedChanges } from '../../app/UnsavedChanges';
import { DreamPromotionSettings } from './DreamPromotionSettings';
import { providerOptionLabel } from './ProviderModelFields';
import { useEffect, useRef, useState } from 'react';
import { api } from '../../app/api';
import { usePolling } from '../../app/usePolling';
import type { SavedProvider } from '../../app/types';
import { Field, SettingSection } from './SettingsPrimitives';

type Status = {
  enabled: boolean;
  conversationEnabled?: boolean;
  lexical?: {
    ready: boolean;
    processed: number;
    stage: string;
    lastError: string | null;
  };
  conversations?: {
    enabled: boolean;
    total: number;
    indexed: number;
    pending: number;
    failed: number;
    lastError: string | null;
    storage: string;
    dimensions: number | null;
    generation: string;
    epoch: string;
    backfillComplete: boolean;
    dirty: number;
  };
  connectionId: string | null;
  model: string | null;
  generation: string;
  total: string;
  indexed: string;
  pending: string;
  failed: string;
  storage: string;
  lastError: string | null;
};
type Discovery = {
  connectionId: string;
  provider: string;
  models: { id: string; name: string }[];
  capabilityDisclosure: string;
};
const root = '/api/settings/brain-embeddings';
const json = (method: string, body?: unknown) => ({
  method,
  headers: { 'content-type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

export function BrainEmbeddingSettings({ savedProviders }: { savedProviders: SavedProvider[] }) {
  const [baseline, setBaseline] = useState({
    enabled: false,
    conversationEnabled: false,
    connectionId: '',
    model: '',
  });
  const [status, setStatus] = useState<Status | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [conversationEnabled, setConversationEnabled] = useState(false);
  const [connectionId, setConnectionId] = useState('');
  const [model, setModel] = useState('');
  const [discovery, setDiscovery] = useState<Discovery | null>(null);
  const [error, setError] = useState('');
  const [discoveryError, setDiscoveryError] = useState('');
  const [tested, setTested] = useState('');
  const [busy, setBusy] = useState('load');
  // Immutable tickets fence every completion against mount, draft and status epochs.
  const owner = useRef<object | null>(null);
  const epoch = useRef(0);
  const generation = useRef<string | null>(null);
  const ticket = () => ({
    owner: owner.current,
    epoch: epoch.current,
    generation: generation.current,
  });
  const current = (t: ReturnType<typeof ticket>) =>
    t.owner !== null &&
    t.owner === owner.current &&
    t.epoch === epoch.current &&
    t.generation === generation.current;
  const accept = (s: Status) => {
    generation.current = `${s.generation}:${s.conversations?.generation ?? ''}:${s.conversations?.epoch ?? ''}`;
    setStatus(s);
  };
  const edit = () => {
    epoch.current++;
    setTested('');
    setError('');
    setBusy('');
  };
  useEffect(() => {
    owner.current = {};
    const t = ticket();
    api<Status>(root)
      .then((s) => {
        if (!current(t)) return;
        accept(s);
        setEnabled(s.enabled);
        setConversationEnabled(s.conversationEnabled ?? false);
        setConnectionId(s.connectionId ?? '');
        setModel(s.model ?? '');
        setBaseline({
          enabled: s.enabled,
          conversationEnabled: s.conversationEnabled ?? false,
          connectionId: s.connectionId ?? '',
          model: s.model ?? '',
        });
        setBusy('');
      })
      .catch(() => {
        if (current(t)) {
          setError(
            'Could not load embedding settings. Reopen this section to retry. Brains CRUD remains available.',
          );
          setBusy('');
        }
      });
    return () => {
      owner.current = null;
      epoch.current++;
    };
  }, []);
  useEffect(() => {
    setDiscovery(null);
    setDiscoveryError('');
    if (!connectionId) return;
    const t = ticket();
    let cancelled = false;
    api<Discovery>(`${root}/models?connectionId=${encodeURIComponent(connectionId)}`)
      .then((s) => {
        if (!cancelled && current(t) && s.connectionId === connectionId) setDiscovery(s);
      })
      .catch(() => {
        if (!cancelled && current(t))
          setDiscoveryError(
            'Embedding discovery unavailable. Check the connection and provider capabilities, or enter a model ID and test it.',
          );
      });
    return () => {
      cancelled = true;
    };
  }, [connectionId]);
  usePolling(
    async (cancelled, signal) => {
      const t = ticket();
      try {
        const s = await api<Status>(root, { signal });
        if (!cancelled() && current(t)) {
          accept(s);
        }
      } catch {
        if (!cancelled() && current(t))
          setError(
            'Could not refresh indexing status. Polling will retry; Brains CRUD remains available.',
          );
      }
    },
    3000,
    !!status && !busy,
    `${busy}:${status?.generation ?? ''}:${status?.conversations?.generation ?? ''}:${status?.conversations?.epoch ?? ''}`,
  );
  const request = async (action: 'save' | 'test' | 'reindex'): Promise<boolean> => {
    if (busy || !status) return false;
    if (
      action === 'save' &&
      (enabled || conversationEnabled) &&
      (!selected || (manual && !tested))
    ) {
      setError(
        'Choose a connection and embedding model or deployment ID; test a manual ID before enabling indexing.',
      );
      return false;
    }
    epoch.current++;
    const t = ticket();
    setBusy(action);
    setError('');
    const selection = { connectionId: connectionId || null, model: model.trim() || null };
    try {
      if (action === 'test') {
        const result = await api<{ ok: true; dimensions: number }>(
          `${root}/test`,
          json('POST', selection),
        );
        if (current(t)) setTested(`Test successful · ${result.dimensions} dimensions`);
      } else {
        const s = await api<Status>(
          action === 'save' ? root : `${root}/reindex`,
          json(
            action === 'save' ? 'PUT' : 'POST',
            action === 'save'
              ? {
                  enabled,
                  conversationEnabled,
                  ...(enabled || conversationEnabled || (selection.connectionId && selection.model)
                    ? selection
                    : { connectionId: null, model: null }),
                }
              : undefined,
          ),
        );
        if (!current(t)) return false;
        accept(s);
        if (action === 'save') {
          const accepted = {
            enabled: s.enabled,
            conversationEnabled: s.conversationEnabled ?? false,
            connectionId: s.connectionId ?? '',
            model: s.model ?? '',
          };
          setBaseline(accepted);
          setEnabled(accepted.enabled);
          setConversationEnabled(accepted.conversationEnabled);
          setConnectionId(accepted.connectionId);
          setModel(accepted.model);
        }
      }
      return true;
    } catch {
      if (current(t))
        setError(
          `Could not ${action} embeddings. Check the saved connection, supported embedding model and provider availability, then retry. Saved memories are unchanged.`,
        );
      return false;
    } finally {
      if (t.owner === owner.current && t.epoch === epoch.current) setBusy('');
    }
  };
  useUnsavedChanges({
    dirty:
      !!status &&
      (enabled !== baseline.enabled ||
        conversationEnabled !== baseline.conversationEnabled ||
        connectionId !== baseline.connectionId ||
        model !== baseline.model),
    busy: !!busy,
    save: () => request('save'),
    discard: () => {
      edit();
      setEnabled(baseline.enabled);
      setConversationEnabled(baseline.conversationEnabled);
      setConnectionId(baseline.connectionId);
      setModel(baseline.model);
      setTested('');
      setError('');
    },
  });
  const selected = !!connectionId && !!model.trim();
  const indexingEnabled = enabled || conversationEnabled;
  const manual = !discovery?.models.some((m) => m.id === model.trim());
  const locked = !!busy;
  return (
    <SettingSection title="Continuity">
      <DreamPromotionSettings />
      <div className="curator-card">
        <label>
          <input
            type="checkbox"
            checked={enabled}
            disabled={locked || !status}
            onChange={(e) => {
              edit();
              setEnabled(e.target.checked);
            }}
          />{' '}
          Enable Brains embeddings globally
        </label>
        <label>
          <input
            type="checkbox"
            checked={conversationEnabled}
            disabled={locked || !status}
            aria-describedby="conversation-embedding-help"
            onChange={(e) => {
              edit();
              setConversationEnabled(e.target.checked);
            }}
          />{' '}
          Index conversation history for session search
        </label>
        <p id="conversation-embedding-help" className="settings-help">
          Off by default, including upgrades. When enabled, the selected provider receives saved
          conversation passages for background indexing. Session search retrieves original dialogue;
          embeddings help find it, not verify current facts or grant authorization. Both indexes
          share the provider and model below.
        </p>
        <div className="field-pair provider-model-fields">
          <Field label="Provider">
            <select
              value={connectionId}
              disabled={locked || !status}
              onChange={(e) => {
                edit();
                setConnectionId(e.target.value);
                setModel('');
              }}
            >
              <option value="">Choose a connection</option>
              {connectionId && !savedProviders.some((p) => p.id === connectionId) && (
                <option value={connectionId}>Configured connection (unavailable)</option>
              )}
              {savedProviders.map((p) => (
                <option key={p.id} value={p.id}>
                  {providerOptionLabel(savedProviders, p)}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Model">
            <select
              value={discovery?.models.some((m) => m.id === model) ? model : ''}
              disabled={locked || !discovery}
              onChange={(e) => {
                edit();
                setModel(e.target.value);
              }}
            >
              <option value="">Choose an embedding model or enter ID below</option>
              {discovery?.models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </Field>
        </div>
        {discovery && (
          <p className="hint">
            {discovery.capabilityDisclosure}
            {!discovery.models.length &&
              ' No embedding models advertised. Use a manual model or deployment ID and test.'}
          </p>
        )}
        {discoveryError && (
          <p role="alert" className="settings-request-error">
            {discoveryError}
          </p>
        )}
        <Field label="Embedding model or deployment ID (manual fallback)">
          <input
            value={model}
            disabled={locked || !status}
            onChange={(e) => {
              edit();
              setModel(e.target.value);
            }}
          />
        </Field>
        <div className="continuity-embedding-actions">
          <button type="button" disabled={locked || !selected} onClick={() => void request('test')}>
            Test embedding model
          </button>
          <button
            type="button"
            className="primary"
            disabled={locked || !status || (indexingEnabled && (!selected || (manual && !tested)))}
            onClick={() => void request('save')}
          >
            Save embedding settings
          </button>
          <button
            type="button"
            disabled={locked || !(status?.enabled || status?.conversationEnabled)}
            onClick={() => void request('reindex')}
          >
            Reindex memories and conversations
          </button>
        </div>
        {tested && <p role="status">{tested}</p>}
        {busy && (
          <p role="status">
            {busy === 'load' ? 'Loading settings…' : `${busy} request in progress…`}
          </p>
        )}
        {status && (
          <p role="status">
            Brains {status.enabled ? 'enabled' : 'disabled'} · Generation {status.generation} ·
            Indexed {status.indexed} / {status.total} · Pending {status.pending} · Failed{' '}
            {status.failed} · Storage {status.storage}.
          </p>
        )}
        {status?.lastError && (
          <p role="alert">
            Brains indexing error: {status.lastError}. Check provider availability and model
            support; failed jobs retry automatically.
          </p>
        )}
        {status?.lexical && (
          <p role="status">
            {status.lexical.ready
              ? 'Session search ready'
              : `Session search preparing history · ${status.lexical.processed} occurrences processed`}
          </p>
        )}
        {status?.lexical?.lastError && (
          <p role="alert">Session search preparation error: {status.lexical.lastError}</p>
        )}
        {status && (
          <p role="status">
            Conversations {status.conversationEnabled ? 'enabled' : 'disabled'}
            {status.conversations && (
              <>
                {' · Indexed '}
                {status.conversations.indexed} / {status.conversations.total}
                {' · Pending '}
                {status.conversations.pending}
                {' · Failed '}
                {status.conversations.failed}
                {status.conversationEnabled &&
                  (!status.conversations.backfillComplete || status.conversations.dirty > 0) &&
                  ' · Catching up'}
              </>
            )}
          </p>
        )}
        {status?.conversations?.lastError && (
          <p role="alert">
            Conversation indexing error: {status.conversations.lastError}. Check provider
            availability and model support; failed jobs retry automatically.
          </p>
        )}
        {error && (
          <p role="alert" className="settings-request-error">
            {error}
          </p>
        )}
        <p className="settings-help">
          {status?.lexical?.ready === false
            ? 'Session search becomes available when history preparation completes. Embedding indexing continues in the background.'
            : 'Partial coverage remains searchable lexically. Indexing runs in the background.'}{' '}
          Status refreshes every 3 seconds. Manage saved memories independently in the Brains
          workspace. Saved memory is not verification of current runtime truth.
        </p>
      </div>
    </SettingSection>
  );
}
