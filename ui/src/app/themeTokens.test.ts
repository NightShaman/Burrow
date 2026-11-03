import base from '../styles/base.css?raw';
import halloweenCss from '../styles/halloween.css?raw';
import { expect, it } from 'vitest';
import postcss from 'postcss';
import { themes } from './usePersistedLayout';
const sheets = import.meta.glob('../**/*.css', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;
it('all stylesheet custom-property references resolve or explicitly provide a fallback', () => {
  const css = Object.values(sheets).join('\n');
  const defined = new Set(Array.from(css.matchAll(/(--[\w-]+)\s*:/g), (match) => match[1]));
  defined.add('--i'); // Defined inline by animated component.
  const unresolved = Array.from(css.matchAll(/var\((--[\w-]+)\s*\)/g), (match) => match[1]).filter(
    (name) => !defined.has(name),
  );
  expect([...new Set(unresolved)]).toEqual([]);
  expect(css).not.toContain('var(--text-strong)9');
});
it('every supported palette defines status and selection roles', () => {
  for (const theme of themes.filter((theme) => theme !== 'smatchet')) {
    const roles = palette(theme);
    for (const token of ['--accent', '--line', '--muted', '--ok', '--warn'])
      expect(roles, theme).toHaveProperty(token);
  }
});

function palette(theme: string) {
  const rule = postcss
    .parse(base)
    .nodes.find(
      (node): node is postcss.Rule =>
        node.type === 'rule' && node.selector === `[data-theme='${theme}']`,
    );
  expect(rule, theme).toBeDefined();
  return Object.fromEntries(
    rule!.nodes
      .filter((node): node is postcss.Declaration => node.type === 'decl')
      .map((node) => [node.prop, node.value]),
  );
}
function contrast(a: string, b: string) {
  const luminance = (hex: string) => {
    const full = hex.length === 4 ? '#' + [...hex.slice(1)].map((x) => x + x).join('') : hex;
    const rgb = [1, 3, 5]
      .map((i) => parseInt(full.slice(i, i + 2), 16) / 255)
      .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
  };
  const x = luminance(a),
    y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
it('keeps Halloween independent, with Midnight surfaces and orange/green/purple roles', () => {
  const halloween = palette('halloween'),
    midnight = palette('midnight');
  for (const role of [
    '--surface',
    '--surface-sunken',
    '--panel',
    '--panel-2',
    '--panel-3',
    '--surface-raised',
    '--surface-input',
  ])
    expect(halloween[role]).toBe(midnight[role]);
  expect(halloween['--accent']).toBe('#f97316');
  expect(halloween['--ok']).toBe('#a3e635');
  expect(halloween['--focus-ring']).toBe('#a855f7');
  expect(midnight['--accent']).toBe('#ba35ce');
  expect(midnight['--line']).toBe('#263d58');
});
it('provides readable Halloween text/status roles and contrasting filled controls/focus', () => {
  const p = palette('halloween');
  for (const surface of [
    '--surface',
    '--panel',
    '--panel-2',
    '--surface-raised',
    '--surface-hover',
    '--accent-subtle',
  ]) {
    for (const text of [
      '--text',
      '--text-strong',
      '--muted',
      '--accent',
      '--accent-strong',
      '--ok',
      '--warn',
      '--danger',
    ]) {
      expect(contrast(p[text], p[surface]), `${text} on ${surface}`).toBeGreaterThanOrEqual(4.5);
    }
    expect(contrast(p['--focus-ring'], p[surface])).toBeGreaterThanOrEqual(3);
  }
  expect(contrast(p['--on-accent'], p['--accent'])).toBeGreaterThanOrEqual(4.5);
  expect(contrast(p['--accent-contrast'], p['--accent'])).toBeGreaterThanOrEqual(3);
});

it('limits the Halloween operator bubble adjustment to a readable plum fill and warm text', () => {
  const rule = postcss
    .parse(halloweenCss)
    .nodes.find(
      (node): node is postcss.Rule =>
        node.type === 'rule' &&
        node.selector === "[data-theme='halloween'] .message.operator .message-bubble",
    );
  expect(rule).toBeDefined();
  const declarations = Object.fromEntries(
    rule!.nodes
      .filter((node): node is postcss.Declaration => node.type === 'decl')
      .map((node) => [node.prop, node.value]),
  );
  expect(declarations).toEqual({ background: '#160e20', color: '#f5eee6' });
  expect(contrast(declarations.color, declarations.background)).toBeGreaterThanOrEqual(7);
  expect(palette('halloween')['--accent-border']).toBe('#8653a3');
});

it('keeps Violet Grove on Midnight surfaces with electric violet and softened green', () => {
  const grove = palette('violet-grove');
  const midnight = palette('midnight');
  for (const role of [
    '--surface',
    '--surface-sunken',
    '--panel',
    '--panel-2',
    '--panel-3',
    '--surface-raised',
    '--surface-input',
  ]) {
    expect(grove[role], role).toBe(midnight[role]);
  }
  expect(grove['--accent']).toBe('#b366ff');
  expect(grove['--accent-strong']).toBe('#c084fc');
  expect(grove['--ok']).toBe('#91cf50');
  for (const surface of [
    '--surface',
    '--panel',
    '--panel-2',
    '--surface-raised',
    '--surface-hover',
  ]) {
    for (const text of ['--accent', '--accent-strong', '--ok']) {
      expect(contrast(grove[text], grove[surface]), `${text} on ${surface}`).toBeGreaterThanOrEqual(
        4.5,
      );
    }
  }
  expect(palette('halloween')['--ok']).toBe('#a3e635');
  expect(midnight['--accent']).toBe('#ba35ce');
});

it('uses the shared green for Grove account and healthy Agent meters without masking pressure', () => {
  const workspace = Object.entries(sheets).find(([path]) =>
    path.endsWith('/workspace-rail.css'),
  )![1];
  const panels = Object.entries(sheets).find(([path]) => path.endsWith('/panels.css'))![1];
  const settings = Object.entries(sheets).find(([path]) => path.endsWith('/settings.css'))![1];
  const backgrounds = (css: string, selector: string) => {
    const rule = postcss
      .parse(css)
      .nodes.find(
        (node): node is postcss.Rule =>
          node.type === 'rule' && node.selector.replace(/\s+/g, ' ') === selector,
      );
    expect(rule, selector).toBeDefined();
    return Object.fromEntries(
      rule!.nodes
        .filter((node): node is postcss.Declaration => node.type === 'decl')
        .map((node) => [node.prop, node.value]),
    );
  };
  expect(
    backgrounds(
      workspace,
      "[data-theme='violet-grove'] .context-usage:not(.pressure-watch, .pressure-compress, .pressure-blocked) i b",
    ).background,
  ).toBe('var(--ok)');
  expect(
    backgrounds(panels, "[data-theme='violet-grove'] .account-status .account-meter .usage i")
      .background,
  ).toBe('var(--ok)');
  for (const state of ['watch', 'compress', 'blocked']) {
    expect(backgrounds(workspace, `.context-usage.pressure-${state} i b`).background).toBe(
      state === 'blocked' ? 'var(--danger)' : 'var(--warn)',
    );
  }
  const swatch = backgrounds(settings, '.theme-swatch.violet-grove');
  expect(swatch['--swatch-accent']).toBe(palette('violet-grove')['--accent']);
  expect(swatch['--swatch-panel']).toBe(palette('violet-grove')['--ok']);
});
