import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../app/api';
import type { BoardTask } from './taskDomain';
import type { ProofKey } from './archiveTypes';

type Wait = {
  id: string;
  repository: string;
  workflow: string;
  runId: string;
  runAttempt: number;
  headSha: string;
  checkpoint: string;
  status: 'waiting' | 'matched' | 'resumed' | 'skipped';
  reason: string | null;
  reasonCode: string | null;
  registeredAt: string;
  matchedAt: string | null;
  resumedAt: string | null;
  finishedAt: string | null;
  source: ProofKey;
  trigger: { id: string; conclusion: string; completedAt: string } | null;
  continuation: ProofKey | null;
  outcome: BoardTask['execution'];
};
type Page = { waits: Wait[]; hasMore: boolean; nextCursor: string | null };
const statusLabel = {
  waiting: 'Waiting',
  matched: 'Matched',
  resumed: 'Resumed',
  skipped: 'Skipped',
};
const when = (stamp: string) => new Date(stamp).toLocaleString();
const runRef = (run: ProofKey) => `${run.agentId} / ${run.sessionId} / ${run.runId}`;

function WaitRecord({ wait }: { wait: Wait }) {
  const receipt = wait.outcome;
  const facts = [
    ['Checkpoint', wait.checkpoint],
    ['Reason', wait.reason || wait.reasonCode],
    ['GitHub conclusion', wait.trigger?.conclusion],
    [
      'Continuation outcome',
      receipt?.status ?? (wait.status === 'resumed' ? 'No outcome recorded yet' : null),
    ],
    ['Error', receipt?.error],
    ['Result', receipt?.result?.answerText],
    ['Blockers', receipt?.result?.blockers?.join('\n')],
    ['Commit', wait.headSha],
    ['Triggering event', wait.trigger?.id],
    ['Continuation run', wait.continuation && runRef(wait.continuation)],
    ['Wait ID', wait.id],
    ['Registered by', runRef(wait.source)],
    ['Registered', when(wait.registeredAt)],
    ['GitHub completed', wait.trigger && when(wait.trigger.completedAt)],
    ['Matched', wait.matchedAt && when(wait.matchedAt)],
    ['Resumed', wait.resumedAt && when(wait.resumedAt)],
    ['Finished', wait.finishedAt && when(wait.finishedAt)],
  ];
  return (
    <details className="task-wait-record">
      <summary>
        <strong>{statusLabel[wait.status]}</strong> · {wait.workflow}
        <small>
          {wait.repository} · #{wait.runId} · attempt {wait.runAttempt}
        </small>
      </summary>
      <dl>
        {facts.map(([label, value]) =>
          value ? (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ) : null,
        )}
      </dl>
    </details>
  );
}

/** Reads on the same refresh as task history, but a failed wait read cannot hide the audit trail. */
export function TaskWorkflowWaitHistory({
  base,
  readVersion,
}: {
  base: string;
  readVersion: number;
}) {
  const [page, setPage] = useState<Page | null>(null);
  const [error, setError] = useState<{ message: string; cursor: string | null } | null>(null);
  const [loading, setLoading] = useState(false);
  const request = useRef<AbortController | null>(null);
  const read = useCallback(
    async (cursor: string | null) => {
      request.current?.abort();
      const controller = new AbortController();
      request.current = controller;
      setError(null);
      setLoading(true);
      try {
        const result = await api<Page>(
          `${base}/workflow-waits?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
          { signal: controller.signal },
        );
        if (!Array.isArray(result.waits)) throw new Error('Invalid workflow wait response.');
        if (!controller.signal.aborted)
          setPage((current) => {
            if (!cursor || !current) return result;
            const seen = new Set(current.waits.map((wait) => wait.id));
            return {
              ...result,
              waits: [...current.waits, ...result.waits.filter((wait) => !seen.has(wait.id))],
            };
          });
      } catch (cause) {
        if (!controller.signal.aborted) setError({ message: (cause as Error).message, cursor });
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    },
    [base],
  );
  useEffect(() => {
    void read(null);
    return () => request.current?.abort();
  }, [read, readVersion]);
  if (!page?.waits.length && !error && !loading) return null;
  return (
    <div className="task-workflow-waits">
      {!!page?.waits.length && (
        <>
          <h4>Workflow waits</h4>
          {page.waits.map((wait) => (
            <WaitRecord key={wait.id} wait={wait} />
          ))}
        </>
      )}
      {error && (
        <p role="alert">
          Could not {error.cursor ? 'load older' : 'refresh'} workflow waits: {error.message}{' '}
          <button type="button" onClick={() => void read(error.cursor)}>
            Retry workflow waits
          </button>
        </p>
      )}
      {loading && <p role="status">Loading workflow waits…</p>}
      {!error && page?.hasMore && page.nextCursor && (
        <button type="button" disabled={loading} onClick={() => void read(page.nextCursor)}>
          Load older waits
        </button>
      )}
    </div>
  );
}
