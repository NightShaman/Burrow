import type { Dispatch, SetStateAction } from 'react';
import { api, attachmentDisplayName, type ChatAttachment } from './api';
import type { Agent } from './types';
import { readAttachment } from './readAttachment';
import {
  isWithinAttachmentBudget,
  validatedAttachmentType,
} from '../features/chat/attachmentValidation';

export function useAppMutations({
  selected,
  setAgents,
  refreshSessions,
  reportError,
  writeModelSelection,
  attached,
  isAttachmentScopeCurrent,
  setAttachment,
}: {
  selected: Agent | undefined;
  setAgents: Dispatch<SetStateAction<Agent[]>>;
  refreshSessions: (id?: string) => Promise<unknown>;
  reportError: (message: string) => void;
  writeModelSelection: (selected: Agent, patch: Partial<Agent>) => Promise<boolean | void>;
  attached: ChatAttachment[];
  isAttachmentScopeCurrent: () => boolean;
  setAttachment: (attachments: ChatAttachment[]) => void;
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

  const attachImage = (files: File[]) => {
    const admittedSizes = attached.map((item) => item.size);
    const accepted = files.filter((file) => {
      if (!isWithinAttachmentBudget(admittedSizes, file.size)) {
        reportError(
          `${file.name}: Attachment exceeds the client file, count, or batch safety budget.`,
        );
        return false;
      }
      admittedSizes.push(file.size);
      return true;
    });
    if (!accepted.length) return;
    void Promise.all(
      accepted.map(async (file, index) => {
        try {
          const type = await validatedAttachmentType(file);
          const attachment = await readAttachment(file, attachmentDisplayName(file, index + 1));
          return { ...attachment, type };
        } catch (reason) {
          if (isAttachmentScopeCurrent())
            reportError(
              `${file.name}: ${reason instanceof Error ? reason.message : 'Could not read attachment.'}`,
            );
          return null;
        }
      }),
    ).then((results) => {
      if (!isAttachmentScopeCurrent()) return;
      const attachments = results.filter((item): item is ChatAttachment => item !== null);
      if (attachments.length) setAttachment(attachments);
    });
  };
  return { updateAgent, attachImage };
}
