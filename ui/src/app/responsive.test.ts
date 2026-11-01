import postcss from 'postcss';
import css from '../styles/responsive.css?raw';
import { expect, it } from 'vitest';

it('keeps existing rails and essential toolbar labels available during reflow', () => {
  const root = postcss.parse(css);
  const rules = (selector: string) =>
    root.nodes.flatMap(function collect(node): postcss.Rule[] {
      if (node.type === 'rule') return node.selector === selector ? [node] : [];
      if (node.type === 'atrule') return node.nodes?.flatMap(collect) ?? [];
      return [];
    });
  expect(
    rules('.left-rail, .right-rail').some((rule) =>
      rule.nodes.some(
        (node) => node.type === 'decl' && node.prop === 'display' && node.value === 'none',
      ),
    ),
  ).toBe(false);
  expect(
    rules('.workspace-toolbar label').some((rule) =>
      rule.nodes.some(
        (node) => node.type === 'decl' && node.prop === 'display' && node.value === 'none',
      ),
    ),
  ).toBe(false);
  const mobile = root.nodes.filter(
    (node): node is postcss.AtRule =>
      node.type === 'atrule' && node.name === 'media' && node.params === '(max-width: 600px)',
  );
  expect(
    mobile.some((media) =>
      media.nodes?.some(
        (node) =>
          node.type === 'rule' &&
          node.selector === '.workspace-toolbar' &&
          node.nodes.some(
            (declaration) =>
              declaration.type === 'decl' &&
              declaration.prop === 'flex-wrap' &&
              declaration.value === 'wrap',
          ),
      ),
    ),
  ).toBe(true);
  expect(
    mobile.some((media) =>
      media.nodes?.some(
        (node) =>
          node.type === 'rule' &&
          node.selector === '.cockpit' &&
          node.nodes.some(
            (declaration) =>
              declaration.type === 'decl' &&
              declaration.prop === 'height' &&
              declaration.value === 'auto',
          ),
      ),
    ),
  ).toBe(true);
});
