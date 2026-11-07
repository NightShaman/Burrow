import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useTranscriptScroll } from './useTranscriptScroll';

const progress: never[] = [];
const inputs: never[] = [];
function Harness({ load }: { load?: () => Promise<void> }) {
  const scroll = useTranscriptScroll({
    isLoading: false,
    isNewSession: false,
    messageCount: 1,
    isSending: false,
    liveProgress: progress,
    liveAnswer: '',
    chatInputs: inputs,
    error: '',
    onLoadOlder: load,
  });
  return (
    <>
      <div ref={scroll.messagesRef} onScroll={scroll.updateScrollIntent}>
        <span>content</span>
      </div>
      <button onClick={scroll.loadOlder}>older</button>
      {scroll.showJumpToLatest && <button onClick={scroll.jumpToLatest}>jump</button>}
    </>
  );
}
afterEach(() => vi.unstubAllGlobals());
it('observes the container and children, follows resize only while sticky, and disconnects', () => {
  const observers: {
    callback: ResizeObserverCallback;
    observe: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
  }[] = [];
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe = vi.fn();
      disconnect = vi.fn();
      constructor(callback: ResizeObserverCallback) {
        observers.push({ callback, observe: this.observe, disconnect: this.disconnect });
      }
    },
  );
  const view = render(<Harness />);
  const element = view.container.querySelector('div')!;
  Object.defineProperties(element, {
    scrollHeight: { configurable: true, value: 1200 },
    clientHeight: { configurable: true, value: 400 },
  });
  const first = observers.at(-1)!;
  expect(first.observe).toHaveBeenCalledWith(element);
  expect(first.observe).toHaveBeenCalledWith(element.firstElementChild);
  act(() => first.callback([], {} as ResizeObserver));
  expect(element.scrollTop).toBe(1200);
  element.scrollTop = 100;
  fireEvent.scroll(element);
  const current = observers.at(-1)!;
  act(() => current.callback([], {} as ResizeObserver));
  expect(element.scrollTop).toBe(100);
  fireEvent.click(screen.getByText('jump'));
  expect(element.scrollTop).toBe(1200);
  const last = observers.at(-1)!;
  view.unmount();
  expect(last.disconnect).toHaveBeenCalled();
});
it('restores the visible anchor after loading older messages', async () => {
  let frame: FrameRequestCallback | undefined;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frame = callback;
    return 1;
  });
  let finish!: () => void;
  const load = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const view = render(<Harness load={load} />);
  const element = view.container.querySelector('div')!;
  Object.defineProperties(element, {
    scrollHeight: { configurable: true, value: 1000 },
    clientHeight: { configurable: true, value: 400 },
  });
  element.scrollTop = 200;
  fireEvent.click(screen.getByText('older'));
  Object.defineProperty(element, 'scrollHeight', { configurable: true, value: 1400 });
  await act(async () => {
    finish();
    await Promise.resolve();
  });
  act(() => frame!(0));
  expect(element.scrollTop).toBe(600);
});
