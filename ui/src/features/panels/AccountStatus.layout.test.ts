import { expect, it } from 'vitest';
import css from './panels.css?raw';

it('shrinks account cards within their pane without adding a scrolling list', () => {
  expect(css).toContain('.rail-panel:has(> .account-status){display:flex;flex-direction:column}');
  expect(css).toContain('.rail-panel:has(> .account-status) > .rail-head{flex:none}');
  expect(css).toContain('overflow:visible;display:flex;flex-direction:column;gap:6px;container-type:size');
  expect(css).toContain('.account-status > .account-card{flex:0 1 120px;min-height:0;margin:0;');
});
