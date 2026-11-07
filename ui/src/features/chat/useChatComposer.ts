import { useCallback, useEffect, useState } from 'react';
import { isWithinAttachmentBudget } from '../../app/clientBudgets';
import type { ChatAttachment } from '../../app/api';
import { conversationCacheKey } from './chatConversationCache';
import { readDraftCache, writeDraftCache, type DraftCache } from './chatDraftCache';

/** Owns persisted drafts and scoped attachment lifetime; navigation owns the scope token. */
export function useChatComposer(
  agentId: string,
  sessionId: string,
  scope: object,
  isScopeCurrent: () => boolean,
) {
  const [draftCache, setDraftCache] = useState<DraftCache>(readDraftCache);
  const [attachmentState, setAttachmentState] = useState<{
    scope: object;
    files: ChatAttachment[];
  } | null>(null);
  const [composerResetGeneration, setComposerResetGeneration] = useState(0);
  const noteComposerReset = useCallback(() => setComposerResetGeneration((value) => value + 1), []);
  const draftKey = agentId && sessionId ? conversationCacheKey(agentId, sessionId) : '';
  const draft = draftKey ? (draftCache[draftKey]?.value ?? '') : '';
  const setDraft = useCallback(
    (value: string) => {
      if (!draftKey) return;
      setDraftCache((current) => {
        if (!value) {
          if (!current[draftKey]) return current;
          const { [draftKey]: _, ...remaining } = current;
          return remaining;
        }
        return { ...current, [draftKey]: { value, updatedAt: Date.now() } };
      });
    },
    [draftKey],
  );
  useEffect(() => {
    writeDraftCache(draftCache);
  }, [draftCache]);
  const attached = attachmentState?.scope === scope ? attachmentState.files : [];
  const setAttachment = useCallback(
    (attachments: ChatAttachment[]) => {
      if (!isScopeCurrent()) return;
      setAttachmentState((current) => {
        const files = [...(current?.scope === scope ? current.files : [])];
        for (const attachment of attachments)
          if (
            isWithinAttachmentBudget(
              files.map((item) => item.size),
              attachment.size,
            )
          )
            files.push(attachment);
        return { scope, files };
      });
    },
    [scope, isScopeCurrent],
  );
  const clearAttachment = useCallback(() => setAttachmentState(null), []);
  const removeAttachment = useCallback(
    (index: number) =>
      setAttachmentState((current) =>
        current?.scope === scope
          ? {
              ...current,
              files: current.files.filter((_, attachmentIndex) => attachmentIndex !== index),
            }
          : current,
      ),
    [scope],
  );
  return {
    draft,
    setDraft,
    attached,
    setAttachment,
    clearAttachment,
    removeAttachment,
    composerResetGeneration,
    noteComposerReset,
  };
}
