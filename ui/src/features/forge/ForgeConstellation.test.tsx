import { cleanup, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ForgeConstellation, forgeFigures } from './ForgeConstellation';

afterEach(cleanup);
it('keeps all three authored silhouettes and eight Gerald arms with effects off', () => {
  const context = vi.spyOn(HTMLCanvasElement.prototype, 'getContext');
  const { container } = render(<ForgeConstellation enabled={false} />);
  expect(context).not.toHaveBeenCalled();
  expect([...container.querySelectorAll('svg')].map((s) => s.dataset.figure)).toEqual([
    'Goblin',
    'Gerald the octopus',
    'Kerning the magenta dragon',
  ]);
  expect(forgeFigures[1].paths.slice(4)).toHaveLength(8);
  expect(container.querySelectorAll('circle').length).toBeGreaterThan(100);
});
it('caps DPR, reacts to the pointer, pauses while hidden and cleans up', () => {
  const ctx = {
    setTransform: vi.fn(),
    clearRect: vi.fn(),
    createRadialGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
    fillRect: vi.fn(),
    beginPath: vi.fn(),
    arc: vi.fn(),
    stroke: vi.fn(),
  };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    ctx as unknown as CanvasRenderingContext2D,
  );
  vi.stubGlobal('devicePixelRatio', 4);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    width: 1000,
    height: 600,
    left: 0,
    top: 0,
  } as DOMRect);
  let callback: FrameRequestCallback = () => {};
  const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
    callback = cb;
    return 1;
  });
  const cancel = vi.spyOn(window, 'cancelAnimationFrame');
  const { container, unmount } = render(
    <section>
      <ForgeConstellation enabled />
    </section>,
  );
  const canvas = container.querySelector('canvas')!;
  expect(canvas.width).toBe(2000);
  container
    .querySelector('section')!
    .dispatchEvent(new MouseEvent('pointermove', { clientX: 200, clientY: 100 }));
  callback(performance.now());
  expect(ctx.createRadialGradient).toHaveBeenCalled();
  document.dispatchEvent(new Event('visibilitychange'));
  expect(cancel).toHaveBeenCalled();
  unmount();
  expect(canvas.width).toBe(0);
  const calls = raf.mock.calls.length;
  document.dispatchEvent(new Event('visibilitychange'));
  expect(raf.mock.calls.length).toBe(calls);
  vi.unstubAllGlobals();
});
it('renders static artwork without a canvas context under reduced motion', () => {
  vi.stubGlobal('matchMedia', () => ({
    matches: true,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  const context = vi.spyOn(HTMLCanvasElement.prototype, 'getContext');
  const { container } = render(<ForgeConstellation enabled />);
  expect(context).not.toHaveBeenCalled();
  expect(container.querySelectorAll('svg')).toHaveLength(3);
  vi.unstubAllGlobals();
});
