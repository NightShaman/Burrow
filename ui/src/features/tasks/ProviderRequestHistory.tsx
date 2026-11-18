import { useEffect, useRef, useState } from 'react';
import type { ArchiveRunDetail } from '../../app/api';
import type { ArchiveRepository, ProviderRequest } from './archiveRepository';

type Run = Pick<ArchiveRunDetail, 'runId' | 'agentId' | 'sessionId'>;
type History = Awaited<ReturnType<ArchiveRepository['listProviderRequests']>>;
type Detail = Awaited<ReturnType<ArchiveRepository['loadProviderRequest']>>;
type Load<T> = { status: 'loading' } | { status: 'error' } | { status: 'loaded'; value: T };

const stateLabel = {
  available: 'Available',
  expired: 'Expired',
  not_captured: 'Not captured',
  unavailable: 'Unavailable',
};

function callLabel(item: ProviderRequest) {
  const call = item.modelCall == null ? 'Model call' : `Call ${item.modelCall}`;
  return item.continuation ? `${call} · continuation` : call;
}

function RequestPicker({
  label,
  run,
  repository,
  requests,
}: {
  label: string;
  run: Run;
  repository: ArchiveRepository;
  requests: ProviderRequest[];
}) {
  const pending = useRef<AbortController | null>(null);
  const [selectedId, setSelectedId] = useState('');
  const [detail, setDetail] = useState<Load<Detail> | null>(null);
  useEffect(() => () => pending.current?.abort(), []);

  const load = (id: string) => {
    pending.current?.abort();
    setSelectedId(id);
    setDetail(null);
    const selected = requests.find((request) => request.requestId === id);
    if (!selected || selected.state !== 'available') return;
    const abort = new AbortController();
    pending.current = abort;
    setDetail({ status: 'loading' });
    void repository.loadProviderRequest(run, id, abort.signal).then(
      (value) => {
        if (!abort.signal.aborted) setDetail({ status: 'loaded', value });
      },
      () => {
        if (!abort.signal.aborted) setDetail({ status: 'error' });
      },
    );
  };

  const selected = requests.find((request) => request.requestId === selectedId);
  const item = detail?.status === 'loaded' ? detail.value : selected;
  const body =
    detail?.status === 'loaded' && detail.value.state === 'available'
      ? detail.value.body
      : undefined;
  const ts = item?.ts ? new Date(item.ts) : null;

  return (
    <div className="proof-request-picker">
      <label>
        <strong>{label}</strong>
        <select value={selectedId} onChange={(event) => load(event.target.value)}>
          <option value="">Select a request</option>
          {requests.map((request) => (
            <option key={request.requestId} value={request.requestId}>
              {callLabel(request)} · {request.requestId} · {stateLabel[request.state]}
            </option>
          ))}
        </select>
      </label>
      {item ? (
        <p className="proof-muted proof-request-meta">
          <code>{item.requestId}</code>
          {[
            item.provider,
            item.model,
            item.api,
            ts && !Number.isNaN(ts.getTime()) ? ts.toLocaleString() : null,
          ]
            .filter(Boolean)
            .join(' · ')}
        </p>
      ) : null}
      {detail?.status === 'loading' ? (
        <p className="proof-muted" role="status">
          Loading redacted body…
        </p>
      ) : detail?.status === 'error' ? (
        <div className="proof-evidence-error">
          <p role="alert">Could not load this request body.</p>
          <button className="archive-copy-button" type="button" onClick={() => load(selectedId)}>
            Retry body
          </button>
        </div>
      ) : body !== undefined ? (
        <pre tabIndex={0} aria-label={`${label} redacted body`}>
          <code>{typeof body === 'string' ? body : JSON.stringify(body, null, 2)}</code>
        </pre>
      ) : item ? (
        <p className="proof-muted" role="status">
          {item.state === 'expired'
            ? 'This capture has expired.'
            : item.state === 'not_captured'
              ? 'No body was captured for this request.'
              : 'The request body is unavailable.'}
        </p>
      ) : null}
    </div>
  );
}

export function ProviderRequestHistory({
  run,
  repository,
}: {
  run: Run;
  repository: ArchiveRepository;
}) {
  const pending = useRef<AbortController | null>(null);
  const [history, setHistory] = useState<Load<History> | null>(null);
  const [comparing, setComparing] = useState(false);
  useEffect(() => () => pending.current?.abort(), []);

  const load = () => {
    pending.current?.abort();
    const abort = new AbortController();
    pending.current = abort;
    setHistory({ status: 'loading' });
    void repository.listProviderRequests(run, abort.signal).then(
      (value) => {
        if (!abort.signal.aborted) setHistory({ status: 'loaded', value });
      },
      () => {
        if (!abort.signal.aborted) setHistory({ status: 'error' });
      },
    );
  };
  const loaded = history?.status === 'loaded' ? history.value : null;

  return (
    <details
      className="proof-full-evidence proof-provider-history"
      onToggle={(event) => {
        if (event.currentTarget.open && !history) load();
      }}
    >
      <summary>
        <span>
          <strong>Redacted provider requests</strong>
        </span>
        <span className="proof-expand-label" aria-hidden="true">
          Expand
        </span>
      </summary>
      <div className="proof-full-evidence-body proof-request-history-body">
        {history?.status === 'loading' ? (
          <p className="proof-muted" role="status">
            Loading provider request history…
          </p>
        ) : history?.status === 'error' ? (
          <div className="proof-evidence-error">
            <p role="alert">Could not load provider request history.</p>
            <button className="archive-copy-button" type="button" onClick={load}>
              Retry history
            </button>
          </div>
        ) : history?.status === 'loaded' && loaded === null ? (
          <p className="proof-muted" role="status">
            Provider request history is not available for this trace on the connected Core.
          </p>
        ) : loaded && loaded.requests.length === 0 ? (
          <p className="proof-muted" role="status">
            No provider requests were recorded for this run.
          </p>
        ) : loaded ? (
          <>
            <div className="proof-request-toolbar">
              <p className="proof-muted">
                {loaded.requests.length} {loaded.requests.length === 1 ? 'request' : 'requests'} ·
                Bodies kept for {loaded.retentionDays} days
              </p>
              {loaded.requests.length > 1 ? (
                <button
                  className="archive-copy-button"
                  type="button"
                  aria-pressed={comparing}
                  onClick={() => setComparing((active) => !active)}
                >
                  Compare requests
                </button>
              ) : null}
            </div>
            <div className="proof-request-grid" data-comparing={comparing}>
              <RequestPicker
                label={comparing ? 'Before tool call' : 'Request'}
                run={run}
                repository={repository}
                requests={loaded.requests}
              />
              {comparing ? (
                <RequestPicker
                  label="After tool call"
                  run={run}
                  repository={repository}
                  requests={loaded.requests}
                />
              ) : null}
            </div>
          </>
        ) : null}
      </div>
    </details>
  );
}
