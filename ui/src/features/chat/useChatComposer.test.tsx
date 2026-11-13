import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ChatAttachment } from '../../app/api';
import { useChatComposer } from './useChatComposer';
const image = (name: string): ChatAttachment => ({
  name,
  type: 'image/png',
  size: 8,
  content: 'data:image/png;base64,aGVsbG8=',
  encoding: 'data-url',
});
function setup() {
  let currentScope = {};
  const initialProps = { agent: 'smatchet', session: 'default', scope: currentScope };
  const hook = renderHook(
    ({ agent, session, scope }) =>
      useChatComposer(agent, session, scope, () => scope === currentScope),
    { initialProps },
  );
  const navigate = (agent: string, session = 'default') => {
    currentScope = {};
    hook.rerender({ agent, session, scope: currentScope });
  };
  return { ...hook, navigate };
}
describe('conversation attachment drafts', () => {
  beforeEach(() => localStorage.clear());
  it('restores images and text after switching agents and allows adding another', () => {
    const { result, navigate } = setup();
    act(() => {
      result.current.setDraft('compare');
      result.current.setAttachment([image('one.png')]);
    });
    navigate('hatchet');
    expect(result.current.attached).toEqual([]);
    act(() => result.current.setAttachment([image('other.png')]));
    navigate('smatchet');
    expect(result.current.draft).toBe('compare');
    expect(result.current.attached.map((a) => a.name)).toEqual(['one.png']);
    act(() => result.current.setAttachment([image('two.png')]));
    expect(result.current.attached.map((a) => a.name)).toEqual(['one.png', 'two.png']);
    navigate('hatchet');
    expect(result.current.attached.map((a) => a.name)).toEqual(['other.png']);
  });
  it('isolates sessions, removal and clearing', () => {
    const { result, navigate } = setup();
    act(() => result.current.setAttachment([image('one.png'), image('two.png')]));
    navigate('smatchet', 'design');
    expect(result.current.attached).toEqual([]);
    act(() => result.current.setAttachment([image('design.png')]));
    navigate('smatchet');
    act(() => result.current.removeAttachment(0));
    expect(result.current.attached.map((a) => a.name)).toEqual(['two.png']);
    act(() => result.current.clearAttachment());
    navigate('smatchet', 'design');
    expect(result.current.attached.map((a) => a.name)).toEqual(['design.png']);
    navigate('smatchet');
    expect(result.current.attached).toEqual([]);
  });
  it('rejects stale reads and clears delayed send acceptance in its origin only', () => {
    const { result, navigate } = setup();
    act(() => result.current.setAttachment([image('origin.png')]));
    const origin = result.current;
    navigate('hatchet');
    act(() => {
      result.current.setAttachment([image('keep.png')]);
      origin.setAttachment([image('late.png')]);
      origin.clearAttachment();
    });
    expect(result.current.attached.map((a) => a.name)).toEqual(['keep.png']);
    navigate('smatchet');
    expect(result.current.attached).toEqual([]);
  });
});
