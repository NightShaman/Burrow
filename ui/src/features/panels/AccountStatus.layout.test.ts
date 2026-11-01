import { expect, it } from 'vitest';
import postcss from 'postcss';
import css from './panels.css?raw';

const root = postcss.parse(css);
const rules = (selector: string) =>
  root.nodes.flatMap(function collect(node): postcss.Rule[] {
    if (node.type === 'rule') return node.selector === selector ? [node] : [];
    if (node.type === 'atrule') return node.nodes?.flatMap(collect) ?? [];
    return [];
  });
const declarations = (selector: string) =>
  rules(selector).map((rule) =>
    Object.fromEntries(
      rule.nodes
        .filter((node): node is postcss.Declaration => node.type === 'decl')
        .map((node) => [node.prop, node.value]),
    ),
  );
const hasDeclarations = (selector: string, expected: Record<string, string>) =>
  declarations(selector).some((decls) =>
    Object.entries(expected).every(([prop, value]) => decls[prop] === value),
  );

it('distributes available pane height across equal card tracks', () => {
  expect(
    hasDeclarations('.rail-panel:has(> .account-status)', {
      display: 'flex',
      'flex-direction': 'column',
    }),
  ).toBe(true);
  expect(hasDeclarations('.rail-panel:has(> .account-status) > .rail-head', { flex: 'none' })).toBe(
    true,
  );
  expect(
    hasDeclarations('.rail-panel > .account-status', {
      overflow: 'auto',
      display: 'flex',
      'flex-direction': 'column',
      'container-type': 'size',
      'container-name': 'account-pane',
    }),
  ).toBe(true);
  expect(
    hasDeclarations('.account-status .account-stack', { 'grid-auto-rows': '1fr', gap: '4px' }),
  ).toBe(true);
  expect(
    hasDeclarations('.account-status .account-stack > .account-card', {
      'min-width': '0',
      margin: '0',
    }),
  ).toBe(true);
});

it('sizes reset actions with the card rather than inheriting settings button height', () => {
  expect(
    hasDeclarations('.account-status .account-resets button', {
      'min-height': '24px',
      height: '24px',
    }),
  ).toBe(true);
  expect(
    root.nodes.some(
      (node) =>
        node.type === 'atrule' &&
        node.name === 'container' &&
        node.params === 'account-pane (height < 800px)',
    ),
  ).toBe(true);
  expect(
    hasDeclarations('.account-status .account-top b', {
      'white-space': 'normal',
      'overflow-wrap': 'anywhere',
    }),
  ).toBe(true);
  expect(
    declarations('.account-status .account-top b').every((decls) => !('text-overflow' in decls)),
  ).toBe(true);
  expect(
    declarations('.account-status .account-resets-row').every((decls) => decls.gap !== '2px'),
  ).toBe(true);
  expect(
    declarations('.account-status .account-resets button').every(
      (decls) => decls['flex-basis'] !== '140px',
    ),
  ).toBe(true);
  expect(hasDeclarations('.account-status .account-meter.secondary', { 'min-height': '0' })).toBe(
    true,
  );
});

it('keeps percentages next to their own bars with a distinct inter-meter gap', () => {
  expect(
    hasDeclarations('.account-status .account-meters', { 'row-gap': '2px', 'column-gap': '16px' }),
  ).toBe(true);
  expect(
    hasDeclarations('.account-status .account-meter', {
      'grid-template-columns': 'minmax(0, 1fr) 28px',
      'column-gap': '3px',
    }),
  ).toBe(true);
});
