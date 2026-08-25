import { act, renderHook } from '@testing-library/react';
import type { KeyboardEvent } from 'react';
import { describe, expect, it } from 'vitest';
import { useState } from 'react';
import { useComposerHistory } from './useComposerHistory';

function event(key: string, value: string, caret: number) {
  return { key, currentTarget: { value, selectionStart: caret, selectionEnd: caret }, preventDefault() {} } as unknown as KeyboardEvent<HTMLTextAreaElement>;
}

describe('useComposerHistory', () => {
  it('recalls sent messages and restores the unsent draft', () => {
    const { result } = renderHook(() => {
      const [draft, setDraft] = useState('Unsaved');
      return { draft, history: useComposerHistory(draft, ['First', 'Second'], setDraft) };
    });
    act(() => result.current.history.onKeyDown(event('ArrowUp', 'Unsaved', 0)));
    expect(result.current.draft).toBe('Second');
    // A controlled textarea may place its caret at the end after recall; the
    // next Up must still continue through history instead of moving the caret.
    act(() => result.current.history.onKeyDown(event('ArrowUp', 'Second', 6)));
    expect(result.current.draft).toBe('First');
    act(() => result.current.history.onKeyDown(event('ArrowDown', 'First', 5)));
    expect(result.current.draft).toBe('Second');
    act(() => result.current.history.onKeyDown(event('ArrowDown', 'Second', 6)));
    expect(result.current.draft).toBe('Unsaved');
  });

  it('leaves normal arrow navigation alone away from composer boundaries', () => {
    const { result } = renderHook(() => {
      const [draft, setDraft] = useState('Draft');
      return { draft, history: useComposerHistory(draft, ['Earlier'], setDraft) };
    });
    act(() => result.current.history.onKeyDown(event('ArrowUp', 'Draft', 2)));
    expect(result.current.draft).toBe('Draft');
  });
});
