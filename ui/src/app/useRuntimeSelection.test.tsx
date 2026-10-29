import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { childStreamId, useRuntimeSelection } from './useRuntimeSelection';

describe('single local runtime selection', () => {
  it('keeps selected agent and child stream state without runtime target selectors', () => {
    const { result } = renderHook(() => useRuntimeSelection());
    expect('activeTarget' in result.current).toBe(false);
    expect('activeTargets' in result.current).toBe(false);
    act(() => result.current.selectParentStream('agent'));
    expect(result.current.selectedStreamId).toBe('agent');
  });

  it('namespaces equal child session IDs by owning agent', () => {
    const { result } = renderHook(() => useRuntimeSelection());
    act(() => result.current.selectChildStream('alpha', 'shared'));
    expect(result.current.selectedStreamId).toBe(childStreamId('alpha', 'shared'));
    act(() => result.current.selectChildStream('beta', 'shared'));
    expect(result.current.selectedStreamId).toBe(childStreamId('beta', 'shared'));
    expect(childStreamId('beta', 'shared')).not.toBe(childStreamId('alpha', 'shared'));
  });
  it('distinguishes a child session whose raw id equals its owning agent id', () => {
    const { result } = renderHook(() => useRuntimeSelection());
    act(() => result.current.selectChildStream('alpha', 'alpha'));
    expect(result.current.selectedStreamId).toBe(childStreamId('alpha', 'alpha'));
    expect(result.current.selectedStreamId).not.toBe('alpha');
    act(() => result.current.selectParentStream('alpha'));
    expect(result.current.selectedStreamId).toBe('alpha');
  });

});
