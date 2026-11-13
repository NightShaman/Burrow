import { useCallback, useEffect, useRef, useState } from 'react';
import { admitAttachments } from './useAttachmentAdmission';
import type { ChatAttachment } from '../../app/api';
import { conversationCacheKey } from './chatConversationCache';
import { readDraftCache, writeDraftCache, type DraftCache } from './chatDraftCache';

/** Owns persisted text drafts and in-memory attachment drafts per conversation. */
export function useChatComposer(
  agentId: string,
  sessionId: string,
  scope: object,
  isScopeCurrent: () => boolean,
) {
  const [draftCache, setDraftCache] = useState<DraftCache>(readDraftCache);
  const [attachmentDrafts, setAttachmentDrafts] = useState<Record<string, ChatAttachment[]>>({});
  const attachmentsRef = useRef(attachmentDrafts);
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
  const attachmentKey = conversationCacheKey(agentId, sessionId);
  const attached = attachmentDrafts[attachmentKey] ?? [];
  const updateAttachments = useCallback(
    (files: ChatAttachment[]) => {
      const next = { ...attachmentsRef.current };
      if (files.length) next[attachmentKey] = files;
      else delete next[attachmentKey];
      attachmentsRef.current = next;
      setAttachmentDrafts(next);
    },
    [attachmentKey],
  );
  const setAttachment = useCallback(
    (attachments: ChatAttachment[]) => {
      if (!isScopeCurrent()) return [];
      const { files, rejected } = admitAttachments(
        attachmentsRef.current[attachmentKey] ?? [],
        attachments,
      );
      updateAttachments(files);
      return rejected;
    },
    [attachmentKey, scope, isScopeCurrent, updateAttachments],
  );
  // A delayed send acceptance clears its captured origin, not the newly selected chat.
  const clearAttachment = useCallback(() => updateAttachments([]), [updateAttachments]);
  const removeAttachment = useCallback(
    (index: number) => {
      if (!isScopeCurrent()) return;
      updateAttachments(
        (attachmentsRef.current[attachmentKey] ?? []).filter((_, itemIndex) => itemIndex !== index),
      );
    },
    [attachmentKey, isScopeCurrent, updateAttachments],
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
