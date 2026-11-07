import { contextReport } from './contextReport';
import type { ChatInput } from './chatInputs';
import { chatTerminalMetadata } from './chatTerminal';
import type { ChatLiveStage } from './chatLiveStage';
import { memo } from 'react';
import { useTranscriptScroll } from './useTranscriptScroll';
import {
  textFromChatValue,
  type ProgressEntry,
  type SessionTurn,
  type ToolActivity,
} from '../../app/api';
import type { Agent, Subagent } from '../../app/types';
import {
  ChatMessage,
  formatTime,
  A2AActivityCard,
  ToolActivityCard,
  LiveAssistantTurn,
} from './ChatMessage';

export type OperatorProfile = { name: string; avatar: string };

function isChatCommand(value: string) {
  return /^\/[A-Za-z][A-Za-z0-9_-]*(?:\s+.*)?$/u.test(value.trim());
}

type ChatTranscriptProps = {
  chatInputs?: ChatInput[];
  onPromote?: (id: string, text: string) => void;
  onInputAction?: (id: string, action: 'cancel' | 'resume') => void;
  inputActionPending?: string;
  selected: Agent | Subagent;
  parent: Agent;
  parentSessionName?: string;
  operator: OperatorProfile;
  isNewSession: boolean;
  turns: SessionTurn[];
  isLoading: boolean;
  onLoadOlder?: () => Promise<void>;
  hasOlder?: boolean;
  isLoadingOlder?: boolean;
  error: string;
  onDismissError?: () => void;
  isSending: boolean;
  activeRunId: string;
  activeToolActivity?: ToolActivity;
  liveProgress: ProgressEntry[];
  liveAnswer: string;
  liveStage?: ChatLiveStage;
  a2aActivities?: import('../../app/api').ActiveA2AActivity[];
  runtimeUserMessage?: string;
  runtimeUserMessageMetadata?: SessionTurn['metadata'];
  runtimeChildActivities?: ToolActivity[];
  attachmentAgentId?: string;
};

export const ChatTranscript = memo(function ChatTranscript({
  selected,
  parent,
  parentSessionName,
  operator,
  isNewSession,
  turns,
  isLoading,
  onLoadOlder,
  hasOlder,
  isLoadingOlder,
  error,
  onDismissError,
  isSending,
  activeRunId,
  activeToolActivity,
  liveProgress,
  liveAnswer,
  liveStage,
  a2aActivities = [],
  runtimeUserMessage = '',
  runtimeUserMessageMetadata,
  runtimeChildActivities = [],
  attachmentAgentId,
  chatInputs = [],
  onPromote,
  onInputAction,
  inputActionPending,
}: ChatTranscriptProps) {
  const isSubagent = 'stream' in selected;
  const messages = turns.filter(
    (turn) =>
      (turn.type === 'message' ||
        (turn.type === 'event' &&
          turn.role === 'user' &&
          (turn.metadata?.visibility === 'chat' || turn.metadata?.chatInput))) &&
      turn.metadata?.visibility !== 'debug' &&
      turn.metadata?.kind !== 'subagent-runtime-context' &&
      turn.metadata?.kind !== 'subagent-task' &&
      (turn.content ||
        (turn.role === 'assistant' &&
          chatTerminalMetadata(turn.metadata)?.terminalStatus !== undefined &&
          chatTerminalMetadata(turn.metadata)?.terminalStatus !== 'completed') ||
        turn.metadata?.attachments?.length ||
        turn.metadata?.outputArtifacts?.length ||
        (turn.role === 'assistant' &&
          turn.metadata?.kind === 'context-command-report' &&
          contextReport(turn.metadata.contextReport))) &&
      (turn.role === 'user' || turn.role === 'assistant' || turn.role === 'agent') &&
      !(
        turn.role === 'user' &&
        !turn.metadata?.chatInput &&
        isChatCommand(textFromChatValue(turn.content)) &&
        !/^\/compact$/i.test(textFromChatValue(turn.content).trim())
      ),
  );
  // Provider role=user is not speaker identity. Workflow and delegation
  // provenance (including legacy saved markers) identify non-operator input.
  const userIdentity = (metadata?: SessionTurn['metadata']) => {
    if (metadata?.source === 'workflow-event')
      return {
        name: `GitHub · ${metadata.completionEvent?.workflow?.trim() || 'workflow event'}`,
        avatar: 'G',
      };
    const delegated =
      metadata?.kind === 'subagent-delegated-task' ||
      Boolean(metadata?.parentAgentId) ||
      (isSubagent && Boolean(metadata?.workerProfile || metadata?.subagentId));
    if (!delegated)
      return {
        name: operator.name,
        avatar: operator.avatar || operator.name.slice(0, 1).toUpperCase(),
      };
    const parentId = metadata?.parentAgentId;
    const knownParent = Boolean(parentId && [parent.id, parent.resourceId].includes(parentId));
    const name = knownParent ? parent.name : parentId || 'Parent agent';
    return { name, avatar: (knownParent && parent.avatar) || name.slice(0, 1).toUpperCase() };
  };
  const runtimeIdentity = userIdentity(runtimeUserMessageMetadata);
  const inputById = new Map(chatInputs.map((input) => [input.id, input]));
  const activityByRun = new Map<string, ToolActivity>();
  for (const turn of turns) {
    const activity = turn.metadata?.toolActivity;
    if (activity && (turn.runId || activity.runId))
      activityByRun.set(turn.runId || activity.runId || '', activity);
  }
  const activeActivity = activeRunId
    ? (activeToolActivity ?? activityByRun.get(activeRunId))
    : undefined;
  const visibleRuntimeChildActivities = runtimeChildActivities.filter(
    (activity) => activity.runId !== activeActivity?.runId,
  );
  // An externally started task run can reach this destination session before
  // its first durable turn. Keep the live run visible instead of replacing it
  // with the empty-session watermark.
  const isEmptySession =
    !isLoading &&
    !isSending &&
    !runtimeUserMessage &&
    !a2aActivities.length &&
    !visibleRuntimeChildActivities.length &&
    (isNewSession || !messages.length);
  const { messagesRef, showJumpToLatest, updateScrollIntent, loadOlder, jumpToLatest } =
    useTranscriptScroll({
      isLoading,
      isNewSession,
      messageCount: messages.length,
      isSending,
      liveProgress,
      liveAnswer,
      activeActivity,
      chatInputs,
      error,
      onLoadOlder,
    });
  return (
    <div className="chat-transcript">
      <div
        className={`chat-messages ${isEmptySession ? 'new-session-view' : ''}`}
        ref={messagesRef}
        onScroll={updateScrollIntent}
        aria-busy={isLoading || isSending}
      >
        {isEmptySession ? (
          <div className="new-session-empty">
            <img src="/burrow-logo.png" alt="Burrow" />
          </div>
        ) : (
          <>
            {hasOlder && onLoadOlder && (
              <button className="secondary" disabled={isLoadingOlder} onClick={loadOlder}>
                {isLoadingOlder ? 'Loading older messages…' : 'Load older messages'}
              </button>
            )}
            {isSubagent && (
              <div className="stream-banner">
                <span>Minion stream</span>
                <strong>{selected.name}</strong>
                <small>
                  Workspace remains attached to {parent.name}
                  {parentSessionName && <> · {parentSessionName}</>}
                </small>
              </div>
            )}
            {isLoading && (
              <p className="chat-state">
                {messages.length ? 'Refreshing conversation…' : 'Loading conversation…'}
              </p>
            )}
            {runtimeUserMessage &&
              !messages.some(
                (turn) =>
                  turn.role === 'user' &&
                  (!activeRunId || turn.runId === activeRunId) &&
                  textFromChatValue(turn.content) === runtimeUserMessage,
              ) && (
                <ChatMessage
                  side="operator"
                  name={runtimeIdentity.name}
                  avatar={runtimeIdentity.avatar}
                  time="Now"
                  text={runtimeUserMessage}
                />
              )}
            {messages.map((turn, index) => {
              const { name: userName, avatar: userAvatar } = userIdentity(turn.metadata);
              const isAgentMessage = turn.role === 'agent';
              const fromCurrentAgent = turn.metadata?.fromAgentId === selected.id;
              const senderName =
                turn.metadata?.fromAgentName ?? turn.metadata?.fromAgentId ?? 'Agent';
              const recipientName = turn.metadata?.toAgentId ?? selected.name;
              const messageName = isAgentMessage
                ? `${senderName} → ${recipientName}`
                : selected.name;
              const persistedActivity = turn.metadata?.toolActivity;
              const isPersistedTerminalTurn =
                turn.role === 'assistant' &&
                turn.runId === activeRunId &&
                Boolean(
                  turn.metadata?.progress ||
                    persistedActivity ||
                    turn.content ||
                    chatTerminalMetadata(turn.metadata),
                );
              return (
                <ChatMessage
                  chatInput={turn.metadata?.chatInput}
                  input={
                    turn.metadata?.chatInput ? inputById.get(turn.metadata.chatInput.id) : undefined
                  }
                  onPromote={onPromote}
                  onInputAction={onInputAction}
                  inputActionPending={inputActionPending}
                  key={`${turn.runId ?? 'turn'}-${index}`}
                  side={
                    turn.role === 'user' || (isAgentMessage && !fromCurrentAgent)
                      ? 'operator'
                      : 'agent'
                  }
                  name={
                    turn.role === 'user' ? userName : isAgentMessage ? messageName : selected.name
                  }
                  avatar={
                    turn.role === 'user'
                      ? userAvatar
                      : isAgentMessage && !fromCurrentAgent
                        ? senderName.slice(0, 1).toUpperCase()
                        : selected.avatar
                  }
                  time={
                    turn.metadata?.steering
                      ? `${formatTime(turn.ts)} · ${turn.metadata.steering.status === 'pending' ? 'Pending — next model boundary' : turn.metadata.steering.status === 'delivered' ? 'Delivered to run' : 'Not delivered — retained as follow-up'}`
                      : formatTime(turn.ts)
                  }
                  text={textFromChatValue(turn.content)}
                  activity={
                    turn.role === 'assistant'
                      ? (persistedActivity ??
                        (turn.runId === activeRunId
                          ? activeActivity
                          : activityByRun.get(turn.runId ?? '')))
                      : undefined
                  }
                  progress={turn.role === 'assistant' ? turn.metadata?.progress : undefined}
                  terminal={
                    turn.role === 'assistant' ? chatTerminalMetadata(turn.metadata) : undefined
                  }
                  streamedAnswer={
                    turn.role === 'assistant' ? turn.metadata?.streamedAnswer : undefined
                  }
                  report={
                    turn.role === 'assistant' && turn.metadata?.kind === 'context-command-report'
                      ? contextReport(turn.metadata.contextReport)
                      : undefined
                  }
                  activityLive={
                    turn.role === 'assistant' &&
                    turn.runId === activeRunId &&
                    !isPersistedTerminalTurn
                  }
                  attachments={turn.metadata?.attachments}
                  outputArtifacts={
                    turn.role === 'assistant' ? turn.metadata?.outputArtifacts : undefined
                  }
                  attachmentAgentId={attachmentAgentId ?? parent.id}
                />
              );
            })}
            {a2aActivities.length > 0 && (
              <section className="a2a-activity-list" aria-label="Agent-to-agent activity">
                {a2aActivities.map((activity) => (
                  <A2AActivityCard
                    key={activity.id}
                    activity={activity}
                    selectedName={selected.name}
                  />
                ))}
              </section>
            )}
            {visibleRuntimeChildActivities.length > 0 && (
              <section className="a2a-activity-list" aria-label="Minion activity">
                {visibleRuntimeChildActivities.map((activity) => (
                  <ToolActivityCard
                    key={activity.runId}
                    activity={activity}
                    live={activity.status === 'running'}
                  />
                ))}
              </section>
            )}
            {isSending &&
              !messages.some(
                (turn) =>
                  turn.role === 'assistant' &&
                  turn.runId === activeRunId &&
                  Boolean(
                    turn.metadata?.progress ||
                      turn.metadata?.toolActivity ||
                      turn.content ||
                      chatTerminalMetadata(turn.metadata),
                  ),
              ) && (
                <LiveAssistantTurn
                  name={selected.name}
                  avatar={selected.avatar}
                  progress={liveProgress}
                  activity={activeActivity}
                  answer={liveAnswer}
                  stage={liveStage}
                />
              )}
          </>
        )}
        {error && (
          <div className="chat-error" role="alert">
            <span>{error}</span>
            {onDismissError && (
              <button
                type="button"
                className="secondary"
                onClick={onDismissError}
                aria-label="Dismiss chat error"
              >
                Dismiss
              </button>
            )}
          </div>
        )}
      </div>
      {showJumpToLatest && (
        <button
          type="button"
          className="chat-jump-latest"
          aria-label="Jump to latest message"
          title="Jump to latest message"
          onClick={jumpToLatest}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 4v16m-6-6 6 6 6-6" />
          </svg>
        </button>
      )}
    </div>
  );
});

export { ChatMessage, TerminalErrorCard, formatTime } from './ChatMessage';
