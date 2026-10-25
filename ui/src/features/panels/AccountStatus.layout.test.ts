import { expect, it } from 'vitest';
import css from './panels.css?raw';

it('bounds both account lists to their rail pane, below any pane heading', () => {
  expect(css).toContain('.rail-panel:has(> .account-status){display:flex;flex-direction:column}');
  expect(css).toContain('.rail-panel:has(> .account-status) > .rail-head{flex:none}');
  expect(css).toContain('.rail-panel > .account-status{flex:1;min-height:0;overflow:auto;overscroll-behavior:contain}');
});
