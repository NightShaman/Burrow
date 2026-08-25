import { useLayoutEffect, useRef, useState } from 'react';
import type { SyntheticEvent } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import { textFromChatValue, type ProgressEntry, type RunProgress, type SessionAttachment, type SessionTurn, type ToolActivity } from '../../app/api';
import type { Agent, Subagent } from '../../app/types';

export type OperatorProfile = { name: string; avatar: string };

type ChatTranscriptProps = {
  selected: Agent | Subagent;
  parent: Agent;
  operator: OperatorProfile;
  isNewSession: boolean;
  turns: SessionTurn[];
  isLoading: boolean;
  error: string;
  isSending: boolean;
  activeRunId: string;
  activeToolActivity?: ToolActivity;
  liveProgress: ProgressEntry[];
  liveAnswer: string;
};

export function ChatTranscript({ selected, parent, operator, isNewSession, turns, isLoading, error, isSending, activeRunId, activeToolActivity, liveProgress, liveAnswer }: ChatTranscriptProps) {
  const isSubagent = 'stream' in selected;
  const messages = turns.filter((turn) => turn.type === 'message' && turn.content && (turn.role === 'user' || turn.role === 'assistant' || turn.role === 'agent'));
  const activityByRun = new Map<string, ToolActivity>();
  for (const turn of turns) {
    const activity = turn.metadata?.toolActivity;
    if (activity && (turn.runId || activity.runId)) activityByRun.set(turn.runId || activity.runId || '', activity);
  }
  const activeActivity = activeRunId ? activeToolActivity ?? activityByRun.get(activeRunId) : undefined;
  const isEmptySession = !isLoading && (isNewSession || !messages.length);
  const messagesRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const updateScrollIntent = () => {
    const container = messagesRef.current;
    if (!container) return;
    stickToBottomRef.current = container.scrollHeight - container.scrollTop - container.clientHeight < 48;
  };
  useLayoutEffect(() => {
    const container = messagesRef.current;
    if (container && !isLoading && stickToBottomRef.current) container.scrollTop = container.scrollHeight;
  }, [isLoading, isNewSession, messages.length, isSending, liveProgress, liveAnswer, activeActivity]);
  return <div className={`chat-messages ${isEmptySession ? 'new-session-view' : ''}`} ref={messagesRef} onScroll={updateScrollIntent} aria-busy={isLoading || isSending}>
    {isEmptySession ? <div className="new-session-empty"><img src="/burrow-logo.png" alt="Burrow" /></div> : <>
      {isSubagent && <div className="stream-banner"><span>Subagent stream</span><strong>{selected.name}</strong><small>Workspace remains attached to {parent.name}</small></div>}
      {isLoading && <p className="chat-state">{messages.length ? 'Refreshing conversation…' : 'Loading conversation…'}</p>}
      {messages.map((turn, index) => {
        const isAgentMessage = turn.role === 'agent';
        const fromCurrentAgent = turn.metadata?.fromAgentId === selected.id;
        const senderName = turn.metadata?.fromAgentName ?? turn.metadata?.fromAgentId ?? 'Agent';
        const persistedActivity = turn.metadata?.toolActivity;
        const isPersistedTerminalTurn = turn.role === 'assistant' && turn.runId === activeRunId && Boolean(turn.metadata?.progress || persistedActivity || turn.content);
        return <ChatMessage key={`${turn.runId ?? 'turn'}-${index}`} side={turn.role === 'user' || (isAgentMessage && !fromCurrentAgent) ? 'operator' : 'agent'} name={turn.role === 'user' ? operator.name : isAgentMessage ? (fromCurrentAgent ? selected.name : senderName) : selected.name} avatar={turn.role === 'user' ? operator.avatar || operator.name.slice(0, 1).toUpperCase() : isAgentMessage && !fromCurrentAgent ? senderName.slice(0, 1).toUpperCase() : selected.avatar} time={formatTime(turn.ts)} text={textFromChatValue(turn.content)} activity={turn.role === 'assistant' ? (persistedActivity ?? (turn.runId === activeRunId ? activeActivity : activityByRun.get(turn.runId ?? ''))) : undefined} progress={turn.role === 'assistant' ? turn.metadata?.progress : undefined} streamedAnswer={turn.role === 'assistant' ? turn.metadata?.streamedAnswer : undefined} activityLive={turn.role === 'assistant' && turn.runId === activeRunId && !isPersistedTerminalTurn} attachments={turn.metadata?.attachments} />;
      })}
      {isSending && !messages.some((turn) => turn.role === 'assistant' && turn.runId === activeRunId && Boolean(turn.metadata?.progress || turn.metadata?.toolActivity || turn.content)) && <LiveAssistantTurn name={selected.name} avatar={selected.avatar} progress={liveProgress} activity={activeActivity} answer={liveAnswer} />}
      {error && <p className="chat-error" role="alert">{error}</p>}
    </>}
  </div>;
}

function formatTime(value?: string) { if (!value) return 'Now'; const date = new Date(value); return Number.isNaN(date.getTime()) ? 'Now' : new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(date); }
function formatTimestamp(value?: string) { if (!value) return 'Now'; const date = new Date(value); return Number.isNaN(date.getTime()) ? 'Now' : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date); }

async function copyMarkdown(text: string) {
  try {
    if (navigator.clipboard?.writeText && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Clipboard permissions commonly fail on a local HTTP dev server. Use the
    // synchronous browser fallback before reporting a failure.
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

function markdownText(value: unknown) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((item) => {
    if (typeof item === 'string') return item;
    if (item && typeof item === 'object' && 'text' in item && typeof item.text === 'string') return item.text;
    return '';
  }).filter(Boolean).join('\n\n');
  if (value && typeof value === 'object' && 'text' in value && typeof value.text === 'string') return value.text;
  return '';
}

function ProgressCard({ items, live = false, status }: { items: ProgressEntry[]; live?: boolean; status?: RunProgress['status'] }) {
  const terminalLabel = status && status !== 'complete' ? ` · ${status}` : '';
  return <details className={`run-progress${live ? ' live' : ''}`} open={live || status !== undefined}><summary><span aria-hidden="true">✦</span><span>{live ? 'Progress' : 'Progress recorded'} · {items.length}{terminalLabel}</span><span className="run-progress-chevron" aria-hidden="true">⌄</span></summary><ol className="run-progress-body run-progress-timeline">{items.map((item) => <li key={item.id}><small>{item.modelCall === undefined ? 'Reasoning' : `Model call ${item.modelCall}`}</small><ReactMarkdown remarkPlugins={[remarkBreaks]}>{markdownText(item.text)}</ReactMarkdown></li>)}</ol></details>;
}

function StreamedAnswerCard({ text }: { text: string }) {
  return <details className="streamed-answer"><summary><span aria-hidden="true">≈</span><span>Streamed response</span><span className="streamed-answer-chevron" aria-hidden="true">⌄</span></summary><div className="streamed-answer-body"><ReactMarkdown remarkPlugins={[remarkBreaks]}>{text}</ReactMarkdown></div></details>;
}

function avatarSource(value: string) { return /^(?:data:image\/[\w+.-]+;base64,|https?:\/\/|blob:|\/)/.test(value.trim()) ? value.trim() : null; }

function LiveAssistantTurn({ name, avatar, progress, activity, answer }: { name: string; avatar: string; progress: ProgressEntry[]; activity?: ToolActivity; answer: string }) { const image = avatarSource(avatar); return <article className="message agent live-assistant-turn"><div className="message-avatar" aria-label={`${name} avatar`}>{image ? <img src={image} alt="" /> : avatar}</div><div className="message-content"><small>{name.toUpperCase()} · NOW</small>{progress.length > 0 && <ProgressCard items={progress} live />}{activity && <ToolActivityCard activity={activity} live />}{answer ? <div className="message-bubble final-answer live-answer"><ReactMarkdown remarkPlugins={[remarkBreaks]}>{answer}</ReactMarkdown><span className="stream-caret" aria-hidden="true" /></div> : !progress.length && !activity && <div className="live-waiting" role="status">Waiting for progress…</div>}</div></article>; }

type ModelErrorDetails = { overloaded: boolean; message: string };

const MODEL_ERROR_TITLES = [
  'The model tripped over its own cloak',
  'The model misplaced its spellbook',
  'The model got tangled in the curtains',
  'The model wandered into the wrong dungeon',
  'The model dropped the plot down an oubliette',
  'The model summoned smoke but no answer',
  'The model challenged syntax and lost',
  'The model stepped on a magical rake',
  'The model lost its train of thought in the catacombs',
  'The model accidentally polymorphed its answer',
] as const;

function randomModelErrorTitle() {
  return MODEL_ERROR_TITLES[Math.floor(Math.random() * MODEL_ERROR_TITLES.length)];
}

function parseModelError(text: string): ModelErrorDetails | null {
  const match = text.trim().match(/^\[model_error:\s*([\s\S]*?)\]$/);
  if (!match) return null;
  const message = match[1].trim() || 'The model provider got theatrical and refused to answer.';
  return { overloaded: /overloaded|try again later|rate limit|temporar/i.test(message), message };
}

export function ChatMessage({ side, name, avatar, time, text, activity, progress, streamedAnswer, activityLive, attachments = [] }: { side: 'agent' | 'operator'; name: string; avatar: string; time: string; text: string; activity?: ToolActivity; progress?: RunProgress; streamedAnswer?: string; activityLive?: boolean; attachments?: SessionAttachment[] }) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const image = avatarSource(avatar);
  const modelError = side === 'agent' ? parseModelError(text) : null;
  const [modelErrorTitle] = useState(randomModelErrorTitle);
  const copy = async () => {
    const didCopy = await copyMarkdown(text);
    setCopyState(didCopy ? 'copied' : 'failed');
    window.setTimeout(() => setCopyState('idle'), 1500);
  };
  const copyLabel = copyState === 'copied' ? 'Copied' : copyState === 'failed' ? 'Copy failed' : '';
  return <article className={`message ${side}${modelError ? ' model-error-message' : ''}`}><div className="message-avatar" aria-label={`${name} avatar`}>{image ? <img src={image} alt="" /> : avatar}</div><div className="message-content"><small>{name.toUpperCase()} · {time.toUpperCase()}</small>{attachments.length ? <div className="message-attachments" aria-label={`${attachments.length} attachment${attachments.length === 1 ? '' : 's'}`}>{attachments.map((attachment, index) => <span className="message-attachment" key={`${attachment.index ?? index}-${attachment.name}`} title={attachment.type}><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="8.5" cy="9" r="1.5" /><path d="m4 18 5.5-5.5 3.5 3.5 2.5-2.5 4.5 4.5" /></svg><span>{attachment.name}</span></span>)}</div> : null}{streamedAnswer ? <StreamedAnswerCard text={streamedAnswer} /> : null}{progress?.items?.length ? <ProgressCard items={progress.items} status={progress.status} /> : null}{modelError ? <div className="message-bubble model-error-card" role="alert"><div className="model-error-sigil" aria-hidden="true">⚠</div><div><strong>{modelError.overloaded ? 'The model servers are throwing goblets' : modelErrorTitle}</strong><p>{modelError.message}</p><span>The chat is fine. The upstream model is being stupid.</span></div></div> : text && <div className="message-bubble final-answer"><ReactMarkdown remarkPlugins={[remarkBreaks]}>{text}</ReactMarkdown></div>}{activity && <ToolActivityCard activity={activity} live={activityLive} />}{text && <button className="copy-message" onClick={copy} aria-label={`Copy ${name} message as Markdown`} title={copyState === 'copied' ? 'Copied Markdown' : copyState === 'failed' ? 'Copy failed' : 'Copy Markdown'}><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M15 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h3" /></svg><span aria-live="polite">{copyLabel}</span></button>}</div></article>;
}

function ToolActivityCard({ activity, live }: { activity: ToolActivity; live?: boolean }) {
  const items = activity.items ?? [];
  const activeItem = [...items].reverse().find((item) => item.status === 'pending') ?? items.at(-1);
  const label = live ? activeItem?.label ?? 'Working through it' : `${items.length} runtime ${items.length === 1 ? 'action' : 'actions'}`;
  const keepExpandedCardInView = (event: SyntheticEvent<HTMLDetailsElement>) => {
    const card = event.currentTarget;
    if (!card.open) return;
    requestAnimationFrame(() => {
      const chat = card.closest<HTMLDivElement>('.chat-messages');
      if (!chat) return;
      const overflow = card.getBoundingClientRect().bottom - chat.getBoundingClientRect().bottom;
      if (overflow > 0) chat.scrollBy({ top: overflow, behavior: 'smooth' });
    });
  };
  if (live) return <details className="tool-activity live" onToggle={keepExpandedCardInView}><summary><span className="tool-activity-spinner" aria-hidden="true" /><strong>{label}</strong><span className="tool-activity-chevron" aria-hidden="true">⌄</span></summary><div className="tool-activity-list">{items.length ? items.map((item, index) => <div className="tool-activity-item" key={item.id || `${item.label}-${index}`}><span className={`tool-dot ${item.status ?? 'pending'}`} aria-hidden="true">{item.status === 'error' ? '!' : item.status === 'pending' ? '·' : '✓'}</span><strong>{item.label}</strong></div>) : <div className="tool-activity-empty">{label}</div>}</div></details>;
  return <details className="tool-activity" onToggle={keepExpandedCardInView}>
    <summary><span className="tool-activity-check" aria-hidden="true">✓</span><strong>{label}</strong><span className="tool-activity-chevron" aria-hidden="true">⌄</span></summary>
    <div className="tool-activity-list">{items.length ? items.map((item, index) => <div className="tool-activity-item" key={item.id || `${item.label}-${index}`}><span className={`tool-dot ${item.status ?? 'pending'}`} aria-hidden="true">{item.status === 'error' ? '!' : item.status === 'pending' ? '·' : '✓'}</span><div><strong>{item.label}</strong>{item.detail && <small title={item.detail}>{item.detail}</small>}</div></div>) : <div className="tool-activity-empty">Waiting for the first tool call…</div>}</div>
  </details>;
}

