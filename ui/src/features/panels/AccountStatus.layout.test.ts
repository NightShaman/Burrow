import { expect, it } from 'vitest';
import css from './panels.css?raw';

it('shrinks account cards within their pane without adding a scrolling list', () => {
  expect(css).toContain('.rail-panel:has(> .account-status){display:flex;flex-direction:column}');
  expect(css).toContain('.rail-panel:has(> .account-status) > .rail-head{flex:none}');
  expect(css).toContain('overflow:visible;display:flex;flex-direction:column;gap:6px;container-type:size;container-name:account-pane');
  expect(css).toContain('.account-status > .account-card{flex:0 1 120px;min-height:0;margin:0;');
});

it('sizes reset actions with the card rather than inheriting settings button height', () => {
 expect(css).toContain('min-height:24px;height:clamp(24px,30cqh,28px)');
 expect(css).toContain('@container account-pane (height < 800px)');
 expect(css).toContain('.account-status > .account-card:has(.account-resets){min-height:66px}');
 expect(css).not.toContain('flex-basis:140px');
 expect(css).toContain('.account-status .account-meter.secondary{min-height:0;');
});
