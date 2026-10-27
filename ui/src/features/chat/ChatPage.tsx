import { reasoningEffortsForModel, defaultReasoningEffort } from '../../app/modelSelectionOptions';
import type { ChatLiveStage } from './chatLiveStage';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { ChatAttachment, ProgressEntry, SessionTurn, ToolActivity } from '../../app/api';
import type { Agent, SavedProvider, Subagent, Tab } from '../../app/types';
import { useComposerHistory } from './useComposerHistory';
import { ChatTranscript } from './ChatTranscript';
import { ChatComposer } from './ChatComposer';
import { useLiveSteering } from './useLiveSteering';
import { useChatInputs } from './useChatInputs';
import { pendingChatInput, reconcileChatInputs, type BusyIntent } from './chatInputs';
import { reconcileSteeringTurns } from './chatTurnReconciliation';
import { loadSwitchboardSessionLabels, type SwitchboardSessionLabel } from './telegramSessionLabels';
export { ChatMessage } from './ChatTranscript';
export { ChatComposer } from './ChatComposer';

type OperatorProfile = { name: string; avatar: string };

export function ChatModelSelector({ selected, savedProviders, updateAgent, sessions, sessionId, onSessionChange, onNewSession, onNewNamedSession, onCreateGroup, locked = false, isResettingSession = false }: { selected: Agent; savedProviders: SavedProvider[]; updateAgent: (patch: Partial<Agent>) => void | Promise<void>; sessions: import('../../app/api').SessionSummary[]; sessionId: string; onSessionChange: (sessionId: string) => void; onNewSession: () => void; onNewNamedSession: () => void; onCreateGroup: () => void; locked?: boolean; isResettingSession?: boolean }) {
  const provider = savedProviders.find((item) => item.provider === selected.provider) ?? savedProviders[0];
  const models = provider?.models ?? [];
  const model = models.includes(selected.model) ? selected.model : models[0] ?? '';
  const modelEfforts = provider?.modelEfforts?.[model] ?? [];
  // "off" is a runtime-supported override, even when a provider only advertises
  // its enabled reasoning levels for a model.
  const efforts = reasoningEffortsForModel(provider, model);
  const effort = efforts.includes(selected.effort) ? selected.effort : provider?.defaultEfforts?.[model] ?? modelEfforts[0] ?? 'off';
  const temperature = Number.isFinite(selected.temperature) ? Math.max(0, Math.min(2, selected.temperature)) : 0.2;
  const a2aInDefault = selected.contextConfig?.a2aInDefault !== false;
  const selectableSessions = sessions.filter((session) => {
    const id = session.id.toLowerCase();
    return session.metadata?.kind !== 'subagent'
      && session.metadata?.kind !== 'group'
      && !session.parentSessionId
      && session.ownerTaskId == null
      && !id.startsWith('group:')
      && !id.startsWith('group-')
      && !id.startsWith('artifact-');
  });
  const updateForModel = (next: SavedProvider | undefined, nextModel: string) => updateAgent({ provider: next?.provider ?? '', model: nextModel, effort: defaultReasoningEffort(next, nextModel) });
  const chooseProvider = (providerName: string) => { const next = savedProviders.find((item) => item.provider === providerName); updateForModel(next, next?.models[0] ?? ''); };
  const chooseModel = (nextModel: string) => updateForModel(provider, nextModel);
  const chooseTemperature = (value: string) => updateAgent({ temperature: Number(value) });
  const visibleSessions = !a2aInDefault && !selectableSessions.some((session) => session.id === 'a2a')
    ? [...selectableSessions, { id: 'a2a' }]
    : selectableSessions;
  // Keep the controlled value represented even while session metadata is pending
  // (including the synthetic inbox after routing returns to the default session).
  if (sessionId && !visibleSessions.some((session) => session.id === sessionId)) {
    visibleSessions.push({ id: sessionId });
  }
  const visibleSessionKey = visibleSessions.map((session) => session.id).join('\n');
  const [switchboardLabels, setSwitchboardLabels] = useState<Map<string, SwitchboardSessionLabel>>(new Map());
  useEffect(() => {
    const controller = new AbortController();
    void loadSwitchboardSessionLabels(visibleSessions.map((session) => session.id), controller.signal)
      .then(setSwitchboardLabels)
      .catch(() => { if (!controller.signal.aborted) setSwitchboardLabels(new Map()); });
    return () => controller.abort();
  }, [visibleSessionKey]);
  return <div className="workspace-toolbar"><label htmlFor="chat-provider">Provider <select id="chat-provider" name="provider" value={provider?.provider ?? ''} onChange={(e) => chooseProvider(e.target.value)} disabled={locked || !savedProviders.length}>{!savedProviders.length && <option value="">Configured runtime</option>}{savedProviders.map((item) => <option value={item.provider} key={item.id}>{item.provider}</option>)}</select></label><label htmlFor="chat-model">Model <select id="chat-model" name="model" value={model} onChange={(e) => chooseModel(e.target.value)} disabled={locked || !models.length}>{!models.length && <option value="">Configured runtime</option>}{models.map((item) => <option key={item} value={item}>{provider?.modelLabels?.[item] ?? item}</option>)}</select></label><label htmlFor="chat-effort">Effort <select id="chat-effort" name="effort" value={effort} onChange={(e) => updateAgent({ effort: e.target.value })} disabled={locked || !efforts.length}>{!efforts.length && <option value="">Not configured</option>}{efforts.map((item) => <option key={item}>{item}</option>)}</select></label><label className="temperature-control" htmlFor="chat-temperature">Temp <span>{temperature.toFixed(1)}</span><input id="chat-temperature" name="temperature" type="range" min="0" max="2" step="0.1" value={temperature} onChange={(e) => chooseTemperature(e.target.value)} disabled={locked || !provider} /></label><div className="session-controls"><button className="new-session group-chat-trigger" onClick={onCreateGroup} disabled={locked}>Group Chat</button><button className="new-session" onClick={onNewNamedSession} disabled={locked}>New session</button><button className="new-session" onClick={onNewSession} disabled={locked || isResettingSession}>{isResettingSession ? 'Resetting…' : 'Reset Session'}</button><label className="a2a-default-control" htmlFor="chat-a2a-in-default"><span>A2A in default</span><input id="chat-a2a-in-default" className="a2a-default-switch" type="checkbox" role="switch" checked={a2aInDefault} onChange={(event) => updateAgent({ contextConfig: { a2aInDefault: event.target.checked } })} /></label><label className="session-selector-control" htmlFor="chat-session"><span className="sr-only">Session</span><select id="chat-session" name="session" value={sessionId} onChange={(e) => onSessionChange(e.target.value)} disabled={!visibleSessions.length}>{visibleSessions.map((session) => { const label = switchboardLabels.get(session.id); return <option key={session.id} value={session.id} title={label?.title}>{label?.label ?? (session.id === 'a2a' ? 'A2A' : session.id)}</option>; })}</select></label></div></div>;
}

export function Chat({ selected, parent, operator, draft, setDraft, attached, onAttach, onRemoveAttachment, isNewSession, turns, isLoading, error, isSending, steeringReady, activeRunId, activeToolActivity, runtimeChildActivities, liveProgress, liveAnswer, liveStage, a2aActivities, runtimeUserMessage, runtimeUserMessageMetadata, onSend, onCancel, selectedAgentId, resourceAgentId, sessionId, composerResetGeneration = 0 }: { selected: Agent | Subagent; parent: Agent; operator: OperatorProfile; draft: string; setDraft: (value: string) => void; attached: ChatAttachment[]; onAttach: (files: File[]) => void; onRemoveAttachment: (index: number) => void; isNewSession: boolean; turns: SessionTurn[]; isLoading: boolean; error: string; isSending: boolean; steeringReady?: boolean; activeRunId: string; activeToolActivity?: ToolActivity; runtimeChildActivities?: ToolActivity[]; liveProgress: ProgressEntry[]; liveAnswer: string; liveStage?: ChatLiveStage; a2aActivities?: import('../../app/api').ActiveA2AActivity[]; runtimeUserMessage?: string; runtimeUserMessageMetadata?: SessionTurn['metadata']; onSend: (draft?: string, onAccepted?: () => void) => void; onCancel: () => void; selectedAgentId?: string; resourceAgentId?: string; sessionId?: string; composerResetGeneration?: number }) {
  const draftContext = `${selectedAgentId ?? ''}:${sessionId ?? ''}`;
  const [localDraft, setLocalDraft] = useState(draft);
  const localDraftRef = useRef(localDraft);
  const persistedDraftRef = useRef(draft);
  const draftContextRef = useRef(draftContext);
  const resetGenerationRef = useRef(composerResetGeneration);
  localDraftRef.current = localDraft;
  persistedDraftRef.current = draft;

  const persistDraft = useCallback((value = localDraftRef.current) => {
    if (value !== persistedDraftRef.current) setDraft(value);
  }, [setDraft]);

  useEffect(() => {
    if (draftContextRef.current === draftContext && resetGenerationRef.current === composerResetGeneration) return;
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
  const composerHistory = useComposerHistory(localDraft, turns.filter((turn) => turn.role === 'user').map((turn) => turn.content ?? ''), updateLocalDraft);
  const attachmentsRef = useRef(attached); attachmentsRef.current = attached;
  const steering = useLiveSteering(resourceAgentId ?? selected.id, sessionId ?? '', activeRunId, composerResetGeneration);
  const inputs = useChatInputs(resourceAgentId ?? selected.id, sessionId ?? '', composerResetGeneration);
  const transcriptTurns = useMemo(() => reconcileChatInputs(reconcileSteeringTurns(turns, steering.inputs), inputs.inputs), [turns, steering.inputs, inputs.inputs]);
  const [steeringError, setSteeringError] = useState('');
  const [intent, setIntent] = useState<BusyIntent>('queue_next');
  const [intentRunId, setIntentRunId] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const [promotion, setPromotion] = useState<string | null>(null);
  const context = useMemo(() => ({ key: JSON.stringify([draftContext, composerResetGeneration]) }), [draftContext, composerResetGeneration]);
  const currentContext = useRef(context); currentContext.current = context;
  useEffect(() => {
    currentContext.current = context;
    setIntent('queue_next'); setIntentRunId(''); setPromotion(null); setSteeringError(''); setSubmitting(false); submittingRef.current = false;
    return () => { if (currentContext.current === context) currentContext.current = { key: 'retired' }; };
  }, [context]);
  const backlog = inputs.inputs.some(input => input.intent === 'queue_next' && pendingChatInput(input));
  const explicitDelivery = isSending || backlog || intent !== 'queue_next';
  const exactTargetAvailable = Boolean(isSending && activeRunId && (!intentRunId || intentRunId === activeRunId));
  // Exact-run intents remain selected but unavailable when their target ends.
  // Never reinterpret a stale steer/side question as Send, or retarget a newer run.
  const chooseIntent = (next: BusyIntent) => { setIntent(next); setIntentRunId(activeRunId); };
  const promote = useCallback((id: string, text: string) => {
    setPromotion(id); setIntent('queue_next');
    updateLocalDraft(localDraftRef.current.trim() ? `${localDraftRef.current}\n\n${text}` : text);
    document.getElementById('chat-message')?.focus();
  }, [updateLocalDraft]);
  const sendLocalDraft = useCallback(() => {
    if (submittingRef.current || (intent !== 'queue_next' && !exactTargetAvailable)) return;
    const value = localDraftRef.current;
    const accepted = () => {
      if (currentContext.current !== context) return;
      if (localDraftRef.current === value) { setDraft(''); updateLocalDraft(''); }
      setIntent('queue_next'); setPromotion(null);
      for (let index = attachmentsRef.current.length - 1; index >= 0; index--) {
        if (attached.includes(attachmentsRef.current[index])) onRemoveAttachment(index);
      }
    };
    if (explicitDelivery || promotion) {
      const message = value.trim();
      if (!message && !attached.length) return;
      submittingRef.current = true; setSubmitting(true); setSteeringError('');
      const operation = intent === 'steer'
        ? steering.submit(message, attached, promotion && inputs.generation !== null ? { promotedFrom: promotion, generation: inputs.generation } : undefined)
        : inputs.submit(intent, message, attached, activeRunId, promotion);
      void operation.then(input => {
        if (!input || currentContext.current !== context) return;
        accepted();
      }).catch(error => {
        if (currentContext.current === context) setSteeringError(`Could not ${intent === 'steer' ? 'steer this run' : intent === 'side_question' ? 'ask this side question' : 'queue this message'}: ${error instanceof Error ? error.message : 'Unknown error'}. Your draft has been preserved.`);
      }).finally(() => { if (currentContext.current === context) { submittingRef.current = false; setSubmitting(false); } });
      return;
    }
    onSend(value, accepted);
  }, [onSend, setDraft, explicitDelivery, intent, attached, steering, inputs, onRemoveAttachment, promotion, activeRunId, context, updateLocalDraft, exactTargetAvailable]);
  const inputAction = useCallback((id: string, action: 'cancel' | 'resume') => {
    setSteeringError('');
    void inputs.action(id, action).catch(error => { if (currentContext.current === context) setSteeringError(`Could not ${action}: ${error instanceof Error ? error.message : 'Unknown error'}`); });
  }, [inputs.action, context]);

  return <div className="chat-view">
    <ChatTranscript selected={selected} parent={parent} operator={operator} isNewSession={isNewSession} turns={transcriptTurns} isLoading={isLoading} error={error} isSending={isSending} activeRunId={activeRunId} activeToolActivity={activeToolActivity} liveProgress={liveProgress} liveAnswer={liveAnswer} liveStage={liveStage} a2aActivities={a2aActivities} runtimeUserMessage={runtimeUserMessage} runtimeUserMessageMetadata={runtimeUserMessageMetadata} runtimeChildActivities={runtimeChildActivities} attachmentAgentId={resourceAgentId ?? selected.id} chatInputs={inputs.inputs} onPromote={promote} onInputAction={inputAction} inputActionPending={inputs.pending} />

    {intent !== 'queue_next' && !exactTargetAvailable && <p className="chat-promotion" role="status">The selected run is no longer active. Choose Queue next or select an intent for the current run.</p>}
    {inputs.error && <p className="error" role="alert">{inputs.error}</p>}
    {promotion && <div className="chat-promotion" role="status">Side answer staged for editing<button onClick={() => setPromotion(null)}>Remove link</button></div>}
    {steeringError && <p className="error" role="alert">{steeringError}</p>}
    <ChatComposer draft={localDraft} setDraft={composerHistory.setDraft} attached={attached} onAttach={onAttach} onRemoveAttachment={onRemoveAttachment} disabled={false} sendDisabled={submitting || (explicitDelivery && (intent === 'steer' ? !steeringReady || !exactTargetAvailable : intent === 'side_question' ? !exactTargetAvailable || inputs.generation === null : inputs.generation === null)) || Boolean(promotion && inputs.generation === null)} steeringActive={isSending} showIntent={explicitDelivery} busyIntent={intent} onIntentChange={chooseIntent} canSteer={Boolean(isSending && activeRunId && steeringReady)} canAskSide={Boolean(isSending && activeRunId)} onSend={sendLocalDraft} selectedAgentId={selectedAgentId} resourceAgentId={resourceAgentId} sessionId={sessionId} onCancel={onCancel} onKeyDown={composerHistory.onKeyDown} conversationTurns={transcriptTurns} assistantName={selected.name} operatorName={operator.name} agentNames={new Map([[parent.id, parent.name], [selected.id, selected.name]])} placeholder={isNewSession ? `Message ${selected.name}…` : 'Message the active agent…'} />
  </div>;
}

export function Editor({ tab, setTabs, onSave }: { tab: Tab; setTabs: Dispatch<SetStateAction<Tab[]>>; onSave: (tab: Tab, content: string) => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const loaded = tab.fileLoaded === true && !tab.fileLoading && !tab.fileError;
  const save = async () => {
    if (!loaded) return;
    setSaving(true);
    setError('');
    try {
      await onSave(tab, tab.content ?? '');
      setEditing(false);
    } catch (error) {
      setError(`Could not save ${tab.label}: ${(error as Error).message}`);
    } finally {
      setSaving(false);
    }
  };
  return <div className="editor-view"><div className="editor-toolbar"><span>{tab.path ?? tab.id}</span><button className={editing ? 'save' : ''} onClick={editing ? save : () => setEditing(true)} disabled={saving || !loaded}>{saving ? 'Saving…' : editing ? 'Save' : 'Edit'}</button></div>{tab.fileLoading && <p role="status">Loading…</p>}{tab.fileError && <p className="error" role="alert">{tab.fileError}</p>}{error && <p className="error" role="alert">{error}</p>}<textarea className="editor" value={tab.content} readOnly={!editing || saving || !loaded} onChange={(event) => setTabs((all) => all.map((item) => item.id === tab.id ? { ...item, content: event.target.value } : item))} spellCheck={false} aria-label={`Edit ${tab.label}`} /></div>;
}
