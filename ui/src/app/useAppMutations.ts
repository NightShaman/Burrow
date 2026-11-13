import type { Dispatch, SetStateAction } from 'react';
import { api, type ChatAttachment } from './api';
import type { Agent } from './types';
import { useAttachmentAdmission } from '../features/chat/useAttachmentAdmission';

export function useAppMutations({
  selected,
  setAgents,
  refreshSessions,
  reportError,
  writeModelSelection,
  isAttachmentScopeCurrent,
  setAttachment,
}: {
  selected: Agent | undefined;
  setAgents: Dispatch<SetStateAction<Agent[]>>;
  refreshSessions: (id?: string) => Promise<unknown>;
  reportError: (message: string) => void;
  writeModelSelection: (selected: Agent, patch: Partial<Agent>) => Promise<boolean | void>;
  attached?: ChatAttachment[];
  isAttachmentScopeCurrent: () => boolean;
  setAttachment: (attachments: ChatAttachment[]) => ChatAttachment[];
}) {
  const updateAgent = async (patch: Partial<Agent>) => {
    if (!selected) return;
    if (patch.contextConfig) {
      const contextConfig = { a2aInDefault: patch.contextConfig.a2aInDefault };
      try {
        await api(`/api/agents/${encodeURIComponent(selected.resourceId ?? selected.id)}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ contextConfig }),
        });
        setAgents((all) =>
          all.map((agent) =>
            agent.id === selected.id
              ? { ...agent, contextConfig: { ...agent.contextConfig, ...contextConfig } }
              : agent,
          ),
        );
        await refreshSessions(selected.id).catch((error: Error) =>
          reportError(`A2A routing saved, but could not refresh sessions: ${error.message}`),
        );
      } catch (error) {
        reportError(
          error instanceof Error
            ? `Could not update A2A routing: ${error.message}`
            : 'Could not update A2A routing.',
        );
      }
      return;
    }
    return writeModelSelection(selected, patch);
  };

  const admit = useAttachmentAdmission();
  const attachImage = (files: File[]) => {
    void admit(files, isAttachmentScopeCurrent, setAttachment, reportError);
  };
  return { updateAgent, attachImage };
}
