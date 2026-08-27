import { useCallback, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { apiForTarget, type SessionSummary } from '../../app/api';
import { targetForResource, type ApiTarget } from '../../app/apiTargets';
import type { Tab } from '../../app/types';

type ChatComposerOptions = {
  selectedAgentId: string;
  activeRunId: string | null;
  sessions: SessionSummary[];
  targets: ApiTarget[];
  activeTarget: ApiTarget;
  refreshSessions: (agentId?: string) => Promise<unknown>;
  selectSession: (sessionId: string) => void;
  reportError: (message: string) => void;
  clearError: () => void;
  setTabs: Dispatch<SetStateAction<Tab[]>>;
  setActiveTabId: Dispatch<SetStateAction<string>>;
};

export function useChatComposers({ selectedAgentId, activeRunId, sessions, targets, activeTarget, refreshSessions, selectSession, reportError, clearError, setTabs, setActiveTabId }: ChatComposerOptions) {
  const [isSessionOpen, setIsSessionOpen] = useState(false);
  const [isCreatingSession, setIsCreatingSession] = useState(false);
  const [sessionName, setSessionName] = useState('');
  const [sessionError, setSessionError] = useState('');
  const [isGroupOpen, setIsGroupOpen] = useState(false);
  const [isCreatingGroup, setIsCreatingGroup] = useState(false);
  const [groupName, setGroupName] = useState('');
  const [groupAgentIds, setGroupAgentIds] = useState<string[]>([]);
  const [groupError, setGroupError] = useState('');

  const openSession = useCallback(() => {
    setSessionError('');
    setIsSessionOpen(true);
  }, []);
  const closeSession = useCallback(() => {
    if (isCreatingSession) return;
    setIsSessionOpen(false);
    setSessionError('');
  }, [isCreatingSession]);
  const changeSessionName = useCallback((name: string) => {
    setSessionName(name);
    setSessionError('');
  }, []);
  const createSession = useCallback(async () => {
    if (!selectedAgentId || isCreatingSession || activeRunId) {
      setSessionError('A session cannot be created while the current run is active.');
      return;
    }
    const targetSessionId = sessionName.trim();
    if (!targetSessionId) return setSessionError('Give the session a name.');
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(targetSessionId)) return setSessionError('Use 1–80 letters, numbers, hyphens, or underscores; start with a letter or number.');
    if (sessions.some((session) => session.id === targetSessionId)) return setSessionError(`A session named “${targetSessionId}” already exists.`);
    setIsCreatingSession(true);
    setSessionError('');
    clearError();
    try {
      const owner = targetForResource(targets, selectedAgentId);
      await apiForTarget(owner.target, `/api/sessions/default/fork?agentId=${encodeURIComponent(owner.resourceId)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ targetSessionId }),
      });
      await apiForTarget(owner.target, `/api/sessions/${encodeURIComponent(targetSessionId)}/reset?agentId=${encodeURIComponent(owner.resourceId)}`, { method: 'POST' });
      await refreshSessions(selectedAgentId);
      selectSession(targetSessionId);
      setIsSessionOpen(false);
      setSessionName('');
      setSessionError('');
    } catch (error) {
      const message = `Could not create session: ${(error as Error).message}`;
      setSessionError(message);
      reportError(message);
    } finally {
      setIsCreatingSession(false);
    }
  }, [activeRunId, clearError, isCreatingSession, refreshSessions, reportError, selectedAgentId, selectSession, sessionName, sessions, targets]);

  const openGroup = useCallback(() => {
    setGroupError('');
    setIsGroupOpen(true);
  }, []);
  const closeGroup = useCallback(() => {
    if (!isCreatingGroup) setIsGroupOpen(false);
  }, [isCreatingGroup]);
  const toggleGroupAgent = useCallback((agentId: string) => {
    setGroupAgentIds((current) => current.includes(agentId) ? current.filter((id) => id !== agentId) : [...current, agentId]);
  }, []);
  const createGroup = useCallback(async () => {
    const name = groupName.trim();
    if (!name) return setGroupError('Give the group chat a name.');
    if (groupAgentIds.length < 2) return setGroupError('Select at least two agents.');
    setIsCreatingGroup(true);
    setGroupError('');
    try {
      const participants = groupAgentIds.map((agentId) => targetForResource(targets, agentId));
      if (participants.some((participant) => participant.target.id !== activeTarget.id)) throw new Error('Group chat participants must belong to the selected runtime.');
      const response = await apiForTarget<{ channel?: { id?: string; name?: string } } | { id?: string; name?: string }>(activeTarget, '/api/group-channels', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, participantAgentIds: participants.map((participant) => participant.resourceId) }),
      });
      const channel = ('channel' in response ? response.channel : response) as { id?: string; name?: string } | undefined;
      if (!channel?.id) throw new Error('The server did not return a group chat id.');
      const tabId = `group:${activeTarget.id}:${channel.id}`;
      setTabs((current) => current.some((tab) => tab.id === tabId) ? current : [...current, { id: tabId, label: channel.name || name, kind: 'group', channelId: channel.id, targetId: activeTarget.id }]);
      setActiveTabId(tabId);
      setIsGroupOpen(false);
      setGroupName('');
      setGroupAgentIds([]);
    } catch (error) {
      setGroupError(`Could not create group chat: ${(error as Error).message}`);
    } finally {
      setIsCreatingGroup(false);
    }
  }, [activeTarget, groupAgentIds, groupName, setActiveTabId, setTabs, targets]);

  return {
    session: { isOpen: isSessionOpen, isCreating: isCreatingSession, name: sessionName, error: sessionError, open: openSession, close: closeSession, setName: changeSessionName, create: createSession },
    group: { isOpen: isGroupOpen, isCreating: isCreatingGroup, name: groupName, setName: setGroupName, agentIds: groupAgentIds, error: groupError, open: openGroup, close: closeGroup, toggleAgent: toggleGroupAgent, create: createGroup },
  };
}
