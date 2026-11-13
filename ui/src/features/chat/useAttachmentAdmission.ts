import { useRef } from 'react';
import { attachmentDisplayName, type ChatAttachment } from '../../app/api';
import { readAttachment } from '../../app/readAttachment';
import { isWithinAttachmentBudget, validatedAttachmentType } from './attachmentValidation';

export const attachmentBudgetError =
  'Attachment exceeds the client file, count, or batch safety budget.';

/** Selection order is admission order, including overlapping selections. Only one
 * file is read at a time; failed validation/reads never reserve preview capacity. */
export function useAttachmentAdmission() {
  const queue = useRef(Promise.resolve());
  return (
    files: File[],
    current: () => boolean,
    commit: (attachments: ChatAttachment[]) => ChatAttachment[],
    reportError: (message: string) => void,
  ) => {
    const process = async () => {
      const candidates: ChatAttachment[] = [];
      for (const [index, file] of files.entries()) {
        if (!current()) return;
        try {
          const type = await validatedAttachmentType(file);
          if (!current()) return;
          if (
            !isWithinAttachmentBudget(
              candidates.map((item) => item.size),
              file.size,
            )
          )
            throw new Error(attachmentBudgetError);
          const attachment = await readAttachment(file, attachmentDisplayName(file, index + 1));
          if (!current()) return;
          candidates.push({ ...attachment, type });
        } catch (reason) {
          if (current())
            reportError(
              `${file.name}: ${reason instanceof Error ? reason.message : 'Could not read attachment.'}`,
            );
        }
      }
      if (!current() || !candidates.length) return;
      // The owner must check its actual current state, not the selection-time snapshot.
      for (const rejected of commit(candidates))
        reportError(`${rejected.name}: ${attachmentBudgetError}`);
    };
    const result = queue.current.then(process);
    // A failed consumer must not strand later selections.
    queue.current = result.catch(() => undefined);
    return result;
  };
}

export function admitAttachments(current: ChatAttachment[], candidates: ChatAttachment[]) {
  const files = [...current];
  const rejected: ChatAttachment[] = [];
  for (const attachment of candidates) {
    if (
      isWithinAttachmentBudget(
        files.map((item) => item.size),
        attachment.size,
      )
    )
      files.push(attachment);
    else rejected.push(attachment);
  }
  return { files, rejected };
}
