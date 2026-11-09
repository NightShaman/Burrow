import {
  loadSwitchboardSessionLabels,
  type SwitchboardSessionLabel,
} from './telegramSessionLabels';
import type { ChatLiveStage } from './chatLiveStage';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../app/api';
import type { ChatAttachment, ProgressEntry, SessionTurn, ToolActivity } from '../../app/api';
import type { Agent, Subagent } from '../../app/types';
import { useComposerHistory } from './useComposerHistory';
import { ChatTranscript } from './ChatTranscript';
import { ChatComposer } from './ChatComposer';
import { useLiveSteering } from './useLiveSteering';
import { useChatInputs } from './useChatInputs';
import { pendingChatInput, reconcileChatInputs, type BusyIntent } from './chatInputs';
import { reconcileSteeringTurns } from './chatTurnReconciliation';
export { ChatMessage } from './ChatTranscript';
export { ChatComposer } from './ChatComposer';

type OperatorProfile = { name: string; avatar: string };

export function Chat({
  selected,
  parent,
  agents,
  operator,
  draft,
  setDraft,
  attached,
  onAttach,
  onRemoveAttachment,
  isNewSession,
  turns,
  isLoading,
  onLoadOlder,
  hasOlder,
  isLoadingOlder,
  error,
  onDismissError,
  isSending,
  steeringReady,
  activeRunId,
  activeToolActivity,
  runtimeChildActivities,
  liveProgress,
  liveAnswer,
  liveStage,
  a2aActivities,
  runtimeUserMessage,
  runtimeUserMessageMetadata,
  onSend,
  onCancel,
  selectedAgentId,
  resourceAgentId,
  sessionId,
  composerResetGeneration = 0,
  selectionBlocked = false,
}: {
  selected: Agent | Subagent;
  parent: Agent;
  agents?: Agent[];
  operator: OperatorProfile;
  draft: string;
  setDraft: (value: string) => void;
  attached: ChatAttachment[];
  onAttach: (files: File[]) => void;
  onRemoveAttachment: (index: number) => void;
  isNewSession: boolean;
  turns: SessionTurn[];
  isLoading: boolean;
  error: string;
  onDismissError?: () => void;
  isSending: boolean;
  steeringReady?: boolean;
  activeRunId: string;
  activeToolActivity?: ToolActivity;
  runtimeChildActivities?: ToolActivity[];
  liveProgress: ProgressEntry[];
  liveAnswer: string;
  liveStage?: ChatLiveStage;
  a2aActivities?: import('../../app/api').ActiveA2AActivity[];
  onLoadOlder?: () => Promise<void>;
  hasOlder?: boolean;
  isLoadingOlder?: boolean;
  runtimeUserMessage?: string;
  runtimeUserMessageMetadata?: SessionTurn['metadata'];
  onSend: (draft?: string, onAccepted?: () => void) => void;
  onCancel: () => void;
  selectedAgentId?: string;
  resourceAgentId?: string;
  sessionId?: string;
  composerResetGeneration?: number;
  selectionBlocked?: boolean;
}) {
  // Show the owning conversation, not the child's stream id or the agent's
  // last selected chat. Nested minions share their recorded root session.
  const parentSessionId =
    'stream' in selected
      ? selected.rootSessionId ||
        (selected.depth === 1 ? selected.parentSessionId || undefined : undefined)
      : undefined;
  const [parentSessionLabel, setParentSessionLabel] = useState<{ id: string; label: string }>();
  useEffect(() => {
    if (!parentSessionId) return;
    const controller = new AbortController();
    void Promise.all([
      loadSwitchboardSessionLabels([parentSessionId], controller.signal).catch(
        () => new Map<string, SwitchboardSessionLabel>(),
      ),
      api<{ sessions: import('../../app/api').SessionSummary[] }>(
        `/api/sessions?agentId=${encodeURIComponent(parent.resourceId ?? parent.id)}`,
        { signal: controller.signal },
      ).catch(() => undefined),
    ])
      .then(([labels, detail]) => {
        if (!controller.signal.aborted)
          setParentSessionLabel({
            id: parentSessionId,
            label:
              detail?.sessions?.find((session) => session.id === parentSessionId)?.label ??
              labels.get(parentSessionId)?.label ??
              (parentSessionId === 'a2a' ? 'A2A' : parentSessionId),
          });
      })
      .catch(() => {
        /* The recorded session name remains available without Switchboard. */
      });
    return () => controller.abort();
  }, [parentSessionId, parent.id, parent.resourceId]);
  const parentSessionName =
    parentSessionId &&
    (parentSessionLabel?.id === parentSessionId
      ? parentSessionLabel.label
      : parentSessionId === 'a2a'
        ? 'A2A'
        : parentSessionId);
  const draftContext = `${selectedAgentId ?? ''}:${sessionId ?? ''}`;
  const [localDraft, setLocalDraft] = useState(draft);
  const localDraftRef = useRef(localDraft);
  const persistedDraftRef = useRef(draft);
  const draftContextRef = useRef(draftContext);
  const resetGenerationRef = useRef(composerResetGeneration);
  localDraftRef.current = localDraft;
  persistedDraftRef.current = draft;

  const persistDraft = useCallback(
    (value = localDraftRef.current) => {
      if (value !== persistedDraftRef.current) setDraft(value);
    },
    [setDraft],
  );

  useEffect(() => {
    if (
      draftContextRef.current === draftContext &&
      resetGenerationRef.current === composerResetGeneration
    )
      return;
    resetGenerationRef.current = composerResetGeneration;
    draftContextRef.current = draftContext;
    localDraftRef.current = draft;
    setLocalDraft(draft);
  }, [draft, draftContext, composerResetGeneration]);

  useEffect(() => {
    const timeout = window.setTimeout(() => persistDraft(), 250);
    return () => window.clearTimeout(timeout);
  }, [localDraft, persistDraft]);

  useEffect(() => {
    const flush = () => persistDraft();
    window.addEventListener('pagehide', flush);
    return () => {
      window.removeEventListener('pagehide', flush);
      persistDraft();
    };
  }, [persistDraft]);

  const updateLocalDraft = useCallback((value: string) => {
    localDraftRef.current = value;
    setLocalDraft(value);
  }, []);
  const composerHistory = useComposerHistory(
    localDraft,
    turns.filter((turn) => turn.role === 'user').map((turn) => turn.content ?? ''),
    updateLocalDraft,
  );
  const attachmentsRef = useRef(attached);
  attachmentsRef.current = attached;
  const steering = useLiveSteering(
    resourceAgentId ?? selected.id,
    sessionId ?? '',
    activeRunId,
    composerResetGeneration,
  );
  const inputs = useChatInputs(
    resourceAgentId ?? selected.id,
    sessionId ?? '',
    composerResetGeneration,
  );
  const transcriptTurns = useMemo(
    () => reconcileChatInputs(reconcileSteeringTurns(turns, steering.inputs), inputs.inputs),
    [turns, steering.inputs, inputs.inputs],
  );
  const [steeringError, setSteeringError] = useState('');
  const [intent, setIntent] = useState<BusyIntent>('queue_next');
  const [intentRunId, setIntentRunId] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const [promotion, setPromotion] = useState<string | null>(null);
  const context = useMemo(
    () => ({ key: JSON.stringify([draftContext, composerResetGeneration]) }),
    [draftContext, composerResetGeneration],
  );
  const currentContext = useRef(context);
  currentContext.current = context;
  useEffect(() => {
    currentContext.current = context;
    setIntent('queue_next');
    setIntentRunId('');
    setPromotion(null);
    setSteeringError('');
    setSubmitting(false);
    submittingRef.current = false;
    return () => {
      if (currentContext.current === context) currentContext.current = { key: 'retired' };
    };
  }, [context]);
  const backlog = inputs.inputs.some(
    (input) => input.intent === 'queue_next' && pendingChatInput(input),
  );
  const explicitDelivery = isSending || backlog || intent !== 'queue_next';
  const exactTargetAvailable = Boolean(
    isSending && activeRunId && (!intentRunId || intentRunId === activeRunId),
  );
  // Exact-run intents remain selected but unavailable when their target ends.
  // Never reinterpret a stale steer/side question as Send, or retarget a newer run.
  const chooseIntent = (next: BusyIntent) => {
    setIntent(next);
    setIntentRunId(activeRunId);
  };
  const promote = useCallback(
    (id: string, text: string) => {
      setPromotion(id);
      setIntent('queue_next');
      updateLocalDraft(localDraftRef.current.trim() ? `${localDraftRef.current}\n\n${text}` : text);
      document.getElementById('chat-message')?.focus();
    },
    [updateLocalDraft],
  );
  const sendLocalDraft = useCallback(() => {
    if (submittingRef.current || (intent !== 'queue_next' && !exactTargetAvailable)) return;
    const value = localDraftRef.current;
    const accepted = () => {
      if (currentContext.current !== context) return;
      if (localDraftRef.current === value) {
        setDraft('');
        updateLocalDraft('');
      }
      setIntent('queue_next');
      setPromotion(null);
      for (let index = attachmentsRef.current.length - 1; index >= 0; index--) {
        if (attached.includes(attachmentsRef.current[index])) onRemoveAttachment(index);
      }
    };
    if (explicitDelivery || promotion) {
      const message = value.trim();
      if (!message && !attached.length) return;
      submittingRef.current = true;
      setSubmitting(true);
      setSteeringError('');
      const operation =
        intent === 'steer'
          ? steering.submit(
              message,
              attached,
              promotion && inputs.generation !== null
                ? { promotedFrom: promotion, generation: inputs.generation }
                : undefined,
            )
          : inputs.submit(intent, message, attached, activeRunId, promotion);
      void operation
        .then((input) => {
          if (!input || currentContext.current !== context) return;
          accepted();
        })
        .catch((error) => {
          if (currentContext.current === context)
            setSteeringError(
              `Could not ${intent === 'steer' ? 'steer this run' : intent === 'side_question' ? 'ask this side question' : 'queue this message'}: ${error instanceof Error ? error.message : 'Unknown error'}. Your draft has been preserved.`,
            );
        })
        .finally(() => {
          if (currentContext.current === context) {
            submittingRef.current = false;
            setSubmitting(false);
          }
        });
      return;
    }
    if (!selectionBlocked) onSend(value, accepted);
  }, [
    onSend,
    setDraft,
    explicitDelivery,
    intent,
    attached,
    steering,
    inputs,
    onRemoveAttachment,
    promotion,
    activeRunId,
    context,
    updateLocalDraft,
    exactTargetAvailable,
    selectionBlocked,
  ]);
  const inputAction = useCallback(
    (id: string, action: 'cancel' | 'resume') => {
      setSteeringError('');
      void inputs.action(id, action).catch((error) => {
        if (currentContext.current === context)
          setSteeringError(
            `Could not ${action}: ${error instanceof Error ? error.message : 'Unknown error'}`,
          );
      });
    },
    [inputs.action, context],
  );

  return (
    <div className="chat-view">
      <ChatTranscript
        selected={selected}
        parent={parent}
        agents={agents}
        parentSessionName={parentSessionName}
        operator={operator}
        isNewSession={isNewSession}
        turns={transcriptTurns}
        isLoading={isLoading}
        onLoadOlder={onLoadOlder}
        hasOlder={hasOlder}
        isLoadingOlder={isLoadingOlder}
        error={error}
        onDismissError={onDismissError}
        isSending={isSending}
        activeRunId={activeRunId}
        activeToolActivity={activeToolActivity}
        liveProgress={liveProgress}
        liveAnswer={liveAnswer}
        liveStage={liveStage}
        a2aActivities={a2aActivities}
        runtimeUserMessage={runtimeUserMessage}
        runtimeUserMessageMetadata={runtimeUserMessageMetadata}
        runtimeChildActivities={runtimeChildActivities}
        attachmentAgentId={resourceAgentId ?? selected.id}
        chatInputs={inputs.inputs}
        onPromote={promote}
        onInputAction={inputAction}
        inputActionPending={inputs.pending}
      />

      {intent !== 'queue_next' && !exactTargetAvailable && (
        <p className="chat-promotion" role="status">
          The selected run is no longer active. Choose Queue next or select an intent for the
          current run.
        </p>
      )}
      {inputs.error && (
        <p className="error" role="alert">
          {inputs.error}
        </p>
      )}
      {promotion && (
        <div className="chat-promotion" role="status">
          Side answer staged for editing
          <button onClick={() => setPromotion(null)}>Remove link</button>
        </div>
      )}
      {steeringError && (
        <p className="error" role="alert">
          {steeringError}
        </p>
      )}
      <ChatComposer
        draft={localDraft}
        setDraft={composerHistory.setDraft}
        attached={attached}
        onAttach={onAttach}
        onRemoveAttachment={onRemoveAttachment}
        disabled={false}
        sendDisabled={
          selectionBlocked ||
          submitting ||
          (explicitDelivery &&
            (intent === 'steer'
              ? !steeringReady || !exactTargetAvailable
              : intent === 'side_question'
                ? !exactTargetAvailable || inputs.generation === null
                : inputs.generation === null)) ||
          Boolean(promotion && inputs.generation === null)
        }
        steeringActive={isSending}
        showIntent={explicitDelivery}
        busyIntent={intent}
        onIntentChange={chooseIntent}
        canSteer={Boolean(isSending && activeRunId && steeringReady)}
        canAskSide={Boolean(isSending && activeRunId)}
        onSend={sendLocalDraft}
        selectedAgentId={selectedAgentId}
        resourceAgentId={resourceAgentId}
        sessionId={sessionId}
        onCancel={onCancel}
        onKeyDown={composerHistory.onKeyDown}
        conversationTurns={transcriptTurns}
        assistantName={selected.name}
        operatorName={operator.name}
        agentNames={
          new Map([
            [parent.id, parent.name],
            [selected.id, selected.name],
          ])
        }
        placeholder={isNewSession ? `Message ${selected.name}…` : 'Message the active agent…'}
      />
    </div>
  );
}

export { ChatModelSelector } from './ChatModelSelector';
export { Editor } from './WorkspaceEditor';
