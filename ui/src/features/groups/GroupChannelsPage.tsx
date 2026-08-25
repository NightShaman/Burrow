import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { api, attachmentDisplayName } from '../../app/api';
import type { Agent } from '../../app/types';
import type { ChatAttachment, RunProgress, SessionTurn, ToolActivity } from '../../app/api';
import { ChatComposer, ChatMessage } from '../chat/ChatPage';
import { useComposerHistory } from '../chat/useComposerHistory';

type GroupTurn = { id: string; content: string; createdAt?: string; authorName: string; authorId?: string; role?: string; metadata?: Record<string, unknown> };
type GroupRun = { runId: string; agentId: string; status?: string; sessionId?: string };
type GroupChannel = { id: string; name: string; description?: string; participantAgentIds: string[]; turns: GroupTurn[]; runs: GroupRun[] };

const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' ? value as Record<string, unknown> : {};
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const text = (value: unknown, fallback = '') => typeof value === 'string' ? value : fallback;

function normalizeTurn(value: unknown, index: number): GroupTurn {
  const item = record(value);
  const metadata = record(item.metadata);
  const provenance = record(metadata.provenance);
  const authorId = text(provenance.agentId) || text(metadata.fromAgentId) || text(item.agentId) || text(item.authorId);
  return {
    id: text(item.id) || `turn-${index}`,
    content: text(item.content) || text(item.message) || text(item.text),
    createdAt: text(item.createdAt) || text(item.timestamp),
    authorId,
    role: text(item.role) || text(metadata.role),
    authorName: text(provenance.agentName) || text(metadata.fromAgentName) || text(item.authorName) || text(item.agentName) || (text(item.role, 'Operator').toLowerCase() === 'user' ? 'You' : (authorId || 'Agent')),
    metadata,
  };
}

function normalizeChannel(value: unknown): GroupChannel {
  const item = record(value);
  const runs = array(item.runs).map((run) => {
    const current = record(run);
    return { runId: text(current.runId) || text(current.id), agentId: text(current.agentId), status: text(current.status), sessionId: text(current.sessionId) };
  }).filter((run) => run.runId && run.agentId);
  return {
    id: text(item.id) || text(item.channelId),
    name: text(item.name) || text(item.title) || 'Untitled group chat',
    description: text(item.description) || text(item.topic),
    participantAgentIds: array(item.participantAgentIds).filter((id): id is string => typeof id === 'string'),
    turns: array(item.turns ?? item.messages ?? item.transcript).map(normalizeTurn),
    runs,
  };
}

function timeLabel(value?: string) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(date);
}

function avatarImage(value?: string) {
  const avatar = value?.trim() || '';
  return /^(?:data:image\/[\w+.-]+;base64,|https?:\/\/|blob:|\/)/.test(avatar) ? avatar : null;
}

export function getMentionMatch(value: string) {
  return value.match(/(^|\s)@([\w-]*)$/);
}

export function insertMention(value: string, mentionStart: number, queryLength: number, agentName: string) {
  if (mentionStart < 0) return value;
  return `${value.slice(0, mentionStart)}@${agentName}${value.slice(mentionStart + queryLength + 1)}`;
}

type OperatorProfile = { id?: string; name: string; avatar: string };

export function GroupChannelsPage({ channelId, agents, operator }: { channelId: string; agents: Agent[]; operator?: OperatorProfile }) {
  const [channel, setChannel] = useState<GroupChannel | null>(null);
  const [identityAvatars, setIdentityAvatars] = useState<Record<string, string>>({});
  const [operatorIdentity, setOperatorIdentity] = useState<OperatorProfile | undefined>(operator);
  const [message, setMessage] = useState('');
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionStart, setMentionStart] = useState(-1);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [attached, setAttached] = useState<ChatAttachment[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    if (!channelId) return;
    const response = await api<{ channel?: unknown; turns?: unknown; runs?: unknown }>(`/api/group-channels/${encodeURIComponent(channelId)}`);
    const channelValue = record(response.channel ?? response);
    setChannel(normalizeChannel({ ...channelValue, turns: channelValue.turns ?? response.turns, runs: channelValue.runs ?? response.runs }));
  }, [channelId]);
  useEffect(() => { setError(''); load().catch((reason: Error) => setError(`Could not load group chat: ${reason.message}`)); }, [load]);
  useEffect(() => {
    api<{ operator?: unknown; agents?: Array<{ id?: string; avatar?: string }> }>('/api/settings/identities')
      .then((response) => {
        const persistedOperator = record(response.operator);
        if (persistedOperator.id || persistedOperator.name || persistedOperator.avatar) {
          setOperatorIdentity({ id: text(persistedOperator.id) || undefined, name: text(persistedOperator.name, operator?.name || 'You'), avatar: text(persistedOperator.avatar, operator?.avatar || '') });
        }
        setIdentityAvatars(Object.fromEntries(array(response.agents).map((item) => [text(record(item).id), text(record(item).avatar)]).filter(([id, avatar]) => id && avatar)));
      })
      .catch(() => undefined);
  }, [operator]);
  useEffect(() => {
    if (!channel?.runs.length) return;
    const timer = window.setInterval(() => { void load().catch((reason: Error) => setError(`Could not refresh group chat: ${reason.message}`)); }, 2_000);
    return () => window.clearInterval(timer);
  }, [channel?.runs.length, load]);
  const agentById = useMemo(() => new Map(agents.map((agent) => [agent.id, agent])), [agents]);
  const mentionCandidates = useMemo(() => {
    if (mentionQuery === null || !channel) return [];
    const query = mentionQuery.toLowerCase();
    return channel.participantAgentIds
      .map((id) => agentById.get(id))
      .filter((agent): agent is Agent => Boolean(agent && agent.name.toLowerCase().includes(query)))
      .slice(0, 6);
  }, [agentById, channel, mentionQuery]);
  function updateMessage(value: string) {
    setMessage(value);
    const match = getMentionMatch(value);
    if (!match) { setMentionQuery(null); setMentionStart(-1); return; }
    setMentionQuery(match[2]); setMentionStart(value.length - match[2].length - 1); setMentionIndex(0);
  }
  const composerHistory = useComposerHistory(message, (channel?.turns ?? []).filter((turn) => ['user', 'operator', 'human'].includes((turn.role || '').toLowerCase())).map((turn) => turn.content), updateMessage);
  function chooseMention(agent: Agent) {
    if (mentionStart < 0) return;
    setMessage(insertMention(message, mentionStart, mentionQuery?.length || 0, agent.name));
    setMentionQuery(null); setMentionStart(-1);
  }
  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (mentionCandidates.length && (event.key === 'Tab' || event.key === 'Enter')) {
      event.preventDefault(); chooseMention(mentionCandidates[mentionIndex]); return;
    }
    if (mentionCandidates.length && event.key === 'ArrowDown') { event.preventDefault(); setMentionIndex((index) => (index + 1) % mentionCandidates.length); }
    if (mentionCandidates.length && event.key === 'ArrowUp') { event.preventDefault(); setMentionIndex((index) => (index + mentionCandidates.length - 1) % mentionCandidates.length); }
    if (event.key === 'Escape') setMentionQuery(null);
    composerHistory.onKeyDown(event);
  }
  async function send() {
    // Keep the original composer value intact: the backend owns mention parsing
    // and delivery routing. Only use trim() to decide whether the composer is empty.
    const content = message || (attached.length ? 'Please analyze the attached files.' : '');
    if (!content.trim() || sending) return;
    setSending(true); setError('');
    try {
      await api<{ ok: true; channelId: string; operatorTurn?: unknown; runs?: GroupRun[] }>(`/api/group-channels/${encodeURIComponent(channelId)}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: content, ...(attached.length ? { attachments: attached } : {}) }) });
      setMessage(''); setAttached([]); await load();
    } catch (reason) { setError(`Could not send message: ${(reason as Error).message}`); }
    finally { setSending(false); }
  }
  function attachImage(files: File[]) { files.forEach((file, index) => {
    const supported = file.type.startsWith('image/') || file.type.startsWith('text/') || ['application/json', 'application/xml', 'application/rtf'].includes(file.type) || /\.(txt|md|markdown|json|csv|xml|html?|css|js|ts|tsx|jsx|py|rb|go|rs|java|c|cpp|h|yaml|yml|rtf)$/i.test(file.name);
    if (!supported || file.size > 22_000_000) return;
    const reader = new FileReader();
    reader.onload = () => { const content = reader.result; if (typeof content === 'string') setAttached((current) => [...current, { name: attachmentDisplayName(file, index + 1), type: file.type, size: file.size, encoding: 'data-url', content }]); };
    reader.readAsDataURL(file);
  }); }

  const messagesRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const updateScrollIntent = () => {
    const container = messagesRef.current;
    if (!container) return;
    stickToBottomRef.current = container.scrollHeight - container.scrollTop - container.clientHeight < 48;
  };
  useLayoutEffect(() => {
    const container = messagesRef.current;
    if (container && stickToBottomRef.current) container.scrollTop = container.scrollHeight;
  }, [channel?.turns.length, channel?.runs.length, error]);

  async function cancel(run: GroupRun) {
    try {
      await api(`/api/group-channels/${encodeURIComponent(channelId)}/runs/${encodeURIComponent(run.runId)}/cancel`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) });
      await load();
    } catch (reason) { setError(`Could not cancel run: ${(reason as Error).message}`); }
  }
  if (!channel) return <div className="group-page"><div className="group-empty">{error || 'Loading group chat…'}</div></div>;
  return <div className="group-page">
    <main className="group-transcript">
      <div className="group-agent-overlay" aria-label="Group members">
        {channel.participantAgentIds.map((id) => {
          const agent = agentById.get(id); const run = channel.runs.find((item) => item.agentId === id); const image = avatarImage(identityAvatars[id] || agent?.avatar);
          return <div className="group-agent" key={id} title={`${agent?.name || id}${run ? ` · ${run.status || 'Working'}` : ''}`}>
            <span className="group-avatar">{image ? <img src={image} alt="" /> : agent?.name.slice(0, 1) || '?'}</span>
            {run && <span className="group-agent-state" aria-label="Working" />}
            {run && <button className="group-cancel" onClick={() => void cancel(run)} aria-label={`Stop ${agent?.name || id}`}>×</button>}
          </div>;
        })}
      </div>
      {error && <p className="group-error">{error}</p>}
      <div className="group-messages" ref={messagesRef} onScroll={updateScrollIntent} aria-busy={Boolean(channel.runs.length)}>
        {channel.turns.length ? channel.turns.map((turn) => {
          const agent = turn.authorId ? agentById.get(turn.authorId) : undefined;
          const isOperator = !turn.authorId && ['user', 'operator', 'human'].includes((turn.role || '').toLowerCase());
          const avatar = isOperator ? (operatorIdentity?.avatar || operator?.avatar || 'You') : (identityAvatars[turn.authorId || ''] || agent?.avatar || turn.authorName.slice(0, 1).toUpperCase());
          const activity = turn.metadata?.toolActivity as ToolActivity | undefined;
          const progress = turn.metadata?.progress as RunProgress | undefined;
          return <ChatMessage key={turn.id} side={isOperator ? 'operator' : 'agent'} name={isOperator ? (operatorIdentity?.name || operator?.name || turn.authorName) : turn.authorName} avatar={avatar} time={timeLabel(turn.createdAt) || 'Now'} text={turn.content} activity={activity} progress={progress} activityLive={Boolean(activity && !turn.content)} attachments={Array.isArray(turn.metadata?.attachments) ? turn.metadata.attachments as never : []} />;
        }) : <div className="group-empty"><h2>No messages yet</h2><p>Send a message to start the group chat.</p></div>}
      </div>
      <div className="group-composer">
        {mentionCandidates.length > 0 && <div className="group-mention-menu" role="listbox" aria-label="Mention an agent">
          {mentionCandidates.map((agent, index) => <button type="button" role="option" aria-selected={index === mentionIndex} className={index === mentionIndex ? 'is-active' : ''} key={agent.id} onMouseDown={(event) => { event.preventDefault(); chooseMention(agent); }}><span>@{agent.name}</span><small>Tab to insert</small></button>)}
        </div>}
        <ChatComposer draft={message} setDraft={composerHistory.setDraft} onKeyDown={handleComposerKeyDown} attached={attached} onAttach={attachImage} onRemoveAttachment={(index) => setAttached((current) => current.filter((_, attachmentIndex) => attachmentIndex !== index))} disabled={sending} onSend={() => void send()} conversationTurns={channel.turns.map((turn): SessionTurn => ({ role: turn.role, content: turn.content, ts: turn.createdAt, metadata: turn.metadata }))} placeholder="Message the group…" />
      </div>
    </main>
  </div>;
}
