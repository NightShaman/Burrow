import { expect, it } from 'vitest';
import { clientClipBox } from './client-clip.mjs';
const box = {
  root: false,
  rect: { left: 8, top: 78 },
  clientLeft: 1,
  clientTop: 2,
  clientWidth: 338,
  clientHeight: 500,
  viewportWidth: 380,
  viewportHeight: 1000,
};
it('keeps nested border and scrollbar excluded from the scrollport', () => {
  expect(clientClipBox(box)).toEqual({ left: 9, top: 80, right: 347, bottom: 580 });
});
it('does not subtract document scroll twice from the root viewport', () => {
  expect(
    clientClipBox({
      ...box,
      root: true,
      rect: { left: 0, top: -102 },
      clientWidth: 380,
      clientHeight: 1000,
    }),
  ).toEqual({ left: 0, top: 0, right: 380, bottom: 1000 });
});
it('retains genuine nested clipping after page scroll', () => {
  expect(clientClipBox({ ...box, rect: { left: 8, top: -102 } }).bottom).toBe(400);
});
it('uses viewport rather than enlarged document dimensions for the root', () => {
  expect(clientClipBox({ ...box, root: true, clientHeight: 2400 }).bottom).toBe(1000);
});
