import { useCallback, useEffect, useRef, useState } from 'react';
import { admitAttachments } from './useAttachmentAdmission';
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
  const attachmentStateRef = useRef(attachmentState);
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
      if (!isScopeCurrent()) return [];
      const current = attachmentStateRef.current;
      const { files, rejected } = admitAttachments(
        current?.scope === scope ? current.files : [],
        attachments,
      );
      const next = { scope, files };
      attachmentStateRef.current = next;
      setAttachmentState(next);
      return rejected;
    },
    [scope, isScopeCurrent],
  );
  const clearAttachment = useCallback(() => {
    attachmentStateRef.current = null;
    setAttachmentState(null);
  }, []);
  const removeAttachment = useCallback(
    (index: number) => {
      const current = attachmentStateRef.current;
      if (current?.scope !== scope) return;
      const next = {
        ...current,
        files: current.files.filter((_, attachmentIndex) => attachmentIndex !== index),
      };
      attachmentStateRef.current = next;
      setAttachmentState(next);
    },
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
