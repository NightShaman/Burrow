import { useRef } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionTurn } from '../../app/api';
import { ChatArchiveReader, archiveTurnText } from './ArchiveReaders';
import type { ArchiveSession } from './archiveTypes';
import { archiveTurnId } from './archiveTurns';
import { useArchiveBodies } from './useArchiveBodies';

let frames: Map<number, FrameRequestCallback>;
let nextFrame: number;
const observers: ResizeObserverMock[] = [];
const viewports: IntersectionObserverMock[] = [];
class IntersectionObserverMock {
  observe = vi.fn(); disconnect = vi.fn(); unobserve = vi.fn();
  constructor(readonly callback: IntersectionObserverCallback) { viewports.push(this); }
  show(nodes: Element[]) { this.callback(nodes.map(target => ({ target, isIntersecting: true })) as IntersectionObserverEntry[], this as unknown as IntersectionObserver); }
}
class ResizeObserverMock {
  observe = vi.fn();
  disconnect = vi.fn();
  unobserve = vi.fn();
  constructor(readonly callback: ResizeObserverCallback) { observers.push(this); }
}

beforeEach(() => {
  vi.useFakeTimers();
  frames = new Map();
  nextFrame = 0;
  observers.length = 0; viewports.length = 0;
  vi.stubGlobal('IntersectionObserver', IntersectionObserverMock);
  vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  }));
  vi.stubGlobal('cancelAnimationFrame', vi.fn((id: number) => frames.delete(id)));
  vi.stubGlobal('ResizeObserver', ResizeObserverMock);
});
afterEach(() => {
  cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function paint() {
  act(() => {
    const callbacks = [...frames.values()];
    frames.clear();
    callbacks.forEach(callback => callback(0));
    vi.advanceTimersByTime(0);
  });
}
function finishBodies() {
  let remaining = 30;
  while (frames.size && remaining-- > 0) paint();
  expect(frames.size).toBe(0);
  expect(remaining).toBeGreaterThan(0);
}
const makeTurns = (count: number, prefix = 'Message'): SessionTurn[] => Array.from({ length: count }, (_, index) => ({ role: 'assistant', content: `${prefix} ${index}` }));
function Harness({ turns, scope = 'first' }: { turns: SessionTurn[]; scope?: string }) {
  const reader = useRef<HTMLDivElement>(null);
  const { ready, pending } = useArchiveBodies(turns, scope, reader);
  return <div ref={reader} data-testid="reader" data-pending={pending}>
    {turns.map((turn, index) => <article className="archive-turn" key={index} data-index={index} data-turn-id={archiveTurnId(turn)} data-ready={ready.has(turn)}>{ready.has(turn) ? String(turn.content) : 'Pending'}</article>)}
  </div>;
}
function readyIndices(container: HTMLElement) {
  return [...container.querySelectorAll('[data-ready="true"]')].map(node => Number(node.getAttribute('data-index')));
}
const session: ArchiveSession = {
  agentId: 'agent', agentName: 'Agent', sessionId: 'archive', id: 'archive', title: 'Archive', summary: '',
  turnCount: 12, chatTurnCount: 12, createdAt: null, updatedAt: null, archived: true, archivedAt: null,
  kind: null, lastRole: null, lastRunId: null,
};
const readerProps = {
  session, loading: false, error: '', earlierLoading: false, earlierError: '', historyUnavailable: false,
  onLoadEarlier: () => {}, onRestart: () => {},
};

describe('useArchiveBodies scheduling', () => {
  it('makes the latest three bodies ready on the very first render, before any frame', () => {
    const { container } = render(<Harness turns={makeTurns(12)} />);
    expect(readyIndices(container)).toEqual([9, 10, 11]);
    expect(screen.getByTestId('reader').getAttribute('data-pending')).toBe('true');
    expect(frames.size).toBe(1);
  });

  it('renders all bodies in bounded paint batches and keeps completed bodies mounted', () => {
    const { container } = render(<Harness turns={makeTurns(15)} />);
    const latest = container.querySelector('[data-index="14"]');
    let previous = readyIndices(container);
    while (frames.size) {
      paint();
      const current = readyIndices(container);
      expect(current.length - previous.length).toBeGreaterThan(0);
      expect(current.length - previous.length).toBeLessThanOrEqual(3);
      previous.forEach(index => expect(current).toContain(index));
      previous = current;
    }
    expect(previous).toHaveLength(15);
    expect(container.querySelector('[data-index="14"]')).toBe(latest);
    expect(screen.getByTestId('reader').getAttribute('data-pending')).toBe('false');
  });

  it('finishes current bodies after a same-scope projected identity replacement', () => {
    const turns = makeTurns(12);
    const view = render(<Harness turns={turns} />);
    finishBodies();
    const next = [...makeTurns(6, 'Earlier'), ...turns.map((turn, i) => i === 4 ? { ...turn } : turn)];
    view.rerender(<Harness turns={next} />);
    finishBodies();
    expect(readyIndices(view.container)).toHaveLength(18);
    expect(screen.getByTestId('reader').getAttribute('data-pending')).toBe('false');
  });

  it('prioritizes unfinished viewport rows and reevaluates the viewport on the next batch', () => {
    const { container } = render(<Harness turns={makeTurns(21)} />);
    const rows = [...container.querySelectorAll('.archive-turn')];
    viewports[0].show([rows[9]]);
    paint();
    expect(readyIndices(container)).toEqual(expect.arrayContaining([9, 10, 11]));
    expect(readyIndices(container)).not.toContain(0);
    act(() => viewports[0].callback([{ target: rows[9], isIntersecting: false }, { target: rows[3], isIntersecting: true }] as IntersectionObserverEntry[], viewports[0] as unknown as IntersectionObserver));
    paint();
    expect(readyIndices(container)).toEqual(expect.arrayContaining([3, 4, 5, 9, 10, 11]));
    expect(readyIndices(container)).not.toContain(0);
    finishBodies();
    expect(readyIndices(container)).toHaveLength(21);
  });

  it('cancels a queued frame and disconnects row observation on unmount', () => {
    const view = render(<Harness turns={makeTurns(12)} />);
    expect(observers[0].observe).toHaveBeenCalledTimes(12);
    view.unmount();
    expect(cancelAnimationFrame).toHaveBeenCalled();
    expect(frames.size).toBe(0);
    expect(observers[0].disconnect).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels the post-frame timer on unmount, even if its RAF already ran', () => {
    const view = render(<Harness turns={makeTurns(12)} />);
    act(() => {
      const callback = [...frames.values()][0];
      frames.clear();
      callback(0);
    });
    expect(vi.getTimerCount()).toBe(1);
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
    expect(frames.size).toBe(0);
  });

  it('cancels stale scope work and starts the replacement scope with only its latest bodies', () => {
    const view = render(<Harness turns={makeTurns(15, 'Old')} />);
    paint();
    act(() => {
      const callback = [...frames.values()][0];
      frames.clear();
      callback(0);
    });
    const replacement = makeTurns(12, 'New');
    view.rerender(<Harness turns={replacement} scope="replacement" />);
    expect(vi.getTimerCount()).toBe(0);
    expect(readyIndices(view.container)).toEqual([9, 10, 11]);
    finishBodies();
    expect(readyIndices(view.container)).toHaveLength(12);
    expect(view.container.textContent).not.toContain('Old');
    expect(screen.getByTestId('reader').getAttribute('data-pending')).toBe('false');
  });
});

describe('ChatArchiveReader incremental regression', () => {
  it('shows latest Markdown immediately and eventually mounts every loaded body', () => {
    const turns = makeTurns(12);
    const { container } = render(<ChatArchiveReader {...readerProps} detail={{ turns }} />);
    expect(container.querySelectorAll('.archive-turn')).toHaveLength(12);
    expect([...container.querySelectorAll('.archive-turn-body')].map(node => node.textContent)).toEqual(['Message 9', 'Message 10', 'Message 11']);
    expect(screen.getByText(/Rendering loaded messages/)).toBeTruthy();
    finishBodies();
    expect(container.querySelectorAll('.archive-turn-body')).toHaveLength(12);
    expect(container.querySelectorAll('.archive-turn-pending')).toHaveLength(0);
    expect(screen.queryByText(/Rendering loaded messages/)).toBeNull();
  });

  it('preserves retained row and Markdown DOM identity when earlier turns are prepended', () => {
    const turns = makeTurns(9);
    const view = render(<ChatArchiveReader {...readerProps} detail={{ turns }} />);
    finishBodies();
    const retainedRows = [...view.container.querySelectorAll('.archive-turn')];
    const retainedBodies = [...view.container.querySelectorAll('.archive-turn-body')];
    const earlier = makeTurns(6, 'Earlier');
    view.rerender(<ChatArchiveReader {...readerProps} detail={{ turns: [...earlier, ...turns] }} />);
    const after = [...view.container.querySelectorAll('.archive-turn')];
    retainedRows.forEach((row, index) => {
      expect(after[index + earlier.length]).toBe(row);
      expect(row.querySelector('.archive-turn-body')).toBe(retainedBodies[index]);
      expect(row.getAttribute('data-body-ready')).toBe('true');
    });
    finishBodies();
    expect(view.container.querySelectorAll('.archive-turn-body')).toHaveLength(15);
  });

  it('copies every loaded turn on demand while older bodies are still pending', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    vi.stubGlobal('isSecureContext', true);
    const turns = makeTurns(12);
    const { container } = render(<ChatArchiveReader {...readerProps} detail={{ turns }} />);
    expect(container.querySelectorAll('.archive-turn-pending').length).toBeGreaterThan(0);
    expect(writeText).not.toHaveBeenCalled();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Copy loaded chat as Markdown' })); });
    expect(writeText).toHaveBeenCalledExactlyOnceWith(turns.map(turn => archiveTurnText(turn, 'Agent')).join('\n\n'));
    expect(container.querySelectorAll('.archive-turn-pending').length).toBeGreaterThan(0);
    expect(frames.size).toBe(1);
  });
});
