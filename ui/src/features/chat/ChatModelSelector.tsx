import {
  chatProvider,
  isNativeThinkingProvider,
  nativeThinkingOptions,
  thinkingModeLabel,
  reasoningEffortsForModel,
  defaultReasoningEffort,
} from '../../app/modelSelectionOptions';
import { useLayoutEffect, useEffect, useRef, useState } from 'react';
import type { Agent, SavedProvider } from '../../app/types';
import {
  loadSwitchboardSessionLabels,
  type SwitchboardSessionLabel,
} from './telegramSessionLabels';

export function ChatModelSelector({
  selected,
  savedProviders,
  updateAgent,
  sessions,
  sessionId,
  onSessionChange,
  onNewSession,
  onNewNamedSession,
  onCreateGroup,
  ownerEditor,
  locked = false,
  isResettingSession = false,
  savingSelection = false,
  onSelectionBlockedChange,
}: {
  selected: Agent;
  savedProviders: SavedProvider[];
  updateAgent: (patch: Partial<Agent>) => void | boolean | Promise<void | boolean>;
  sessions: import('../../app/api').SessionSummary[];
  sessionId: string;
  onSessionChange: (sessionId: string) => void;
  onNewSession: () => void;
  onNewNamedSession: () => void;
  onCreateGroup: () => void;
  ownerEditor?: { label: string; onOpen: () => void };
  locked?: boolean;
  isResettingSession?: boolean;
  savingSelection?: boolean;
  onSelectionBlockedChange?: (blocked: boolean) => void;
}) {
  const provider = chatProvider(selected, savedProviders);
  const models = provider?.models ?? [];
  const model =
    selected.modAgent || selected.modelConnectionId
      ? selected.model
      : models.includes(selected.model)
        ? selected.model
        : (models[0] ?? '');
  const native = isNativeThinkingProvider(provider);
  const identity = JSON.stringify([selected.id, provider?.id, model]);
  type Draft = { patch: Partial<Agent>; displayPair: boolean; pending: boolean; failed: boolean };
  // Keep local intent per owner/model. Leaving and returning cannot erase a
  // still-pending write or move its failure onto a different agent.
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const busyOwners = useRef(new Set<string>());
  const [temperatureDrafts, setTemperatureDrafts] = useState<
    Record<string, { value: number; revision: number }>
  >({});
  const temperatureRevision = useRef(0);
  const temperatureDraft = temperatureDrafts[identity];
  const nativeDraft = drafts[identity];
  const savingNative = savingSelection || nativeDraft?.pending === true;
  // Preserve native disabled guards, but distinguish transient persistence from
  // a run lock or an unavailable choice for stable save-only styling.
  const savingOnly = savingNative && !locked;
  const retryNative = nativeDraft?.failed === true;
  const thinkingMode = nativeDraft?.displayPair
    ? (nativeDraft.patch.thinkingMode ?? null)
    : (selected.thinkingMode ?? null);
  const effort = nativeDraft?.displayPair
    ? nativeDraft.patch.effort!
    : native
      ? selected.effort
      : reasoningEffortsForModel(provider, model).includes(selected.effort)
        ? selected.effort
        : defaultReasoningEffort(provider, model);
  const thinking = nativeThinkingOptions(provider, model, thinkingMode, effort);
  const efforts = native ? thinking.efforts : reasoningEffortsForModel(provider, model);
  const blocked =
    Boolean(
      (selected.modAgent || selected.modelConnectionId) && (!provider || !models.includes(model)),
    ) ||
    savingNative ||
    Boolean(nativeDraft) ||
    Boolean(temperatureDraft) ||
    (native && (thinking.modeInvalid || thinking.effortInvalid));
  useLayoutEffect(() => {
    onSelectionBlockedChange?.(blocked);
  }, [blocked, onSelectionBlockedChange]);
  const saveModelPatch = async (patch: Partial<Agent>, displayPair: boolean) => {
    if (busyOwners.current.has(identity) || savingSelection) return;
    const value: Draft = { patch, displayPair, pending: false, failed: false };
    setDrafts((current) => ({ ...current, [identity]: value }));
    if (displayPair) {
      const next = nativeThinkingOptions(provider, model, patch.thinkingMode, patch.effort!);
      // Preserve an incompatible counterpart for deliberate correction, never
      // save half a pair or substitute a native effort behind the operator.
      if (next.modeInvalid || next.effortInvalid) return;
    }
    busyOwners.current.add(identity);
    setDrafts((current) => ({ ...current, [identity]: { ...value, pending: true } }));
    try {
      const accepted = await updateAgent(patch);
      setDrafts((current) => {
        if (accepted === false) return { ...current, [identity]: { ...value, failed: true } };
        const next = { ...current };
        delete next[identity];
        return next;
      });
    } catch {
      setDrafts((current) => ({ ...current, [identity]: { ...value, failed: true } }));
    } finally {
      busyOwners.current.delete(identity);
    }
  };
  const saveNative = (nextMode: string | null, nextEffort: string) =>
    saveModelPatch({ thinkingMode: nextMode, effort: nextEffort }, true);
  const savedTemperature = Number.isFinite(selected.temperature)
    ? Math.max(0, Math.min(2, selected.temperature))
    : 0.2;
  const temperature = temperatureDraft?.value ?? savedTemperature;
  const a2aInDefault = selected.contextConfig?.a2aInDefault !== false;
  const selectableSessions = sessions.filter((session) => {
    const id = session.id.toLowerCase();
    return (
      session.metadata?.kind !== 'subagent' &&
      session.metadata?.kind !== 'group' &&
      !session.parentSessionId &&
      session.ownerTaskId == null &&
      !id.startsWith('group:') &&
      !id.startsWith('group-') &&
      !id.startsWith('artifact-')
    );
  });
  const updateForModel = (next: SavedProvider | undefined, nextModel: string) => {
    const patch = {
      provider: next?.provider ?? '',
      modelConnectionId: next?.id,
      model: nextModel,
      effort: isNativeThinkingProvider(next) ? 'off' : defaultReasoningEffort(next, nextModel),
      thinkingMode: isNativeThinkingProvider(next) ? 'default' : null,
    };
    // Identity changes are full intents too. Lock tuning against the old model
    // while its new identity is in flight, rather than merging across models.
    return native || isNativeThinkingProvider(next)
      ? saveModelPatch(patch, false)
      : updateAgent(patch);
  };
  const chooseProvider = (providerName: string) => {
    const next = savedProviders.find((item) => item.provider === providerName);
    updateForModel(next, next?.models[0] ?? '');
  };
  const chooseModel = (nextModel: string) => updateForModel(provider, nextModel);
  const chooseTemperature = async (value: string) => {
    const revision = ++temperatureRevision.current;
    const temperature = Number(value);
    // Drag feedback must not wait for persistence. The owner-scoped writer
    // serializes/coalesces saves; only the newest intent may clear its draft.
    setTemperatureDrafts((current) => ({
      ...current,
      [identity]: { value: temperature, revision },
    }));
    try {
      await updateAgent({ temperature });
    } catch {
      // The writer reports save errors. Restore the acknowledged value below.
    } finally {
      setTemperatureDrafts((current) => {
        if (current[identity]?.revision !== revision) return current;
        const next = { ...current };
        delete next[identity];
        return next;
      });
    }
  };
  const visibleSessions = [...selectableSessions];
  // Keep the selected address represented while session metadata is pending.
  if (sessionId && !visibleSessions.some((session) => session.id === sessionId)) {
    visibleSessions.push({ id: sessionId });
  }
  const visibleSessionKey = visibleSessions.map((session) => session.id).join('\n');
  const [switchboardLabels, setSwitchboardLabels] = useState<Map<string, SwitchboardSessionLabel>>(
    new Map(),
  );
  useEffect(() => {
    const controller = new AbortController();
    void loadSwitchboardSessionLabels(
      visibleSessions.map((session) => session.id),
      controller.signal,
    )
      .then(setSwitchboardLabels)
      .catch(() => {
        if (!controller.signal.aborted) setSwitchboardLabels(new Map());
      });
    return () => controller.abort();
  }, [visibleSessionKey]);
  const effortControl = (
    <label htmlFor="chat-effort">
      Effort{' '}
      <select
        id="chat-effort"
        name="effort"
        value={effort}
        aria-invalid={(native && thinking.effortInvalid) || undefined}
        onChange={(event) =>
          native
            ? void saveNative(thinkingMode, event.target.value)
            : void updateAgent({ effort: event.target.value })
        }
        disabled={locked || savingNative || !provider || (native && thinkingMode == null)}
        data-saving-disabled={
          (savingOnly && !!provider && (!native || thinkingMode != null)) || undefined
        }
      >
        {!efforts.includes(effort) && <option value={effort}>Unavailable · {effort}</option>}
        {efforts.map((value) => (
          <option key={value} value={value}>
            {native && thinkingMode != null && value === 'off' ? 'Default' : value}
          </option>
        ))}
      </select>
    </label>
  );
  const temperatureControl = (
    <label className="temperature-control" htmlFor="chat-temperature">
      Temp <span>{temperature.toFixed(1)}</span>
      <input
        id="chat-temperature"
        name="temperature"
        type="range"
        min="0"
        max="2"
        step="0.1"
        value={temperature}
        onChange={(e) => void chooseTemperature(e.target.value)}
        disabled={
          locked || Boolean(nativeDraft) || (savingSelection && !temperatureDraft) || !provider
        }
        data-saving-disabled={
          (savingOnly &&
            !!provider &&
            !temperatureDraft &&
            (Boolean(nativeDraft) || savingSelection)) ||
          undefined
        }
      />
    </label>
  );
  return (
    <div
      className={`workspace-toolbar${native || ownerEditor ? ' native-model-toolbar' : ''}${ownerEditor ? ' owner-editor-toolbar' : ''}`}
    >
      <label htmlFor="chat-provider">
        Provider{' '}
        <select
          id="chat-provider"
          name="provider"
          value={provider?.provider ?? ''}
          onChange={(e) => chooseProvider(e.target.value)}
          disabled={locked || savingNative || !savedProviders.length}
          data-saving-disabled={(savingOnly && !!savedProviders.length) || undefined}
        >
          {!provider && (
            <option value="">
              {selected.modelConnectionId
                ? `Unavailable · ${selected.modelConnectionId}`
                : 'Select provider'}
            </option>
          )}
          {savedProviders.map((item) => (
            <option value={item.provider} key={item.id}>
              {item.provider}
            </option>
          ))}
        </select>
      </label>
      <label htmlFor="chat-model">
        Model{' '}
        <select
          id="chat-model"
          name="model"
          value={model}
          onChange={(e) => chooseModel(e.target.value)}
          disabled={locked || savingNative || !models.length}
          data-saving-disabled={(savingOnly && !!models.length) || undefined}
        >
          {!models.includes(model) && (
            <option value={model}>{model ? `Unavailable · ${model}` : 'Select model'}</option>
          )}
          {models.map((item) => (
            <option key={item} value={item}>
              {provider?.modelLabels?.[item] ?? item}
            </option>
          ))}
        </select>
      </label>
      {!native && (
        <>
          {effortControl}
          {temperatureControl}
        </>
      )}
      {native && (
        <div className="model-tuning-controls">
          <label htmlFor="chat-thinking">
            Thinking{' '}
            <select
              id="chat-thinking"
              name="thinkingMode"
              value={thinkingMode ?? ''}
              aria-invalid={thinking.modeInvalid || undefined}
              disabled={locked || savingNative || !provider}
              data-saving-disabled={(savingOnly && !!provider) || undefined}
              onChange={(event) => void saveNative(event.target.value, effort)}
            >
              {thinkingMode == null && <option value="">{thinking.legacyLabel}</option>}
              {thinkingMode != null && !thinking.modes.includes(thinkingMode) && (
                <option value={thinkingMode}>
                  Unavailable · {thinkingModeLabel(thinkingMode)}
                </option>
              )}
              {thinking.modes.map((value) => (
                <option key={value} value={value}>
                  {thinkingModeLabel(value)}
                </option>
              ))}
            </select>
          </label>
          {effortControl}
          {temperatureControl}
        </div>
      )}
      <div className="session-controls">
        <button className="new-session group-chat-trigger" onClick={onCreateGroup}>
          Group Chat
        </button>
        <button className="new-session" onClick={onNewNamedSession}>
          New session
        </button>
        <button
          className="new-session"
          onClick={onNewSession}
          disabled={locked || isResettingSession}
        >
          {isResettingSession ? 'Resetting…' : 'Reset Session'}
        </button>
        <label className="a2a-default-control" htmlFor="chat-a2a-in-default">
          <span>A2A in default</span>
          <input
            id="chat-a2a-in-default"
            className="a2a-default-switch"
            type="checkbox"
            role="switch"
            checked={a2aInDefault}
            onChange={(event) =>
              updateAgent({ contextConfig: { a2aInDefault: event.target.checked } })
            }
          />
        </label>
        <label className="session-selector-control" htmlFor="chat-session">
          <span className="sr-only">Session</span>
          <select
            id="chat-session"
            name="session"
            value={sessionId}
            onChange={(e) => onSessionChange(e.target.value)}
            disabled={!visibleSessions.length}
          >
            {visibleSessions.map((session) => {
              const label = switchboardLabels.get(session.id);
              return (
                <option key={session.id} value={session.id} title={label?.title}>
                  {session.label ?? label?.label ?? (session.id === 'a2a' ? 'A2A' : session.id)}
                </option>
              );
            })}
          </select>
        </label>
      </div>
      {ownerEditor && (
        <button className="new-session" type="button" onClick={ownerEditor.onOpen}>
          {ownerEditor.label}
        </button>
      )}
      <span className="sr-only" role="status" aria-live="polite">
        {savingNative ? 'Saving model selection…' : ''}
      </span>
      {retryNative && (
        <button
          className="new-session"
          disabled={locked}
          onClick={() =>
            nativeDraft && void saveModelPatch(nativeDraft.patch, nativeDraft.displayPair)
          }
        >
          Retry model selection
        </button>
      )}
    </div>
  );
}
