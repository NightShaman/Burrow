import { useCallback, useRef } from 'react';
import type { KeyboardEvent } from 'react';

/** Terminal-style sent-message recall for a single composer scope. */
export function useComposerHistory(draft: string, history: string[], setDraft: (value: string) => void) {
  const indexRef = useRef<number | null>(null);
  const savedDraftRef = useRef('');
  const draftRef = useRef(draft);
  draftRef.current = draft;

  const updateDraft = useCallback((value: string) => {
    draftRef.current = value;
    indexRef.current = null;
    setDraft(value);
  }, [setDraft]);

  const navigate = useCallback((event: KeyboardEvent<HTMLTextAreaElement>) => {
    const textarea = event.currentTarget;
    const isCollapsed = textarea.selectionStart === textarea.selectionEnd;
    const isAtStart = isCollapsed && textarea.selectionStart === 0;
    const isAtEnd = isCollapsed && textarea.selectionEnd === textarea.value.length;
    const usableHistory = history.filter((entry) => entry.trim());
    const currentIndex = indexRef.current;

    // React restores the controlled textarea's caret at the end after swapping a
    // recalled value. Once history navigation has started, keep traversing it
    // regardless of that browser caret placement.
    if (event.key === 'ArrowUp' && (isAtStart || currentIndex !== null) && usableHistory.length) {
      event.preventDefault();
      if (currentIndex === null) savedDraftRef.current = draftRef.current;
      const nextIndex = currentIndex === null ? usableHistory.length - 1 : Math.max(0, currentIndex - 1);
      indexRef.current = nextIndex;
      draftRef.current = usableHistory[nextIndex];
      setDraft(usableHistory[nextIndex]);
      return;
    }

    if (event.key === 'ArrowDown' && isAtEnd && currentIndex !== null) {
      event.preventDefault();
      if (currentIndex < usableHistory.length - 1) {
        const nextIndex = currentIndex + 1;
        indexRef.current = nextIndex;
        draftRef.current = usableHistory[nextIndex];
        setDraft(usableHistory[nextIndex]);
      } else {
        indexRef.current = null;
        draftRef.current = savedDraftRef.current;
        setDraft(savedDraftRef.current);
      }
    }
  }, [history, setDraft]);

  return { setDraft: updateDraft, onKeyDown: navigate };
}
