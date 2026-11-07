import type { Dispatch, SetStateAction } from 'react';
import { api, attachmentDisplayName, type ChatAttachment } from './api';
import type { Agent } from './types';
import { readAttachment } from './readAttachment';
import { isWithinAttachmentBudget } from '../features/chat/attachmentValidation';

const isSupportedAttachment = (file: File) =>
  file.type.startsWith('image/') ||
  file.type.startsWith('text/') ||
  ['application/json', 'application/xml', 'application/rtf'].includes(file.type) ||
  /\.(txt|md|markdown|json|csv|xml|html?|css|js|ts|tsx|jsx|py|rb|go|rs|java|c|cpp|h|yaml|yml|rtf)$/i.test(
    file.name,
  );
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
      if (!isSupportedAttachment(file)) {
        reportError(
          `${file.name}: Attach an image or text document. PDF extraction is not supported.`,
        );
        return false;
      }
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
      accepted.map((file, index) => readAttachment(file, attachmentDisplayName(file, index + 1))),
    )
      .then((attachments) => {
        if (!isAttachmentScopeCurrent()) return;
        setAttachment(attachments);
      })
      .catch(() => {
        if (isAttachmentScopeCurrent()) reportError('Could not read the attachment.');
      });
  };
  return { updateAgent, attachImage };
}
