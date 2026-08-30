import { useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { ChatAttachment, ProgressEntry, SessionTurn, ToolActivity } from '../../app/api';
import type { Agent, SavedProvider, Subagent, Tab } from '../../app/types';
import { useComposerHistory } from './useComposerHistory';
import { ChatTranscript } from './ChatTranscript';
import { ChatComposer } from './ChatComposer';
export { ChatMessage } from './ChatTranscript';
export { ChatComposer } from './ChatComposer';

type OperatorProfile = { name: string; avatar: string };

export function ChatModelSelector({ selected, savedProviders, updateAgent, sessions, sessionId, onSessionChange, onNewSession, onNewNamedSession, onCreateGroup, locked = false }: { selected: Agent; savedProviders: SavedProvider[]; updateAgent: (patch: Partial<Agent>) => void; sessions: { id: string }[]; sessionId: string; onSessionChange: (sessionId: string) => void; onNewSession: () => void; onNewNamedSession: () => void; onCreateGroup: () => void; locked?: boolean }) {
  const provider = savedProviders.find((item) => item.provider === selected.provider) ?? savedProviders[0];
  const models = provider?.models ?? [];
  const model = models.includes(selected.model) ? selected.model : models[0] ?? '';
  const modelEfforts = provider?.modelEfforts?.[model] ?? [];
  // "off" is a runtime-supported override, even when a provider only advertises
  // its enabled reasoning levels for a model.
  const efforts = ['off', ...modelEfforts.filter((item) => item !== 'off')];
  const effort = efforts.includes(selected.effort) ? selected.effort : provider?.defaultEfforts?.[model] ?? modelEfforts[0] ?? 'off';
  const temperature = Number.isFinite(selected.temperature) ? Math.max(0, Math.min(2, selected.temperature)) : 0.2;
  const updateForModel = (next: SavedProvider | undefined, nextModel: string) => updateAgent({ provider: next?.provider ?? '', model: nextModel, effort: next?.defaultEfforts?.[nextModel] ?? next?.modelEfforts?.[nextModel]?.[0] ?? 'off' });
  const chooseProvider = (providerName: string) => { const next = savedProviders.find((item) => item.provider === providerName); updateForModel(next, next?.models[0] ?? ''); };
  const chooseModel = (nextModel: string) => updateForModel(provider, nextModel);
  const chooseTemperature = (value: string) => updateAgent({ temperature: Number(value) });
  return <div className="workspace-toolbar"><label htmlFor="chat-provider">Provider <select id="chat-provider" name="provider" value={provider?.provider ?? ''} onChange={(e) => chooseProvider(e.target.value)} disabled={locked || !savedProviders.length}>{!savedProviders.length && <option value="">Configured runtime</option>}{savedProviders.map((item) => <option value={item.provider} key={item.id}>{item.provider}</option>)}</select></label><label htmlFor="chat-model">Model <select id="chat-model" name="model" value={model} onChange={(e) => chooseModel(e.target.value)} disabled={locked || !models.length}>{!models.length && <option value="">Configured runtime</option>}{models.map((item) => <option key={item} value={item}>{provider?.modelLabels?.[item] ?? item}</option>)}</select></label><label htmlFor="chat-effort">Effort <select id="chat-effort" name="effort" value={effort} onChange={(e) => updateAgent({ effort: e.target.value })} disabled={locked || !efforts.length}>{!efforts.length && <option value="">Not configured</option>}{efforts.map((item) => <option key={item}>{item}</option>)}</select></label><label className="temperature-control" htmlFor="chat-temperature">Temp <span>{temperature.toFixed(1)}</span><input id="chat-temperature" name="temperature" type="range" min="0" max="2" step="0.1" value={temperature} onChange={(e) => chooseTemperature(e.target.value)} disabled={locked || !provider} /></label><div className="session-controls"><button className="new-session group-chat-trigger" onClick={onCreateGroup} disabled={locked}>Group Chat</button><button className="new-session" onClick={onNewNamedSession} disabled={locked}>New session</button><label htmlFor="chat-session"><span className="sr-only">Session</span><select id="chat-session" name="session" value={sessionId} onChange={(e) => onSessionChange(e.target.value)} disabled={locked || !sessions.length}>{sessions.map((session) => <option key={session.id} value={session.id}>{session.id}</option>)}</select></label><button className="new-session" onClick={onNewSession} disabled={locked}>Reset Session</button></div></div>;
}

export function Chat({ selected, parent, operator, draft, setDraft, attached, onAttach, onRemoveAttachment, isNewSession, turns, isLoading, error, isSending, activeRunId, activeToolActivity, liveProgress, liveAnswer, a2aActivities, onSend, onCancel }: { selected: Agent | Subagent; parent: Agent; operator: OperatorProfile; draft: string; setDraft: (value: string) => void; attached: ChatAttachment[]; onAttach: (files: File[]) => void; onRemoveAttachment: (index: number) => void; isNewSession: boolean; turns: SessionTurn[]; isLoading: boolean; error: string; isSending: boolean; activeRunId: string; activeToolActivity?: ToolActivity; liveProgress: ProgressEntry[]; liveAnswer: string; a2aActivities?: import('../../app/api').ActiveA2AActivity[]; onSend: () => void; onCancel: () => void }) {
  const composerHistory = useComposerHistory(draft, turns.filter((turn) => turn.role === 'user').map((turn) => turn.content ?? ''), setDraft);
  return <div className="chat-view">
    <ChatTranscript selected={selected} parent={parent} operator={operator} isNewSession={isNewSession} turns={turns} isLoading={isLoading} error={error} isSending={isSending} activeRunId={activeRunId} activeToolActivity={activeToolActivity} liveProgress={liveProgress} liveAnswer={liveAnswer} a2aActivities={a2aActivities} />
    <ChatComposer draft={draft} setDraft={composerHistory.setDraft} attached={attached} onAttach={onAttach} onRemoveAttachment={onRemoveAttachment} disabled={isSending} onSend={onSend} onCancel={onCancel} onKeyDown={composerHistory.onKeyDown} conversationTurns={turns} placeholder={isNewSession ? `Message ${selected.name}…` : 'Message the active agent…'} />
  </div>;
}

export function Editor({ tab, setTabs, onSave }: { tab: Tab; setTabs: Dispatch<SetStateAction<Tab[]>>; onSave: (tab: Tab, content: string) => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const save = async () => {
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
  return <div className="editor-view"><div className="editor-toolbar"><span>{tab.path ?? tab.id}</span><button className={editing ? 'save' : ''} onClick={editing ? save : () => setEditing(true)} disabled={saving}>{saving ? 'Saving…' : editing ? 'Save' : 'Edit'}</button></div>{error && <p className="error" role="alert">{error}</p>}<textarea className="editor" value={tab.content} readOnly={!editing || saving} onChange={(event) => setTabs((all) => all.map((item) => item.id === tab.id ? { ...item, content: event.target.value } : item))} spellCheck={false} aria-label={`Edit ${tab.label}`} /></div>;
}
