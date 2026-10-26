import { expect, it } from 'vitest';
import css from './panels.css?raw';

it('distributes available pane height across equal card tracks', () => {
  expect(css).toContain('.rail-panel:has(> .account-status){display:flex;flex-direction:column}');
  expect(css).toContain('.rail-panel:has(> .account-status) > .rail-head{flex:none}');
  expect(css).toContain('overflow:auto;display:flex;flex-direction:column;container-type:size;container-name:account-pane');
  expect(css).toContain('grid-auto-rows:1fr;gap:4px');
  expect(css).toContain('.account-status .account-stack > .account-card{min-width:0;margin:0;');
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

it('keeps percentages next to their own bars with a distinct inter-meter gap', () => {
 expect(css).toContain('row-gap:2px;column-gap:16px');
 expect(css).toContain('grid-template-columns:minmax(0,1fr) 28px;column-gap:3px');
});
