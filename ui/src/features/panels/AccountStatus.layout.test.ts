import { expect, it } from 'vitest';
import css from './panels.css?raw';

it('keeps content-sized cards in a scrollable pane without stretched gaps', () => {
  expect(css).toContain('.rail-panel:has(> .account-status){display:flex;flex-direction:column}');
  expect(css).toContain('.rail-panel:has(> .account-status) > .rail-head{flex:none}');
  expect(css).toContain('overflow:auto;display:flex;flex-direction:column;gap:4px;container-type:size;container-name:account-pane');
  expect(css).toContain('.account-status > .account-card{flex:none;min-width:0;margin:0;');
});

it('sizes reset actions with the card rather than inheriting settings button height', () => {
 expect(css).toContain('min-height:24px;height:24px');
 expect(css).toContain('@container account-pane (height < 800px)');
 expect(css).toContain('white-space:normal;overflow-wrap:anywhere');
 expect(css).not.toContain('text-overflow:ellipsis');
 expect(css).not.toContain('justify-content:space-between;gap:2px');
 expect(css).not.toContain('flex-basis:140px');
 expect(css).toContain('.account-status .account-meter.secondary{min-height:0;');
});
