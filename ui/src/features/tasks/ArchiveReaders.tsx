import { useMemo, useEffect, useLayoutEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { markdownPlugins, MarkdownImage, MarkdownTable } from '../../app/markdownTables';
import { generatedArtifactPath, textFromChatValue, type SessionTurn } from '../../app/api';
import { chatInputLabel, reconcileChatInputs } from '../chat/chatInputs';
import { ChatMessage } from '../chat/ChatTranscript';
import { archiveDate, archiveSessionDate } from './archiveDerivations';
import type { ArchiveDetail, ArchiveSession, ContinuityCardGroup, DreamArchiveGroup, DreamGroupSummary, DreamDiary, DreamPhaseAttempt } from './archiveTypes';

export function formatArchiveDate(value: string | null) {
  const date = archiveDate(value);
  return date ? new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' }).format(date) : 'No date';
}

const uuidSessionId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function archiveSessionOrigin(session: ArchiveSession): string {
  const source = session.sourceSessionId;
  if (source === 'default' || session.sessionId === 'default') return 'Default';
  if (source && !uuidSessionId.test(source)) return source;
  return '';
}

export function archiveSessionTimestamp(session: ArchiveSession): string {
  const date = archiveDate(archiveSessionDate(session));
  return date ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date) : 'No date';
}

export function archiveSessionContext(session: ArchiveSession): string {
  const origin = archiveSessionOrigin(session);
  return [origin ? `From ${origin}` : '', session.archiveSnapshot === 'reset' ? 'Reset' : '', archiveSessionTimestamp(session)].filter(Boolean).join(' · ');
}

export function archiveSessionTitle(session: ArchiveSession) {
  const title = session.title?.trim();
  const generatedReset = session.archiveSnapshot === 'reset' && title === 'default · Reset';
  if (title && title !== 'default' && !uuidSessionId.test(title) && !generatedReset) return title;
  const origin = archiveSessionOrigin(session);
  return [origin || 'Conversation', session.archiveSnapshot === 'reset' ? 'Reset' : '', archiveSessionTimestamp(session)].filter(Boolean).join(' · ');
}

function formatTurnDate(value?: string) {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime())
    ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date)
    : '';
}

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

function archiveTurnSpeaker(turn: SessionTurn, sessionAgentName: string, agentNames: ReadonlyMap<string, string>, operatorName: string) {
  const role = (turn.role || '').toLowerCase();
  if (['user', 'operator', 'human'].includes(role)) {
    if (turn.metadata?.source === 'workflow-event') return `GitHub · ${turn.metadata.completionEvent?.workflow?.trim() || 'workflow event'}`;
    const delegatedParentId = turn.metadata?.parentAgentId;
    return delegatedParentId ? agentNames.get(delegatedParentId) || delegatedParentId : turn.metadata?.kind === 'subagent-delegated-task' ? 'Parent agent' : operatorName || 'Operator';
  }
  const senderId = turn.metadata?.fromAgentId;
  return turn.metadata?.fromAgentName || (senderId ? agentNames.get(senderId) || senderId : '') || sessionAgentName || 'Agent';
}

export function archiveTurnText(turn: SessionTurn, sessionAgentName: string, agentNames: ReadonlyMap<string, string> = new Map(), operatorName = 'Operator') {
  const speaker = archiveTurnSpeaker(turn, sessionAgentName, agentNames, operatorName);
  const text = textFromChatValue(turn.content);
  const date = [formatTurnDate(turn.ts), turn.metadata?.chatInput ? chatInputLabel(turn.metadata.chatInput) : ''].filter(Boolean).join(' · ');
  const attachments = (turn.metadata?.attachments ?? []).map((item) => `- Attachment: ${item.name} (${item.type})${item.artifactPath ? ` — /api/attachments/${item.artifactPath}` : ''}`).join('\n');
  const artifacts = (turn.metadata?.outputArtifacts ?? []).map((item) => `- Generated ${item.kind}: ${item.name || item.storageReference || 'artifact'}${item.storageReference ? ` — ${generatedArtifactPath(turn.metadata?.fromAgentId || '', item.storageReference)}` : ''}`).join('\n');
  const body = [text, attachments, artifacts].filter(Boolean).join('\n\n');
  return body ? `## ${speaker}${date ? ` · ${date}` : ''}\n\n${body}` : '';
}

function ArchiveReaderToolbar({ eyebrow, title, detail, value, copyLabel }: { eyebrow: string; title: string; detail: string; value: string; copyLabel: string }) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');

  useEffect(() => {
    if (copyState === 'idle') return;
    const timer = window.setTimeout(() => setCopyState('idle'), 1500);
    return () => window.clearTimeout(timer);
  }, [copyState]);

  const copy = async () => setCopyState(await copyText(value) ? 'copied' : 'failed');
  return <div className="archive-content-toolbar archive-reader-toolbar"><div><span className="eyebrow">{eyebrow}</span><h2>{title}</h2><p>{detail}</p></div><button type="button" className="archive-copy-button" onClick={() => void copy()} disabled={!value} aria-label={copyState === 'copied' ? 'Copied' : `${copyLabel} as Markdown`}><span aria-hidden="true">{copyState === 'copied' ? '✓' : '⧉'}</span>{copyState === 'copied' ? 'Copied' : copyState === 'failed' ? 'Copy failed' : copyLabel}</button></div>;
}

function DreamCopyButton({ text }: { text: string }) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');

  useEffect(() => {
    if (copyState === 'idle') return;
    const timer = window.setTimeout(() => setCopyState('idle'), 1500);
    return () => window.clearTimeout(timer);
  }, [copyState]);

  const copy = async () => setCopyState(await copyText(text) ? 'copied' : 'failed');
  return <button type="button" className="archive-card-copy-button" onClick={() => void copy()} aria-label={copyState === 'copied' ? 'Copied dream' : 'Copy dream'} title={copyState === 'copied' ? 'Copied' : copyState === 'failed' ? 'Copy failed' : 'Copy dream'}>{copyState === 'copied' ? '✓' : '⧉'}<span className="sr-only">{copyState === 'copied' ? 'Copied' : 'Copy dream'}</span></button>;
}

function LoadingState({ title, detail }: { title: string; detail: string }) {
  return <section className="archive-empty-state"><div className="archive-empty-mark" aria-hidden="true">⌁</div><div><h3>{title}</h3><p>{detail}</p></div></section>;
}

function ErrorState({ title, error }: { title: string; error: string }) {
  return <section className="archive-empty-state archive-error"><div className="archive-empty-mark" aria-hidden="true">!</div><div><h3>{title}</h3><p>{error}</p></div></section>;
}

function Placeholder({ title, detail }: { title: string; detail: string }) {
  return <section className="archive-empty-state archive-reader-placeholder"><div className="archive-empty-mark" aria-hidden="true">⌁</div><div><h3>{title}</h3><p>{detail}</p></div></section>;
}

export function ChatArchiveReader({ session, detail, loading, error, earlierLoading, earlierError, historyUnavailable, onLoadEarlier, onRestart, agentNames = new Map(), operatorName = 'Operator', attachmentAgentId }: { session: ArchiveSession | null; detail: ArchiveDetail | null; loading: boolean; error: string; earlierLoading: boolean; earlierError: string; historyUnavailable: boolean; onLoadEarlier: () => void; onRestart: () => void; agentNames?: ReadonlyMap<string, string>; operatorName?: string; attachmentAgentId?: string }) {
  const readerRef = useRef<HTMLDivElement>(null);
  const pendingScroll = useRef<{ height: number; top: number } | null>(null);
  const activeSession = `${session?.agentId}:${session?.sessionId}`;
  const lastSession = useRef(activeSession);
  if (lastSession.current !== activeSession) { pendingScroll.current = null; lastSession.current = activeSession; }
  useLayoutEffect(() => {
    pendingScroll.current = null;
    if (readerRef.current) readerRef.current.scrollTop = readerRef.current.scrollHeight;
  }, [activeSession]);
  const turns = useMemo(() => reconcileChatInputs(detail?.session?.turns || detail?.turns || detail?.chatTurns || [], []), [detail]);
  useLayoutEffect(() => {
    const node = readerRef.current;
    if (!node || !detail || loading) return;
    if (pendingScroll.current) {
      node.scrollTop = pendingScroll.current.top + node.scrollHeight - pendingScroll.current.height;
      pendingScroll.current = null;
    } else if (node.dataset.initialized !== activeSession) {
      node.scrollTop = node.scrollHeight;
      node.dataset.initialized = activeSession;
    }
  }, [activeSession, detail, loading]);
  if (!session) return <Placeholder title="Select a conversation." detail="Choose a chat from the list to read it here." />;
  const sessionAgentName = session.agentName || (session.agentId ? agentNames.get(session.agentId) : '') || session.agentId || 'Agent';
  const copyValue = turns.map((turn) => archiveTurnText(turn, sessionAgentName, agentNames, operatorName)).filter(Boolean).join('\n\n');
  const load = () => {
    const node = readerRef.current;
    if (node) pendingScroll.current = { height: node.scrollHeight, top: node.scrollTop };
    onLoadEarlier();
  };
  return <>
    <ArchiveReaderToolbar eyebrow={session.agentName || session.agentId || 'Archived chat'} title={archiveSessionTitle(session)} detail={`${archiveSessionContext(session)} · ${turns.length} loaded turns${detail?.hasMore ? ' · more available' : ''}`} value={copyValue} copyLabel="Copy loaded chat" />
    <div className="archive-content-body archive-reader-body" ref={readerRef}>
      {loading ? <LoadingState title="Loading conversation." detail="Opening the most recent messages." /> : null}
      {error ? <ErrorState title="Could not open this conversation." error={error} /> : null}
      {!loading && detail ? <div className="archive-reader">
        <div className="archive-history-boundary" role="status">
          {historyUnavailable ? <span>Earlier retained history is unavailable.</span> : detail.hasMore && detail.nextCursor ? <button type="button" disabled={earlierLoading} onClick={load}>{earlierLoading ? 'Loading earlier messages…' : 'Load earlier messages'}</button> : <span>Beginning of retained history</span>}
          {earlierError ? <div><span>Earlier messages could not be loaded: {earlierError}</span> <button type="button" onClick={load}>Retry</button> <button type="button" onClick={onRestart}>Restart from latest</button></div> : null}
        </div>
        <div className="archive-reader-summary">{session.summary || 'A mysterious little shelf item.'}</div>
        {turns.length ? turns.map((turn, index) => { const role = ['user', 'operator', 'human'].includes((turn.role || '').toLowerCase()) ? 'operator' : 'agent'; const text = textFromChatValue(turn.content); const artifacts = turn.metadata?.outputArtifacts ?? []; const attachments = turn.metadata?.attachments ?? []; const ownerId = attachmentAgentId || turn.metadata?.fromAgentId || session.agentId || ''; return <article className={`archive-turn ${role}`} key={`${turn.ts || 'turn'}-${index}`}><div className="archive-turn-meta"><strong>{archiveTurnSpeaker(turn, sessionAgentName, agentNames, operatorName)}</strong><span>{formatTurnDate(turn.ts)}{turn.metadata?.chatInput ? ` · ${chatInputLabel(turn.metadata.chatInput)}` : ''}</span></div>{text ? <div className="archive-turn-body"><ReactMarkdown remarkPlugins={markdownPlugins} components={{ table: MarkdownTable, img: MarkdownImage }}>{text}</ReactMarkdown></div> : null}{attachments.length || artifacts.length ? <ChatMessage side={role} name={archiveTurnSpeaker(turn, sessionAgentName, agentNames, operatorName)} avatar="" time={formatTurnDate(turn.ts)} text="" attachments={attachments} outputArtifacts={artifacts} attachmentAgentId={ownerId} /> : null}</article>; }) : <p className="archive-reader-empty">This conversation has no readable chat turns.</p>}
      </div> : null}
    </div>
  </>;
}

function dreamTime(value: string | null) {
  return value ? new Date(value).toLocaleString() : 'Not recorded';
}
function dreamDiaryMarkdown(diary: DreamDiary) {
  return `## ${diary.phase} · ${dreamTime(diary.createdAt)}\n\n${diary.markdown}`;
}
function dreamAttemptFailures(attempt: DreamPhaseAttempt) {
  const failures = Object.entries(attempt.errors).map(([stage, error]) => `${stage}: ${error}`);
  if (attempt.error && !Object.values(attempt.errors).includes(attempt.error)) failures.push(attempt.error);
  return failures;
}
function DreamPhaseAttempts({ attempts, hasDiaries }: { attempts: DreamPhaseAttempt[]; hasDiaries: boolean }) {
  if (!attempts.length) return null;
  // Aggregate every recorded status, not an inferred latest result or retry order.
  const statuses = new Map<string, number>();
  for (const attempt of attempts) {
    const status = attempt.status || 'Not recorded';
    if (status.toLowerCase() !== 'completed' || !hasDiaries) statuses.set(status, (statuses.get(status) ?? 0) + 1);
  }
  const statusSummary = [...statuses].sort(([a], [b]) => a.localeCompare(b)).map(([status, count]) => `${count} ${status}`).join(' · ');
  return <div className="dream-phase-attempts">
    {statusSummary && <p className="dream-phase-status">Recorded statuses: {statusSummary}</p>}
    <div className="dream-attempt-errors">
      {attempts.flatMap((attempt, index) => dreamAttemptFailures(attempt).map((failure, failureIndex) => <p key={`${index}:${failureIndex}`}>Attempt {index + 1} · {failure}</p>))}
    </div>
    <details className="dream-evidence-details dream-phase-attempt-details">
      <summary>Attempt details ({attempts.length})</summary>
      <p>Numbers distinguish retained records; they do not indicate execution order.</p>
      {attempts.map((attempt, index) => <section className="dream-attempt" key={`${attempt.runId}:${index}`}>
        <h4>Recorded attempt {index + 1} · <span className="dream-recorded-status">{attempt.status || 'Not recorded'}</span></h4>
        {dreamAttemptFailures(attempt).map((failure, failureIndex) => <p key={failureIndex}>{failure}</p>)}
        <p>Run: {attempt.runId || 'Not recorded'}</p>
        <p>Phase started: {dreamTime(attempt.startedAt)} · Phase completed: {dreamTime(attempt.completedAt)}</p>
        <p>Run started: {dreamTime(attempt.runStartedAt)} · Run completed: {dreamTime(attempt.runCompletedAt)}</p>
        {attempt.diaryId ? <p>Recorded diary ID: {attempt.diaryId}</p> : <p>No diary ID recorded for this attempt.</p>}
      </section>)}
    </details>
  </div>;
}
function DreamDiaryEntry({ diary, index, count = 1 }: { diary: DreamDiary; index: number; count?: number }) {
  return <article className="dream-diary">
    {count > 1 && <h4 className="dream-diary-label">Retained diary {index + 1}</h4>}
    <div className="dream-diary-narrative">
      {diary.markdown ? <ReactMarkdown remarkPlugins={markdownPlugins} components={{ table: MarkdownTable, img: MarkdownImage }}>{diary.markdown}</ReactMarkdown> : <p>This retained diary has no narrative.</p>}
    </div>
    <div className="dream-diary-footer">
      <details className="dream-evidence-details">
        <summary>Diary {count > 1 ? `${index + 1} ` : ''}provenance</summary>
        <p>Diary: {diary.id}</p>
        <p>Recorded phase: {diary.phase || 'Not recorded'}</p>
        <p>Created: {dreamTime(diary.createdAt)} · Entry date: {diary.entryDate || 'Not recorded'}</p>
      </details>
      <div className="dream-archive-entry-actions"><DreamCopyButton text={dreamDiaryMarkdown(diary)} /></div>
    </div>
  </article>;
}
export function DreamArchiveReader({ group, selected, loading, error, onRetry }: { group: DreamArchiveGroup | null; selected: DreamGroupSummary | null; loading: boolean; error: string; onRetry: () => void }) {
  if (!selected) return <Placeholder title="Select a dream group." detail="Choose a day from the list to read Light, Deep, and REM here." />;
  const phases = ['light', 'deep', 'rem'] as const;
  const diaries = group ? [...phases.flatMap(phase => group.phases[phase].diaries), ...group.otherDiaries] : [];
  return <>
    <ArchiveReaderToolbar eyebrow={`${selected.agentName} · Dreams`} title={selected.day} detail={`${selected.timezone}${group ? ` · ${diaries.length} retained ${diaries.length === 1 ? 'diary' : 'diaries'}` : ''}`} value={group && !loading && !error ? diaries.map(dreamDiaryMarkdown).join('\n\n') : ''} copyLabel="Copy dreams" />
    <div className="archive-content-body archive-reader-body">
      {loading ? <LoadingState title="Opening the full dreams." detail="Gathering diaries and recorded attempts." /> : null}
      {error ? <div role="alert"><ErrorState title="Could not open these dreams." error={error} /><button type="button" onClick={onRetry}>Retry dream details</button></div> : null}
      {!loading && !error && group ? <div className="archive-reader dream-archive-stack">
        {phases.map(phase => {
          const evidence = group.phases[phase];
          // Missing phases have no evidence: do not invent diary or failure cards.
          if (!evidence.diaries.length && !evidence.attempts.length) return null;
          return <section className="archive-reader-summary dream-archive-entry dream-phase-card" key={phase} aria-label={`${phase} evidence`}><header className="dream-phase-heading"><h3>{phase === 'rem' ? 'REM' : phase === 'light' ? 'Light' : 'Deep'}</h3></header>
            {evidence.diaries.map((diary, index) => <DreamDiaryEntry key={diary.id} diary={diary} index={index} count={evidence.diaries.length} />)}
            <DreamPhaseAttempts attempts={evidence.attempts} hasDiaries={evidence.diaries.length > 0} />
          </section>;
        })}
        {group.otherDiaries.length ? <section className="dream-archive-stack" aria-label="Other diaries"><h3>Other diaries</h3>{group.otherDiaries.map((diary, index) => <div className="archive-reader-summary dream-archive-entry" key={diary.id}><DreamDiaryEntry diary={diary} index={index} count={group.otherDiaries.length} /></div>)}</section> : null}
        {group.cycleAttempts.length ? <section className="archive-reader-summary dream-archive-entry" aria-label="Unattributed cycle attempts"><h3>Cycle attempts · no phase attribution</h3>{group.cycleAttempts.map((attempt, index) => <section className="dream-attempt" key={`${attempt.runId}:${index}`}><h4>Cycle attempt {index + 1} · {attempt.status}</h4>{attempt.error && <p className="dream-attempt-errors">{attempt.error}</p>}<details className="dream-evidence-details"><summary>Cycle attempt {index + 1} details</summary><p>Run: {attempt.runId || 'Not recorded'}</p><p>Cycle started: {dreamTime(attempt.startedAt)} · Cycle completed: {dreamTime(attempt.completedAt)}</p></details></section>)}</section> : null}
      </div> : null}
    </div>
  </>;
}

export function TiddleArchiveReader({ group, loading, error, historyLoading, historyError, historyHasMore, onLoadMoreHistory }: { group: ContinuityCardGroup | null; loading: boolean; error: string; historyLoading: boolean; historyError: string; historyHasMore: boolean; onLoadMoreHistory: () => void }) {
  if (loading) return <LoadingState title="Opening the warm card." detail="Gathering its continuity history." />;
  if (error) return <ErrorState title="Could not open this warm card." error={error} />;
  if (!group) return <Placeholder title="Select a warm card." detail="Choose a Tiddle card from the list to inspect its history here." />;
  const { card, history } = group;
  return <>
    <ArchiveReaderToolbar eyebrow={`${card.agentId} · Tiddle`} title={card.title} detail={`${card.recurrence} recurrences · Last seen ${formatArchiveDate(card.lastSeen)}`} value={`# ${card.title}\n\n${card.summary}`} copyLabel="Copy card" />
    <div className="archive-content-body archive-reader-body"><div className="archive-reader tiddle-archive-reader"><div className="archive-reader-summary">{card.summary}</div><dl className="tiddle-card-details"><div><dt>First seen</dt><dd>{formatArchiveDate(card.firstSeen)}</dd></div><div><dt>Last seen</dt><dd>{formatArchiveDate(card.lastSeen)}</dd></div><div><dt>Recurrence</dt><dd>{card.recurrence}</dd></div><div><dt>Evidence</dt><dd>{card.evidence || 'Warm continuity'}</dd></div></dl>{card.reason ? <section className="tiddle-reason"><h3>Why it persisted</h3><p>{card.reason}</p></section> : null}<section className="tiddle-history"><h3>History</h3>{history.length ? history.map((entry) => <article key={entry.id} className="tiddle-history-entry"><div className="archive-turn-meta"><strong>{entry.disposition}</strong><span>{formatArchiveDate(entry.at)}</span></div><p>{entry.summaryAfter || entry.reason}</p></article>) : <p className="archive-reader-empty">No history entries are available for this card.</p>}{historyError ? <p role="alert">{historyError}</p> : null}{historyHasMore ? <button type="button" className="archive-load-more" disabled={historyLoading} onClick={onLoadMoreHistory}>{historyLoading ? 'Loading more history…' : 'Load more history'}</button> : <p className="proof-muted">Continuity cards expire after 30 days; their history is retained for 180 days.</p>}</section></div></div>
  </>;
}
