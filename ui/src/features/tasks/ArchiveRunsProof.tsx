import { minionOutcome } from '../../app/minionOutcome';
import { useEffect, useRef, useState, type SyntheticEvent } from 'react';
import ReactMarkdown from 'react-markdown';
import { markdownPlugins, MarkdownImage, MarkdownTable } from '../../app/markdownTables';
import { ProofOutcomeCheck, outcomeMarkdown, publicReleaseCheck } from './ProofOutcomeCheck';
import type { ArchiveRunDetail, ArchiveVerification, WorkflowCompletionEvent } from '../../app/api';
import { archiveRepository, type ArchiveRepository } from './archiveRepository';
import type { EventKey, ProofKey } from './archiveTypes';
import { ProviderRequestHistory } from './ProviderRequestHistory';

function date(value?: string | null) {
  if (!value) return 'No date';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? 'No date'
    : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
        parsed,
      );
}
function duration(run: ArchiveRunDetail) {
  if (!run.startedAt || !run.completedAt) return '—';
  const ms = new Date(run.completedAt).getTime() - new Date(run.startedAt).getTime();
  return Number.isFinite(ms) && ms >= 0
    ? ms < 1000
      ? `${ms}ms`
      : `${(ms / 1000).toFixed(1)}s`
    : '—';
}

type ArchiveRunStatusPresentation = { label: string; detail?: string };

const archiveRunStatus: Record<ArchiveRunDetail['status'], ArchiveRunStatusPresentation> = {
  completed: { label: 'Completed' },
  warning: { label: 'Warning' },
  failed: { label: 'Failed' },
  unverified: {
    label: 'Unverified',
    detail:
      'A final answer was recorded, but no terminal receipt was captured. Treat this outcome as unverified.',
  },
  incomplete: {
    label: 'Incomplete',
    detail: 'Neither a final answer nor a terminal receipt was captured for this run.',
  },
};

function statusInfo(status: ArchiveRunDetail['status']) {
  return archiveRunStatus[status];
}
type ChildVerification = NonNullable<ArchiveRunDetail['subagents'][number]['verification']>;
const childVerificationStatus: Record<
  ChildVerification['status'],
  { label: string; className: string }
> = {
  passed: { label: 'verification passed', className: 'proof-status-completed' },
  failed: { label: 'verification failed', className: 'proof-status-failed' },
  failed_expected: { label: 'verification failed as expected', className: 'proof-status-warning' },
  not_run: { label: 'verification not run', className: '' },
};
async function copyText(text: string) {
  try {
    if (navigator.clipboard?.writeText && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the synchronous browser fallback for local HTTP.
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
  document.body.append(textarea);
  textarea.select();
  const copied = document.execCommand('copy');
  textarea.remove();
  return copied;
}
function workflowLabel(event: WorkflowCompletionEvent) {
  return [
    `GitHub conclusion: ${event.conclusion || 'Not recorded'}`,
    [
      event.workflow || event.repository,
      event.runId
        ? `#${event.runId}${event.runAttempt ? ` · attempt ${event.runAttempt}` : ''}`
        : '',
    ]
      .filter(Boolean)
      .join(' '),
  ]
    .filter(Boolean)
    .join(' · ');
}
function missingOutcome(run: ArchiveRunDetail) {
  return run.workflowEvent && !run.evidence.verifications.some((item) => item.outcomeCheck)
    ? 'No outcome check recorded.'
    : undefined;
}
function proofMarkdown(run: ArchiveRunDetail) {
  const evidence = (title: string, items: ArchiveVerification[], note?: string) =>
    [
      `### ${title}`,
      ...items.map((item) => {
        const check = title === 'Verification' ? publicReleaseCheck(item) : undefined;
        return check ? outcomeMarkdown(check) : `- **${item.status}** ${item.text}`;
      }),
      note ? `_${note}_` : !items.length ? `_No ${title.toLowerCase()} recorded._` : '',
    ]
      .filter(Boolean)
      .join('\n');
  const timeline = run.timeline.length
    ? run.timeline
        .map(
          (event) => `- **${event.kind.replace('_', ' ')}** (${date(event.ts)}) — ${event.summary}`,
        )
        .join('\n')
    : '_No timeline evidence recorded._';
  const compression = run.context?.compression;
  return [
    `# ${run.objective || run.runId}`,
    `- Agent: ${run.agentName || run.agentId}`,
    `- ${run.workflowEvent ? 'Burrow handling' : 'Status'}: ${statusInfo(run.status).label}`,
    run.workflowEvent ? `- ${workflowLabel(run.workflowEvent)}` : '',
    `- Started: ${date(run.startedAt)}`,
    `- Completed: ${date(run.completedAt)}`,
    `- Duration: ${duration(run)}`,
    `- Decision: ${run.decision || 'No terminal decision'}`,
    '',
    run.request ? `## Request\n\n${run.request}` : '',
    run.finalAnswer ? `## Final outcome\n\n${run.finalAnswer}` : '',
    '## Counts',
    `- Observations: ${run.counts.observations}`,
    `- Changes: ${run.counts.changes}`,
    `- Verifications: ${run.counts.verifications}`,
    `- Unresolved: ${run.counts.unresolved}`,
    `- Tool activity: ${run.counts.toolActivities}`,
    `- Minions: ${run.counts.subagents}`,
    '',
    evidence('Actions / changes', run.evidence.changes),
    '',
    evidence('Verification', run.evidence.verifications, missingOutcome(run)),
    '',
    evidence('Unresolved', run.evidence.unresolved),
    '',
    '## Timeline',
    timeline,
    run.context
      ? `\n## Context / compression proof\n- Estimated tokens: ${String(run.context.budget?.estimatedTokens ?? '—')}\n- Context window: ${String(run.context.budget?.contextWindow ?? '—')}\n- Pressure: ${String(run.context.budget?.pressure ?? '—')}\n- Attachments: ${run.context.attachments}\n- Compression: ${compression?.label || 'Not recorded'}\n- Turns summarized: ${compression?.summarizedTurnCount == null ? '—' : String(compression.summarizedTurnCount)}\n\n${compression?.detail || 'No compression decision was recorded for this older run.'}`
      : '',
  ]
    .filter(Boolean)
    .join('\n');
}
function EvidenceList({
  title,
  items,
  note,
}: {
  title: string;
  items: ArchiveVerification[];
  note?: string;
}) {
  return (
    <section className="proof-section">
      <h3>
        {title}
        <span>{items.length}</span>
      </h3>
      {items.length ? (
        <ul>
          {items.map((item, index) => {
            const check = title === 'Verification' ? publicReleaseCheck(item) : undefined;
            return (
              <li key={`${item.text}-${index}`}>
                {check ? (
                  <ProofOutcomeCheck check={check} />
                ) : (
                  <>
                    <strong className={`proof-status proof-status-${item.status}`}>
                      {item.status}
                    </strong>
                    <span>{item.text}</span>
                  </>
                )}
              </li>
            );
          })}
        </ul>
      ) : null}
      {note || !items.length ? (
        <p className="proof-muted">{note ?? `No ${title.toLowerCase()} recorded.`}</p>
      ) : null}
    </section>
  );
}
function FullToolEvidence({
  run,
  repository = archiveRepository,
}: {
  run: ArchiveRunDetail;
  onOpenEvent?: (event: EventKey) => void;
  repository?: ArchiveRepository;
}) {
  const request = useRef<AbortController | null>(null);
  const [trace, setTrace] = useState<unknown>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => () => request.current?.abort(), []);
  const load = () => {
    request.current?.abort();
    const abort = new AbortController();
    request.current = abort;
    setLoading(true);
    setError('');
    repository
      .loadRunTrace(run.runId, run.agentId, run.sessionId, abort.signal)
      .then((value) => {
        if (!abort.signal.aborted) setTrace(value);
      })
      .catch((cause) => {
        if (!abort.signal.aborted)
          setError(cause instanceof Error ? cause.message : 'Could not load tool evidence.');
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
  };
  const toggle = (event: SyntheticEvent<HTMLDetailsElement>) => {
    if (event.currentTarget.open && trace === undefined && !loading) load();
  };
  return (
    <details className="proof-full-evidence" onToggle={toggle}>
      <summary>
        <span>
          <strong>Full redacted tool evidence</strong>
          <small>Loaded from the retained run trace on demand</small>
        </span>
        <span className="proof-expand-label">Expand</span>
      </summary>
      <div className="proof-full-evidence-body" aria-live="polite">
        {loading ? (
          <p className="proof-muted">Loading retained trace…</p>
        ) : error ? (
          <div className="proof-evidence-error">
            <p>Could not load full tool evidence: {error}</p>
            <button type="button" onClick={load}>
              Retry
            </button>
          </div>
        ) : trace === undefined ? null : (
          <>
            <p className="proof-evidence-note">
              Sensitive values are redacted by the trace API. Evidence is shown exactly as returned.
            </p>
            <pre>
              <code>{JSON.stringify(trace, null, 2) ?? 'null'}</code>
            </pre>
          </>
        )}
      </div>
    </details>
  );
}
function TriggeringEventButton({
  event,
  onOpenEvent,
}: {
  event: EventKey;
  onOpenEvent: (event: EventKey) => void;
}) {
  return (
    <button type="button" className="archive-copy-button" onClick={() => onOpenEvent(event)}>
      Open triggering event
    </button>
  );
}
function ProofDetail({
  onOpenEvent,
  run,
  repository = archiveRepository,
}: {
  run: ArchiveRunDetail;
  onOpenEvent?: (event: EventKey) => void;
  repository?: ArchiveRepository;
}) {
  const compression = run.context?.compression;
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const copy = async () => {
    const didCopy = await copyText(proofMarkdown(run));
    setCopyState(didCopy ? 'copied' : 'failed');
    window.setTimeout(() => setCopyState('idle'), 1500);
  };
  return (
    <div className="archive-proof-detail">
      <header className="proof-detail-header">
        <div>
          <span className="eyebrow">
            {run.agentName || run.agentId} ·{' '}
            {run.workflowEvent
              ? `Burrow handling: ${statusInfo(run.status).label}`
              : statusInfo(run.status).label}
          </span>
          <h2>{run.objective || run.runId}</h2>
          {run.workflowEvent && (
            <p className="proof-workflow-result archive-related-record">
              <span>{workflowLabel(run.workflowEvent)}</span>
              {run.workflowEvent.id && onOpenEvent && (
                <TriggeringEventButton
                  event={{ agentId: run.agentId, id: run.workflowEvent.id }}
                  onOpenEvent={onOpenEvent}
                />
              )}
            </p>
          )}
          <p>
            {date(run.startedAt)} → {date(run.completedAt)} · {duration(run)} ·{' '}
            {run.decision || 'No terminal decision'}
          </p>
        </div>
        <div className="proof-detail-actions">
          <button
            type="button"
            className="archive-copy-button"
            onClick={copy}
            aria-label={copyState === 'copied' ? 'Proof copied' : 'Copy proof as Markdown'}
          >
            <span aria-hidden="true">{copyState === 'copied' ? '✓' : '⧉'}</span>
            {copyState === 'copied'
              ? 'Copied'
              : copyState === 'failed'
                ? 'Copy failed'
                : 'Copy proof'}
          </button>
          <span className={`proof-status-badge proof-status-${run.status}`}>
            {statusInfo(run.status).label}
          </span>
        </div>
      </header>
      {statusInfo(run.status).detail ? (
        <section
          className="proof-status-notice"
          aria-label={`${statusInfo(run.status).label} run status`}
        >
          <strong>{statusInfo(run.status).label}</strong>
          <p>{statusInfo(run.status).detail}</p>
        </section>
      ) : null}
      {run.request ? (
        <section className="proof-final">
          <h3>Your request</h3>
          <ReactMarkdown
            remarkPlugins={markdownPlugins}
            components={{ table: MarkdownTable, img: MarkdownImage }}
          >
            {run.request}
          </ReactMarkdown>
        </section>
      ) : null}
      {run.finalAnswer ? (
        <section className="proof-final">
          <h3>Final outcome</h3>
          <ReactMarkdown
            remarkPlugins={markdownPlugins}
            components={{ table: MarkdownTable, img: MarkdownImage }}
          >
            {run.finalAnswer}
          </ReactMarkdown>
        </section>
      ) : null}
      <div className="proof-counts">
        {Object.entries({
          Observations: run.counts.observations,
          Changes: run.counts.changes,
          Verifications: run.counts.verifications,
          Unresolved: run.counts.unresolved,
          'Tool activity': run.counts.toolActivities,
          Minions: run.counts.subagents,
        }).map(([label, count]) => (
          <div key={label}>
            <strong>{count}</strong>
            <span>{label}</span>
          </div>
        ))}
      </div>
      <div className="proof-evidence-grid">
        <EvidenceList title="Actions / changes" items={run.evidence.changes} />
        <EvidenceList
          title="Verification"
          items={run.evidence.verifications}
          note={missingOutcome(run)}
        />
        <EvidenceList title="Unresolved" items={run.evidence.unresolved} />
      </div>
      <FullToolEvidence repository={repository} key={occurrenceKey(run)} run={run} />
      <ProviderRequestHistory
        key={`provider-requests:${occurrenceKey(run)}`}
        run={run}
        repository={repository}
      />
      <section className="proof-section">
        <h3>
          Timeline<span>{run.timeline.length}</span>
        </h3>
        {run.timeline.length ? (
          <ol className="proof-timeline">
            {run.timeline.map((event, index) => (
              <li key={`${event.kind}-${event.ts}-${index}`}>
                <span
                  className={`proof-timeline-dot proof-status-${event.status}`}
                  aria-hidden="true"
                />
                <div>
                  <strong>{event.kind.replace('_', ' ')}</strong>
                  <time>{date(event.ts)}</time>
                  <p>{event.summary}</p>
                </div>
              </li>
            ))}
          </ol>
        ) : (
          <p className="proof-muted">No timeline evidence recorded.</p>
        )}
      </section>
      {run.context ? (
        <section className="proof-section">
          <h3>Context / compression proof</h3>
          <div className="proof-context-grid">
            <div>
              <span>Estimated tokens</span>
              <strong>{String(run.context.budget?.estimatedTokens ?? '—')}</strong>
            </div>
            <div>
              <span>Context window</span>
              <strong>{String(run.context.budget?.contextWindow ?? '—')}</strong>
            </div>
            <div>
              <span>Pressure</span>
              <strong>{String(run.context.budget?.pressure ?? '—')}</strong>
            </div>
            <div>
              <span>Attachments</span>
              <strong>{run.context.attachments}</strong>
            </div>
            <div>
              <span>Compression</span>
              <strong>{compression?.label || 'Not recorded'}</strong>
            </div>
            <div>
              <span>Turns summarized</span>
              <strong>
                {compression?.summarizedTurnCount == null
                  ? '—'
                  : String(compression.summarizedTurnCount)}
              </strong>
            </div>
          </div>
          <p className="proof-muted">
            {compression?.detail || 'No compression decision was recorded for this older run.'}
          </p>
        </section>
      ) : null}
      {run.subagents.length ? (
        <section className="proof-section">
          <h3>
            Linked minions<span>{run.subagents.length}</span>
          </h3>
          <div className="proof-subagents">
            {run.subagents.map((child) => {
              const verification = child.verification;
              const outcome = minionOutcome(child.status, child.result);
              const execution = outcome.label
                ? `Minion ${outcome.label}`
                : child.status === 'succeeded'
                  ? 'Minion completed'
                  : `Minion ${child.status || 'status unknown'}`;
              return (
                <article key={child.id}>
                  <strong>{child.label || child.purpose}</strong>
                  <span
                    className={
                      verification ? childVerificationStatus[verification.status].className : ''
                    }
                  >
                    {execution}
                    {verification ? ` · ${childVerificationStatus[verification.status].label}` : ''}
                  </span>
                  {verification ? (
                    <div className="proof-child-outcome">
                      <b>
                        {verification.actionRequired ? 'Action required' : 'No action required'}
                      </b>
                      {verification.check ? <span>Check: {verification.check}</span> : null}
                      <span>Observed: {verification.observed}</span>
                    </div>
                  ) : child.result?.summary ? (
                    <div className="proof-child-summary">
                      <ReactMarkdown
                        remarkPlugins={markdownPlugins}
                        components={{ table: MarkdownTable, img: MarkdownImage }}
                      >
                        {child.result.summary}
                      </ReactMarkdown>
                    </div>
                  ) : null}
                  <small>
                    {outcome.reason ? <span>{outcome.reason}</span> : null}
                    {child.result
                      ? `${child.result.evidence || 0} findings · ${child.result.changedFiles || 0} changes`
                      : 'No minion result recorded'}{' '}
                    · {child.trace?.runId ? `Trace ${String(child.trace.runId)}` : child.id}
                  </small>
                </article>
              );
            })}
          </div>
        </section>
      ) : null}
    </div>
  );
}

const occurrenceKey = (run: ProofKey) => JSON.stringify([run.agentId, run.sessionId, run.runId]);

function mergeOccurrences(current: ArchiveRunDetail[], incoming: ArchiveRunDetail[]) {
  const seen = new Set(current.map(occurrenceKey));
  return [
    ...current,
    ...incoming.filter((run) => {
      const key = occurrenceKey(run);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
  ];
}

type ProofSelection = ProofKey & { eventId?: string };
type ProofShelfProps = {
  selectedAgent: string;
  search: string;
  repository?: ArchiveRepository;
  initialProof?: ProofSelection;
  onOpenEvent?: (event: EventKey) => void;
};
export function ArchiveRunsProof(props: ProofShelfProps) {
  return <ProofShelf key={props.selectedAgent} {...props} />;
}
function ProofShelf({
  selectedAgent,
  search,
  repository = archiveRepository,
  initialProof,
  onOpenEvent,
}: ProofShelfProps) {
  const readerRef = useRef<HTMLElement>(null);
  const [linkedEntry] = useState(Boolean(initialProof));
  useEffect(() => {
    if (linkedEntry) readerRef.current?.focus();
  }, [linkedEntry]);
  const moreRequest = useRef<AbortController | null>(null);
  const [runs, setRuns] = useState<ArchiveRunDetail[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [moreLoading, setMoreLoading] = useState(false);
  const [moreError, setMoreError] = useState('');
  const [selected, setSelected] = useState<ProofSelection | undefined>(initialProof);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const query = search.trim();
  useEffect(() => {
    const abort = new AbortController();
    setLoading(true);
    setMoreLoading(false);
    setError('');
    setMoreError('');
    setRuns([]);
    setNextCursor(null);
    setHasMore(false);
    const load = () => {
      void repository
        .listRuns(selectedAgent, abort.signal, null, query)
        .then((page) => {
          if (abort.signal.aborted) return;
          setRuns(mergeOccurrences([], page.items));
          setNextCursor(page.nextCursor);
          setHasMore(page.hasMore);
        })
        .catch((cause) => {
          if (!abort.signal.aborted)
            setError(cause instanceof Error ? cause.message : 'Could not load archive runs.');
        })
        .finally(() => {
          if (!abort.signal.aborted) setLoading(false);
        });
    };
    const timer = query ? window.setTimeout(load, 180) : null;
    if (timer === null) load();
    return () => {
      if (timer !== null) window.clearTimeout(timer);
      abort.abort();
      moreRequest.current?.abort();
    };
  }, [selectedAgent, repository, query]);
  const loadMore = () => {
    if (loading || !hasMore || !nextCursor || moreLoading) return;
    const cursor = nextCursor;
    const abort = new AbortController();
    moreRequest.current = abort;
    setMoreLoading(true);
    setMoreError('');
    repository
      .listRuns(selectedAgent, abort.signal, cursor, query)
      .then((page) => {
        if (abort.signal.aborted) return;
        setRuns((current) => mergeOccurrences(current, page.items));
        setNextCursor(page.nextCursor);
        setHasMore(page.hasMore);
      })
      .catch((cause) => {
        if (!abort.signal.aborted)
          setMoreError(cause instanceof Error ? cause.message : 'Could not load more runs.');
      })
      .finally(() => {
        if (!abort.signal.aborted) setMoreLoading(false);
      });
  };
  return (
    <div className="archive-split-view archive-proof-view">
      <section className="archive-results-pane" aria-label="Archive proof runs">
        <div className="archive-pane-heading">
          <span className="eyebrow">Runs</span>
          <strong>{runs.length} runs</strong>
        </div>
        <div className="archive-session-list">
          {loading ? (
            <section className="archive-empty-state">
              <div className="archive-empty-mark">⌁</div>
              <div>
                <h3>Gathering proof.</h3>
                <p>Loading archived run outcomes.</p>
              </div>
            </section>
          ) : null}
          {error ? (
            <section className="archive-empty-state archive-error">
              <div className="archive-empty-mark">!</div>
              <div>
                <h3>Could not load archive runs.</h3>
                <p>{error}</p>
              </div>
            </section>
          ) : null}
          {!loading && !error && !runs.length ? (
            <section className="archive-empty-state">
              <div className="archive-empty-mark">⌁</div>
              <div>
                <h3>No proof runs found.</h3>
                <p>Try another agent or search.</p>
              </div>
            </section>
          ) : null}
          {!loading && !error
            ? runs.map((run) => (
                <button
                  type="button"
                  className={`archive-session-card proof-run-card${selected && occurrenceKey(selected) === occurrenceKey(run) ? ' selected' : ''}`}
                  key={occurrenceKey(run)}
                  aria-pressed={!!selected && occurrenceKey(selected) === occurrenceKey(run)}
                  onClick={() =>
                    setSelected({
                      runId: run.runId,
                      agentId: run.agentId,
                      sessionId: run.sessionId,
                    })
                  }
                >
                  <div className="archive-session-main">
                    <div className="archive-session-meta">
                      <span>{run.agentName || run.agentId}</span>
                      <span>{date(run.completedAt || run.startedAt)}</span>
                    </div>
                    <h3>{run.objective || run.runId}</h3>
                    <p>
                      {statusInfo(run.status).label} · {duration(run)} · {run.counts.toolActivities}{' '}
                      tool activities · {run.counts.unresolved} unresolved
                    </p>
                  </div>
                  <div className="archive-session-side">
                    <strong className={`proof-status-text proof-status-${run.status}`}>
                      {statusInfo(run.status).label}
                    </strong>
                    <span>
                      {run.counts.observations + run.counts.changes + run.counts.verifications}{' '}
                      evidence
                    </span>
                  </div>
                </button>
              ))
            : null}
          {moreError ? <p role="alert">{moreError}</p> : null}
          {hasMore ? (
            <button
              type="button"
              className="archive-load-more"
              disabled={moreLoading}
              onClick={loadMore}
            >
              {moreLoading ? 'Loading more runs…' : 'Load more runs'}
            </button>
          ) : null}
        </div>
      </section>
      <section className="archive-reader-pane" aria-label="Run proof" tabIndex={-1} ref={readerRef}>
        {selected ? (
          <ProofReader
            key={JSON.stringify([occurrenceKey(selected), selected.eventId])}
            target={selected}
            repository={repository}
            onOpenEvent={onOpenEvent}
          />
        ) : (
          <section className="archive-empty-state archive-reader-placeholder">
            <div className="archive-empty-mark">⌁</div>
            <div>
              <h3>Select a proof run.</h3>
              <p>Choose a run to inspect its outcome, evidence, context, and linked minions.</p>
            </div>
          </section>
        )}
      </section>
    </div>
  );
}

function ProofReader({
  target,
  repository,
  onOpenEvent,
}: {
  target: ProofSelection;
  repository: ArchiveRepository;
  onOpenEvent: ProofShelfProps['onOpenEvent'];
}) {
  const [run, setRun] = useState<ArchiveRunDetail | null>(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    setRun(null);
    setError('');
    repository
      .loadRun(target.runId, target.agentId, abort.signal, target.sessionId)
      .then((detail) => {
        if (abort.signal.aborted) return;
        if (!detail || occurrenceKey(detail) !== occurrenceKey(target))
          throw new Error('Run details did not match the selected session.');
        if (target.eventId && detail.workflowEvent?.id !== target.eventId)
          throw new Error('This run does not match the triggering event.');
        setRun(detail);
      })
      .catch((cause: unknown) => {
        if (!abort.signal.aborted)
          setError(
            cause instanceof Error && 'status' in cause && cause.status === 404
              ? 'This run is no longer in the archive.'
              : cause instanceof Error
                ? cause.message
                : 'Could not read the run evidence.',
          );
      });
    return () => abort.abort();
  }, [repository, target, retry]);
  return (
    <div className="archive-content-body archive-reader-body">
      {run ? (
        <ProofDetail run={run} repository={repository} onOpenEvent={onOpenEvent} />
      ) : error ? (
        <section className="archive-empty-state archive-error" role="alert">
          <div className="archive-empty-mark">!</div>
          <div>
            <h3>Could not open this run.</h3>
            <p>{error}</p>
            <span className="archive-related-record">
              <button
                type="button"
                className="archive-copy-button"
                onClick={() => setRetry((value) => value + 1)}
              >
                Retry
              </button>
              {target.eventId && onOpenEvent && (
                <TriggeringEventButton
                  event={{ agentId: target.agentId, id: target.eventId }}
                  onOpenEvent={onOpenEvent}
                />
              )}
            </span>
          </div>
        </section>
      ) : (
        <section className="archive-empty-state" role="status">
          <div className="archive-empty-mark">⌁</div>
          <div>
            <h3>Opening proof.</h3>
            <p>Reading the run evidence.</p>
          </div>
        </section>
      )}
    </div>
  );
}
