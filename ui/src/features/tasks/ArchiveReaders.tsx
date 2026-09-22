import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { markdownPlugins, MarkdownTable } from '../../app/markdownTables';
import { textFromChatValue, type SessionTurn } from '../../app/api';
import { archiveDate, archiveSessionDate, dreamText } from './archiveDerivations';
import type { ArchiveDetail, ArchiveSession, ContinuityCardGroup, DreamGroup } from './archiveTypes';

export function formatArchiveDate(value: string | null) {
  const date = archiveDate(value);
  return date ? new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' }).format(date) : 'No date';
}

export function archiveSessionTitle(session: ArchiveSession) {
  if (session.archiveSnapshot === 'reset' && session.title === 'default · Reset') {
    const date = archiveDate(session.updatedAt || session.createdAt);
    return date ? `Default · Reset ${formatArchiveDate(date.toISOString())}` : session.title;
  }
  return session.title || session.sessionId;
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
    const delegatedParentId = turn.metadata?.parentAgentId;
    return delegatedParentId ? agentNames.get(delegatedParentId) || delegatedParentId : operatorName || 'Operator';
  }
  const senderId = turn.metadata?.fromAgentId;
  return turn.metadata?.fromAgentName || (senderId ? agentNames.get(senderId) || senderId : '') || sessionAgentName || 'Agent';
}

export function archiveTurnText(turn: SessionTurn, sessionAgentName: string, agentNames: ReadonlyMap<string, string> = new Map(), operatorName = 'Operator') {
  const speaker = archiveTurnSpeaker(turn, sessionAgentName, agentNames, operatorName);
  const text = textFromChatValue(turn.content);
  const date = formatTurnDate(turn.ts);
  return text ? `## ${speaker}${date ? ` · ${date}` : ''}\n\n${text}` : '';
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

export function ChatArchiveReader({ session, detail, loading, error, earlierLoading, earlierError, historyUnavailable, onLoadEarlier, onRestart, agentNames = new Map(), operatorName = 'Operator' }: { session: ArchiveSession | null; detail: ArchiveDetail | null; loading: boolean; error: string; earlierLoading: boolean; earlierError: string; historyUnavailable: boolean; onLoadEarlier: () => void; onRestart: () => void; agentNames?: ReadonlyMap<string, string>; operatorName?: string }) {
  const readerRef = useRef<HTMLDivElement>(null);
  const pendingScroll = useRef<{ height: number; top: number } | null>(null);
  const activeSession = `${session?.agentId}:${session?.sessionId}`;
  const lastSession = useRef(activeSession);
  if (lastSession.current !== activeSession) { pendingScroll.current = null; lastSession.current = activeSession; }
  useLayoutEffect(() => {
    pendingScroll.current = null;
    if (readerRef.current) readerRef.current.scrollTop = readerRef.current.scrollHeight;
  }, [activeSession]);
  const turns = detail?.session?.turns || detail?.turns || detail?.chatTurns || [];
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
    <ArchiveReaderToolbar eyebrow={session.agentName || session.agentId || 'Archived chat'} title={archiveSessionTitle(session)} detail={`${formatArchiveDate(archiveSessionDate(session))} · ${turns.length} loaded turns${detail?.hasMore ? ' · more available' : ''}`} value={copyValue} copyLabel="Copy loaded chat" />
    <div className="archive-content-body archive-reader-body" ref={readerRef}>
      {loading ? <LoadingState title="Loading conversation." detail="Opening the most recent messages." /> : null}
      {error ? <ErrorState title="Could not open this conversation." error={error} /> : null}
      {!loading && detail ? <div className="archive-reader">
        <div className="archive-history-boundary" role="status">
          {historyUnavailable ? <span>Earlier retained history is unavailable.</span> : detail.hasMore && detail.nextCursor ? <button type="button" disabled={earlierLoading} onClick={load}>{earlierLoading ? 'Loading earlier messages…' : 'Load earlier messages'}</button> : <span>Beginning of retained history</span>}
          {earlierError ? <div><span>Earlier messages could not be loaded: {earlierError}</span> <button type="button" onClick={load}>Retry</button> <button type="button" onClick={onRestart}>Restart from latest</button></div> : null}
        </div>
        <div className="archive-reader-summary">{session.summary || 'A mysterious little shelf item.'}</div>
        {turns.length ? turns.map((turn, index) => { const role = ['user', 'operator', 'human'].includes((turn.role || '').toLowerCase()) ? 'operator' : 'agent'; const text = textFromChatValue(turn.content); return <article className={`archive-turn ${role}`} key={`${turn.ts || 'turn'}-${index}`}><div className="archive-turn-meta"><strong>{role === 'operator' ? 'You' : session.agentName || 'Agent'}</strong><span>{formatTurnDate(turn.ts)}</span></div>{text ? <div className="archive-turn-body"><ReactMarkdown remarkPlugins={markdownPlugins} components={{ table: MarkdownTable }}>{text}</ReactMarkdown></div> : null}</article>; }) : <p className="archive-reader-empty">This conversation has no readable chat turns.</p>}
      </div> : null}
    </div>
  </>;
}

export function DreamArchiveReader({ group, loading, error }: { group: DreamGroup | null; loading: boolean; error: string }) {
  if (!group) return <Placeholder title="Select a dream group." detail="Choose a day from the list to read Light, Deep, and REM here." />;
  const dreamMarkdown = (entry: DreamGroup['entries'][number]) => `## ${entry.phase} · ${formatArchiveDate(entry.createdAt)}\n\n${dreamText(entry)}`;
  return <>
    <ArchiveReaderToolbar eyebrow={`${group.agentName} · Dreams`} title={group.day} detail={`${group.entries.length} remembered states`} value={group.entries.map(dreamMarkdown).join('\n\n')} copyLabel="Copy dreams" />
    <div className="archive-content-body archive-reader-body">
      {loading ? <LoadingState title="Opening the full dreams." detail="Gathering every remembered state." /> : null}
      {error ? <ErrorState title="Could not open these dreams." error={error} /> : null}
      {!loading && !error ? <div className="archive-reader dream-archive-stack">{group.entries.map((entry) => <article className="archive-reader-summary dream-archive-entry" key={entry.id}><div className="archive-turn-meta"><strong>{entry.phase}</strong><span>{formatArchiveDate(entry.createdAt)}</span></div><ReactMarkdown remarkPlugins={markdownPlugins} components={{ table: MarkdownTable }}>{dreamText(entry)}</ReactMarkdown><div className="dream-archive-entry-actions"><DreamCopyButton text={dreamMarkdown(entry)} /></div></article>)}</div> : null}
    </div>
  </>;
}

export function TiddleArchiveReader({ group, loading, error }: { group: ContinuityCardGroup | null; loading: boolean; error: string }) {
  if (loading) return <LoadingState title="Opening the warm card." detail="Gathering its continuity history." />;
  if (error) return <ErrorState title="Could not open this warm card." error={error} />;
  if (!group) return <Placeholder title="Select a warm card." detail="Choose a Tiddle card from the list to inspect its history here." />;
  const { card, history } = group;
  return <>
    <ArchiveReaderToolbar eyebrow={`${card.agentId} · Tiddle`} title={card.title} detail={`${card.recurrence} recurrences · Last seen ${formatArchiveDate(card.lastSeen)}`} value={`# ${card.title}\n\n${card.summary}`} copyLabel="Copy card" />
    <div className="archive-content-body archive-reader-body"><div className="archive-reader tiddle-archive-reader"><div className="archive-reader-summary">{card.summary}</div><dl className="tiddle-card-details"><div><dt>First seen</dt><dd>{formatArchiveDate(card.firstSeen)}</dd></div><div><dt>Last seen</dt><dd>{formatArchiveDate(card.lastSeen)}</dd></div><div><dt>Recurrence</dt><dd>{card.recurrence}</dd></div><div><dt>Evidence</dt><dd>{card.evidence || 'Warm continuity'}</dd></div></dl>{card.reason ? <section className="tiddle-reason"><h3>Why it persisted</h3><p>{card.reason}</p></section> : null}<section className="tiddle-history"><h3>History</h3>{history.length ? history.map((entry) => <article key={entry.id} className="tiddle-history-entry"><div className="archive-turn-meta"><strong>{entry.disposition}</strong><span>{formatArchiveDate(entry.at)}</span></div><p>{entry.summaryAfter || entry.reason}</p></article>) : <p className="archive-reader-empty">No history entries are available for this card.</p>}</section></div></div>
  </>;
}
