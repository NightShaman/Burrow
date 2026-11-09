import { expect, it } from 'vitest';
import postcss from 'postcss';
import base from '../styles/base.css?raw';
import responsive from '../styles/responsive.css?raw';
import viteConfig from '../../vite.config.ts?raw';

function declarations(css: string, selector: string) {
  const found: Record<string, string>[] = [];
  postcss.parse(css).walkRules(selector, (rule) => {
    found.push(
      Object.fromEntries(
        rule.nodes
          .filter((node): node is postcss.Declaration => node.type === 'decl')
          .map((node) => [node.prop, node.value]),
      ),
    );
  });
  return found;
}

const settingsButtons = '.settings-navigation-card .settings-prototype-menu-items button';
it('sizes both horizontal navigation rows by label with consistent padding', () => {
  for (const selector of ['.page-tabs button', settingsButtons]) {
    expect(declarations(base, selector)).toContainEqual(
      expect.objectContaining({ 'min-width': '0', padding: '0 14px', height: '38px' }),
    );
    const rules = [...declarations(base, selector), ...declarations(responsive, selector)];
    expect(rules.filter((rule) => 'min-width' in rule).map((rule) => rule['min-width'])).toEqual([
      '0',
    ]);
    expect(rules).toContainEqual(expect.objectContaining({ padding: '0 8px' }));
  }
});

it('gives the horizontal Settings separator a non-shrinking vertical line', () => {
  expect(declarations(base, '.settings-navigation-card .settings-prototype-menu-divider')).toEqual([
    expect.objectContaining({
      flex: '0 0 1px',
      width: '1px',
      height: 'auto',
      'align-self': 'stretch',
      margin: '4px 0',
      background: 'var(--accent)',
    }),
  ]);
});

it('preserves the browser-facing Host through the Vite API proxy for origin checks', () => {
  // String proxy shorthand enables changeOrigin in Vite, causing browser_origin_not_allowed.
  expect(viteConfig).toContain("'/api': { target: 'http://127.0.0.1:42817', changeOrigin: false }");
});
