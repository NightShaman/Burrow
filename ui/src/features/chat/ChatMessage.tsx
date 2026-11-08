import { type ContextReport } from './contextReport';
import {
  chatInputLabel,
  pendingChatInput,
  type ChatInput,
  type ChatInputMetadata,
} from './chatInputs';
import { chatToolIdentity } from './chatToolIdentity';
import {
  chatTerminalCopy,
  chatTerminalDiagnostic,
  type ChatTerminalMetadata,
} from './chatTerminal';
import { chatLiveStageLabel, type ChatLiveStage } from './chatLiveStage';
import { ImagePreview } from '../../app/ImagePreview';
import { isValidElement, useEffect, useState } from 'react';
import type { HTMLAttributes, ReactNode, SyntheticEvent } from 'react';
import ReactMarkdown from 'react-markdown';
import { markdownPlugins, MarkdownTable, MarkdownImage } from '../../app/markdownTables';
import {
  fetchApi,
  generatedArtifactPath,
  type GeneratedArtifact,
  type ProgressEntry,
  type RunProgress,
  type SessionAttachment,
  type ToolActivity,
  type ToolActivityItem,
} from '../../app/api';
import { toolDisplayName } from '../../app/toolDisplayName';

export function formatTime(value?: string, now = new Date()) {
  if (!value) return 'Now';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Now';
  const time = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(
    date,
  );
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
  if (sameDay(date, now)) return time;
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (sameDay(date, yesterday)) return `Yesterday · ${time}`;
  const day = new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    ...(date.getFullYear() !== now.getFullYear() ? { year: 'numeric' as const } : {}),
  }).format(date);
  return `${day} · ${time}`;
}

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

function codeText(value: ReactNode): string {
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(codeText).join('');
  if (isValidElement<{ children?: ReactNode }>(value)) return codeText(value.props.children);
  return '';
}

function CodeBlock({ children, ...props }: HTMLAttributes<HTMLPreElement>) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const text = codeText(children).replace(/\n$/, '');
  const copy = async () => {
    const didCopy = await copyMarkdown(text);
    setCopyState(didCopy ? 'copied' : 'failed');
    window.setTimeout(() => setCopyState('idle'), 1500);
  };
  const label =
    copyState === 'copied' ? 'Copied' : copyState === 'failed' ? 'Copy failed' : 'Copy code';
  return (
    <div className="code-block">
      <pre {...props}>{children}</pre>
      <button
        type="button"
        className="copy-code"
        onClick={copy}
        aria-label="Copy code block"
        title={label}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <rect x="9" y="9" width="11" height="11" rx="2" />
          <path d="M15 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h3" />
        </svg>
        <span aria-live="polite">{label}</span>
      </button>
    </div>
  );
}

const markdownComponents = { pre: CodeBlock, table: MarkdownTable, img: MarkdownImage };

function Markdown({ children }: { children: string }) {
  return (
    <ReactMarkdown remarkPlugins={markdownPlugins} components={markdownComponents}>
      {children}
    </ReactMarkdown>
  );
}

function ContextCommandReport({ report }: { report: ContextReport }) {
  return (
    <div className="context-report">
      {report.blocks.map((block, index) =>
        block.collapsed ? (
          <details className="streamed-answer context-report-details" key={index}>
            <summary>
              <span>{block.title || 'Technical details'}</span>
              <svg
                className="streamed-answer-chevron"
                width="12"
                height="12"
                viewBox="0 0 16 16"
                aria-hidden="true"
              >
                <path d="m4 6 4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" />
              </svg>
            </summary>
            <div className="streamed-answer-body">
              <Markdown>{block.markdown}</Markdown>
            </div>
          </details>
        ) : (
          <section className="context-report-block" key={index}>
            {block.title && <h3>{block.title}</h3>}
            <Markdown>{block.markdown}</Markdown>
          </section>
        ),
      )}
    </div>
  );
}

function markdownText(value: unknown) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value))
    return value
      .map((item) => {
        if (typeof item === 'string') return item;
        if (item && typeof item === 'object' && 'text' in item && typeof item.text === 'string')
          return item.text;
        return '';
      })
      .filter(Boolean)
      .join('\n\n');
  if (value && typeof value === 'object' && 'text' in value && typeof value.text === 'string')
    return value.text;
  return '';
}

function ProgressCard({
  items,
  live = false,
  status,
}: {
  items: ProgressEntry[];
  live?: boolean;
  status?: RunProgress['status'];
}) {
  const terminalLabel = status && status !== 'complete' ? ` · ${status}` : '';
  return (
    <details className={`run-progress${live ? ' live' : ''}`} open={live || status !== undefined}>
      <summary>
        <span aria-hidden="true">✦</span>
        <span>
          {live ? 'Progress' : 'Progress recorded'} · {items.length}
          {terminalLabel}
        </span>
        <span className="run-progress-chevron" aria-hidden="true">
          ⌄
        </span>
      </summary>
      <ol className="run-progress-body run-progress-timeline">
        {items.map((item) => (
          <li key={item.id}>
            <small>
              {item.modelCall === undefined ? 'Reasoning' : `Model call ${item.modelCall}`}
            </small>
            <Markdown>{markdownText(item.text)}</Markdown>
          </li>
        ))}
      </ol>
    </details>
  );
}

function StreamedAnswerCard({ text }: { text: string }) {
  return (
    <details className="streamed-answer">
      <summary>
        <span aria-hidden="true">≈</span>
        <span>Streamed response</span>
        <span className="streamed-answer-chevron" aria-hidden="true">
          ⌄
        </span>
      </summary>
      <div className="streamed-answer-body">
        <Markdown>{text}</Markdown>
      </div>
    </details>
  );
}

function avatarSource(value: string) {
  return /^(?:data:image\/[\w+.-]+;base64,|https?:\/\/|blob:|\/)/.test(value.trim())
    ? value.trim()
    : null;
}

export function LiveAssistantTurn({
  name,
  avatar,
  progress,
  activity,
  answer,
  stage,
}: {
  name: string;
  avatar: string;
  progress: ProgressEntry[];
  activity?: ToolActivity;
  answer: string;
  stage?: ChatLiveStage;
}) {
  const image = avatarSource(avatar);
  return (
    <article className="message agent live-assistant-turn">
      <div className="message-avatar" aria-label={`${name} avatar`}>
        {image ? <img src={image} alt="" /> : avatar}
      </div>
      <div className="message-content">
        <small>{name.toUpperCase()} · NOW</small>
        {activity && <ToolActivityCard activity={activity} live />}
        {progress.length > 0 && <ProgressCard items={progress} live />}
        {stage?.startsWith('compact') && (
          <div className="live-waiting" role="status">
            {chatLiveStageLabel(stage)}
          </div>
        )}
        {answer ? (
          <div className="message-bubble final-answer live-answer">
            <Markdown>{answer}</Markdown>
            <span className="stream-caret" aria-hidden="true" />
          </div>
        ) : (
          !stage?.startsWith('compact') &&
          !progress.length &&
          !activity && (
            <div className="live-waiting" role="status">
              {chatLiveStageLabel(stage)}
            </div>
          )
        )}
      </div>
    </article>
  );
}

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

export function TerminalErrorCard({ terminal }: { terminal: ChatTerminalMetadata }) {
  const [title] = useState(randomModelErrorTitle);
  if (terminal.terminalStatus === 'completed') return null;
  const diagnostic = chatTerminalDiagnostic(terminal);
  return (
    <div className="message-bubble model-error-card" role="alert">
      <div className="model-error-sigil" aria-hidden="true">
        ⚠
      </div>
      <div>
        <strong>
          {terminal.terminalStatus === 'cancelled'
            ? 'Run cancelled'
            : terminal.terminalStatus === 'superseded'
              ? 'Run superseded'
              : diagnostic.overloaded
                ? 'The model servers are throwing goblets'
                : diagnostic.upstream
                  ? title
                  : terminal.modelFailure?.origin === 'burrow'
                    ? 'The runtime could not finish this run'
                    : 'Run failed'}
        </strong>
        <p>{diagnostic.message}</p>
        {terminal.terminalStatus === 'superseded' ? (
          <span>The newer run owns this conversation.</span>
        ) : terminal.terminalStatus === 'failed' && diagnostic.upstream ? (
          <span>The upstream model is being stupid.</span>
        ) : null}
      </div>
    </div>
  );
}

function MessageAttachment({
  attachment,
  agentId,
}: {
  attachment: SessionAttachment;
  agentId?: string;
}) {
  const isImage = /^image\/(?:png|jpeg|gif|webp)$/i.test(attachment.type);
  const path = attachment.artifactPath;
  const [source, setSource] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [downloadState, setDownloadState] = useState<'idle' | 'downloading' | 'failed'>('idle');
  const url =
    path && agentId
      ? `/api/attachments/${encodeURIComponent(agentId)}/${path.split('/').map(encodeURIComponent).join('/')}`
      : null;
  const download = async () => {
    if (!url || downloadState === 'downloading') return;
    setDownloadState('downloading');
    try {
      const response = await fetchApi(url);
      if (!response.ok) throw new Error('Attachment unavailable');
      const objectUrl = URL.createObjectURL(await response.blob());
      const link = document.createElement('a');
      link.href = objectUrl;
      link.download = attachment.name;
      document.body.append(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(objectUrl);
      setDownloadState('idle');
    } catch {
      setDownloadState('failed');
    }
  };
  useEffect(() => {
    if (!isImage || !path || !agentId) {
      setSource(null);
      setFailed(false);
      return;
    }
    const controller = new AbortController();
    let objectUrl: string | undefined;
    setSource(null);
    setFailed(false);
    const url = `/api/attachments/${encodeURIComponent(agentId)}/${path.split('/').map(encodeURIComponent).join('/')}`;
    void fetchApi(url, { signal: controller.signal, headers: { accept: 'image/*' } })
      .then(async (response) => {
        if (!response.ok) throw new Error('Attachment unavailable');
        const blob = await response.blob();
        if (!blob.type.startsWith('image/')) throw new Error('Not an image');
        if (!controller.signal.aborted) {
          objectUrl = URL.createObjectURL(blob);
          setSource(objectUrl);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [agentId, isImage, path]);
  const imageSource = isImage && !failed ? (source ?? attachment.preview ?? null) : null;
  return (
    <div className={`message-attachment-card${imageSource ? ' image' : ''}`}>
      {imageSource ? (
        <figure className="message-attachment-image">
          <ImagePreview
            src={imageSource}
            alt={attachment.name}
            loading="lazy"
            onError={() => setFailed(true)}
          />
          <figcaption>{attachment.name}</figcaption>
        </figure>
      ) : (
        <span className="message-attachment" title={attachment.type}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <rect x="3" y="4" width="18" height="16" rx="2" />
            <circle cx="8.5" cy="9" r="1.5" />
            <path d="m4 18 5.5-5.5 3.5 3.5 2.5-2.5 4.5 4.5" />
          </svg>
          <span>{attachment.name}</span>
        </span>
      )}
      {url && (
        <button
          type="button"
          onClick={download}
          disabled={downloadState === 'downloading'}
          aria-label={`Download ${attachment.name}`}
        >
          {downloadState === 'downloading'
            ? 'Downloading…'
            : downloadState === 'failed'
              ? 'Retry download'
              : 'Download'}
        </button>
      )}
      {downloadState === 'failed' && <span role="status">Download failed</span>}
    </div>
  );
}

function formatArtifactSize(value?: number) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let size = value / 1024;
  let unit = units[0];
  for (let index = 1; index < units.length && size >= 1024; index += 1) {
    size /= 1024;
    unit = units[index];
  }
  return `${size >= 10 ? size.toFixed(0) : size.toFixed(1)} ${unit}`;
}

function GeneratedArtifactCard({
  artifact,
  agentId,
}: {
  artifact: GeneratedArtifact;
  agentId?: string;
}) {
  const [downloadState, setDownloadState] = useState<'idle' | 'downloading' | 'failed'>('idle');
  const reference = artifact.storageReference?.trim();
  const canDownload = Boolean(reference && agentId);
  const displayName = artifact.name?.trim() || `Generated ${artifact.kind || 'artifact'}`;
  const [previewUrl, setPreviewUrl] = useState('');
  useEffect(() => {
    if (!reference || !agentId || artifact.kind !== 'image') return;
    let cancelled = false;
    let url = '';
    setPreviewUrl('');
    void fetchApi(generatedArtifactPath(agentId, reference), {
      headers: { accept: artifact.mimeType || 'image/*' },
    })
      .then((response) => {
        if (!response.ok) throw new Error('Preview unavailable');
        return response.blob();
      })
      .then((blob) => {
        if (!cancelled) {
          url = URL.createObjectURL(blob);
          setPreviewUrl(url);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [reference, agentId, artifact.kind, artifact.mimeType]);
  const details = [artifact.kind, artifact.mimeType, formatArtifactSize(artifact.sizeBytes)]
    .filter(Boolean)
    .join(' · ');
  const provenance = [artifact.provenance?.provider, artifact.provenance?.model]
    .filter(Boolean)
    .join(' · ');
  const download = async () => {
    if (!reference || !agentId || downloadState === 'downloading') return;
    setDownloadState('downloading');
    try {
      const response = await fetchApi(generatedArtifactPath(agentId, reference), {
        headers: { accept: artifact.mimeType || 'application/octet-stream' },
      });
      if (!response.ok) throw new Error('Generated artifact unavailable');
      const objectUrl = URL.createObjectURL(await response.blob());
      const link = document.createElement('a');
      link.href = objectUrl;
      link.download = displayName;
      link.style.display = 'none';
      document.body.append(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(objectUrl);
      setDownloadState('idle');
    } catch {
      setDownloadState('failed');
    }
  };
  const actionLabel = !canDownload
    ? 'Download unavailable'
    : downloadState === 'downloading'
      ? 'Downloading…'
      : downloadState === 'failed'
        ? 'Retry download'
        : 'Download';
  return (
    <article className="generated-artifact">
      <div className="generated-artifact-icon">
        {previewUrl ? (
          <ImagePreview src={previewUrl} alt={displayName} />
        ) : (
          <span aria-hidden="true">↓</span>
        )}
      </div>
      <div className="generated-artifact-info">
        <strong>{displayName}</strong>
        <span>{details || 'Generated artifact'}</span>
        {provenance && <span>Created by {provenance}</span>}
        {downloadState === 'failed' && (
          <span className="generated-artifact-error" role="status">
            Download failed
          </span>
        )}
      </div>
      <button
        type="button"
        onClick={download}
        disabled={!canDownload || downloadState === 'downloading'}
      >
        {actionLabel}
      </button>
    </article>
  );
}

export function ChatMessage({
  side,
  name,
  avatar,
  time,
  text,
  activity,
  progress,
  streamedAnswer,
  report,
  terminal,
  activityLive,
  attachments = [],
  outputArtifacts = [],
  attachmentAgentId,
  chatInput,
  input,
  onPromote,
  onInputAction,
  inputActionPending,
}: {
  chatInput?: ChatInputMetadata;
  input?: ChatInput;
  onPromote?: (id: string, text: string) => void;
  onInputAction?: (id: string, action: 'cancel' | 'resume') => void;
  inputActionPending?: string;
  side: 'agent' | 'operator';
  name: string;
  avatar: string;
  time: string;
  text: string;
  activity?: ToolActivity;
  progress?: RunProgress;
  streamedAnswer?: string;
  report?: ContextReport;
  terminal?: ChatTerminalMetadata;
  activityLive?: boolean;
  attachments?: SessionAttachment[];
  outputArtifacts?: GeneratedArtifact[];
  attachmentAgentId?: string;
}) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const image = avatarSource(avatar);
  const hasTerminalError =
    side === 'agent' &&
    terminal?.terminalStatus !== undefined &&
    terminal.terminalStatus !== 'completed';
  const copyText = [text, hasTerminalError && terminal ? chatTerminalCopy(terminal) : '']
    .filter(Boolean)
    .join('\n\n');
  const copy = async () => {
    const didCopy = await copyMarkdown(copyText);
    setCopyState(didCopy ? 'copied' : 'failed');
    window.setTimeout(() => setCopyState('idle'), 1500);
  };
  const copyLabel = copyState === 'copied' ? 'Copied' : copyState === 'failed' ? 'Copy failed' : '';
  return (
    <article className={`message ${side}${hasTerminalError ? ' model-error-message' : ''}`}>
      <div className="message-avatar" aria-label={`${name} avatar`}>
        {image ? <img src={image} alt="" /> : avatar}
      </div>
      <div className="message-content">
        <small>
          {name.toUpperCase()} · {time.toUpperCase()}
        </small>
        {chatInput && <span className="chat-input-label">{chatInputLabel(chatInput)}</span>}
        {attachments.length ? (
          <div
            className="message-attachments"
            aria-label={`${attachments.length} attachment${attachments.length === 1 ? '' : 's'}`}
          >
            {attachments.map((attachment, index) => (
              <MessageAttachment
                key={`${attachment.index ?? index}-${attachment.name}`}
                attachment={attachment}
                agentId={attachmentAgentId}
              />
            ))}
          </div>
        ) : null}
        {outputArtifacts.length ? (
          <section
            className="generated-artifacts"
            aria-label={`${outputArtifacts.length} generated artifact${outputArtifacts.length === 1 ? '' : 's'}`}
          >
            {outputArtifacts.map((artifact, index) => (
              <GeneratedArtifactCard
                key={`${artifact.storageReference ?? artifact.name ?? artifact.kind}-${index}`}
                artifact={artifact}
                agentId={attachmentAgentId}
              />
            ))}
          </section>
        ) : null}
        {streamedAnswer ? <StreamedAnswerCard text={streamedAnswer} /> : null}
        {activity && <ToolActivityCard activity={activity} live={activityLive} />}
        {progress?.items?.length ? (
          <ProgressCard items={progress.items} status={progress.status} />
        ) : null}
        {hasTerminalError && terminal ? <TerminalErrorCard terminal={terminal} /> : null}
        {(text || report) && (
          <div className="message-bubble final-answer">
            {report ? <ContextCommandReport report={report} /> : <Markdown>{text}</Markdown>}
          </div>
        )}
        {chatInput && side === 'operator' && (
          <div className="chat-input-actions">
            {input && pendingChatInput(input) && onInputAction && (
              <button
                disabled={Boolean(inputActionPending)}
                onClick={() => onInputAction(input.id, 'cancel')}
              >
                {input.status === 'running' ? 'Cancel this input' : 'Cancel input'}
              </button>
            )}
            {input?.status === 'held' && onInputAction && (
              <button
                disabled={Boolean(inputActionPending)}
                onClick={() => onInputAction(input.id, 'resume')}
              >
                Resume queue
              </button>
            )}
            {input?.error && (
              <p className="error" role="alert">
                {input.error}
              </p>
            )}
            {chatInput.snapshot && (
              <details>
                <summary>Snapshot details</summary>
                <span>
                  Run {chatInput.snapshot.originRunId ?? 'unknown'} ·{' '}
                  {chatInput.snapshot.phase ?? 'unknown phase'} ·{' '}
                  {chatInput.snapshot.entryCount ?? 'unknown'} entries
                </span>
              </details>
            )}
          </div>
        )}
        {chatInput?.intent === 'side_question' &&
          side === 'agent' &&
          text &&
          (input?.status ?? chatInput.status) === 'succeeded' &&
          onPromote && (
            <button className="chat-promote" onClick={() => onPromote(chatInput.id, text)}>
              Use in main conversation
            </button>
          )}
        {copyText && (
          <button
            className="copy-message"
            onClick={copy}
            aria-label={`Copy ${name} message as Markdown`}
            title={
              copyState === 'copied'
                ? 'Copied Markdown'
                : copyState === 'failed'
                  ? 'Copy failed'
                  : 'Copy Markdown'
            }
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <rect x="9" y="9" width="11" height="11" rx="2" />
              <path d="M15 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h3" />
            </svg>
            <span aria-live="polite">{copyLabel}</span>
          </button>
        )}
      </div>
    </article>
  );
}

function agentDisplayName(value: string) {
  return value
    .split(/[:/_-]+/)
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(' ');
}

export function A2AActivityCard({
  activity,
  selectedName,
}: {
  activity: import('../../app/api').ActiveA2AActivity;
  selectedName: string;
}) {
  const recipient = agentDisplayName(activity.recipient?.agentId ?? selectedName);
  const sender = agentDisplayName(activity.parentAgentId ?? selectedName);
  const label = `Agent message · ${sender} → ${recipient}`;
  const items: ToolActivityItem[] = (activity.progress ?? []).flatMap((event, index) => {
    const type = event.type ?? 'activity';
    const data = event.data ?? {};
    const tool =
      typeof data.tool === 'string' ? data.tool : type.replace(/^tool\./, '').replace('.', ' ');
    return [
      {
        id: `${activity.id}:${index}`,
        label: chatToolIdentity(data)?.label ?? toolDisplayName(tool),
        status: type.endsWith('completed') ? (data.ok === false ? 'error' : 'ok') : 'pending',
      },
    ];
  });
  // A2A activity is supplemental operational context. The actual request and
  // reply are persisted as attributed `agent` chat turns above; never open this
  // tool-style card automatically, including while the delegated run is live.
  return (
    <details
      className={`tool-activity a2a-activity ${activity.status === 'running' || activity.status === 'streaming' ? 'live' : ''}`}
    >
      <summary>
        <span
          className={
            activity.status === 'running' || activity.status === 'streaming'
              ? 'tool-activity-spinner'
              : 'tool-activity-check'
          }
          aria-hidden="true"
        >
          {activity.status === 'running' || activity.status === 'streaming' ? '' : '✓'}
        </span>
        <strong>{label}</strong>
        <span className="tool-activity-chevron" aria-hidden="true">
          ⌄
        </span>
      </summary>
      <div className="tool-activity-list">
        {items.length ? (
          items.map((item) => (
            <div className="tool-activity-item" key={item.id}>
              <span className={`tool-dot ${item.status}`} aria-hidden="true">
                {item.status === 'error' ? '!' : item.status === 'pending' ? '·' : '✓'}
              </span>
              <strong>{item.label}</strong>
            </div>
          ))
        ) : (
          <div className="tool-activity-empty">
            {activity.status === 'replied' ? 'Agent replied' : 'Waiting for agent activity…'}
          </div>
        )}
      </div>
    </details>
  );
}

export function ToolActivityCard({ activity, live }: { activity: ToolActivity; live?: boolean }) {
  // Render a friendly label only; activity items remain the raw stored receipt.
  const items = (activity.items ?? []).map((item) => ({
    ...item,
    label: toolDisplayName(item.label),
  }));
  const activeItem = [...items].reverse().find((item) => item.status === 'pending') ?? items.at(-1);
  const label = live
    ? (activeItem?.label ?? 'Working through it')
    : `${items.length} runtime ${items.length === 1 ? 'action' : 'actions'}`;
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
  if (live)
    return (
      <details className="tool-activity live" onToggle={keepExpandedCardInView}>
        <summary>
          <span className="tool-activity-spinner" aria-hidden="true" />
          <strong>{label}</strong>
          <span className="tool-activity-chevron" aria-hidden="true">
            ⌄
          </span>
        </summary>
        <div className="tool-activity-list">
          {items.length ? (
            items.map((item, index) => (
              <div className="tool-activity-item" key={item.id || `${item.label}-${index}`}>
                <span className={`tool-dot ${item.status ?? 'pending'}`} aria-hidden="true">
                  {item.status === 'error' ? '!' : item.status === 'pending' ? '·' : '✓'}
                </span>
                <strong>{item.label}</strong>
              </div>
            ))
          ) : (
            <div className="tool-activity-empty">{label}</div>
          )}
        </div>
      </details>
    );
  return (
    <details className="tool-activity" onToggle={keepExpandedCardInView}>
      <summary>
        <span className="tool-activity-check" aria-hidden="true">
          ✓
        </span>
        <strong>{label}</strong>
        <span className="tool-activity-chevron" aria-hidden="true">
          ⌄
        </span>
      </summary>
      <div className="tool-activity-list">
        {items.length ? (
          items.map((item, index) => (
            <div className="tool-activity-item" key={item.id || `${item.label}-${index}`}>
              <span className={`tool-dot ${item.status ?? 'pending'}`} aria-hidden="true">
                {item.status === 'error' ? '!' : item.status === 'pending' ? '·' : '✓'}
              </span>
              <div>
                <strong>{item.label}</strong>
                {item.detail && <small title={item.detail}>{item.detail}</small>}
              </div>
            </div>
          ))
        ) : (
          <div className="tool-activity-empty">Waiting for the first tool call…</div>
        )}
      </div>
    </details>
  );
}
