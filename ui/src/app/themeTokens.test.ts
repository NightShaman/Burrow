import base from '../styles/base.css?raw';
import halloweenCss from '../styles/halloween.css?raw';
import { expect, it } from 'vitest';
import { themes } from './usePersistedLayout';
const sheets = import.meta.glob('../**/*.css', { query: '?raw', import: 'default', eager: true }) as Record<string,string>;
it('all stylesheet custom-property references resolve or explicitly provide a fallback', () => {
 const css = Object.values(sheets).join('\n');
 const defined = new Set(Array.from(css.matchAll(/(--[\w-]+)\s*:/g), match => match[1]));
 defined.add('--i'); // Defined inline by animated component.
 const unresolved = Array.from(css.matchAll(/var\((--[\w-]+)\s*\)/g), match => match[1]).filter(name => !defined.has(name));
 expect([...new Set(unresolved)]).toEqual([]);
 expect(css).not.toContain('var(--text-strong)9');
});
it('every supported palette defines status and selection roles', () => {
 for (const theme of themes.filter(theme => theme !== 'smatchet')) {
  const block = base.slice(base.indexOf(`[data-theme="${theme}"]`)).split('}')[0];
  for (const token of ['--accent:','--line:','--muted:','--ok:','--warn:']) expect(block).toContain(token);
 }
});

function palette(theme: string) {
 const block = base.slice(base.indexOf(`[data-theme="${theme}"]`)).split('}')[0];
 return Object.fromEntries(Array.from(block.matchAll(/(--[\w-]+):([^;}]*)/g), match => [match[1], match[2]]));
}
function contrast(a: string, b: string) {
 const luminance = (hex: string) => {
  const full = hex.length === 4 ? '#' + [...hex.slice(1)].map(x => x + x).join('') : hex;
  const rgb = [1,3,5].map(i => parseInt(full.slice(i, i + 2), 16) / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
  return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
 };
 const x = luminance(a), y = luminance(b);
 return (Math.max(x, y) + .05) / (Math.min(x, y) + .05);
}
it('keeps Halloween independent, with Midnight surfaces and orange/green/purple roles', () => {
 const halloween = palette('halloween'), midnight = palette('midnight');
 for (const role of ['--surface','--surface-sunken','--panel','--panel-2','--panel-3','--surface-raised','--surface-input']) expect(halloween[role]).toBe(midnight[role]);
 expect(halloween['--accent']).toBe('#f97316');
 expect(halloween['--ok']).toBe('#a3e635');
 expect(halloween['--focus-ring']).toBe('#a855f7');
 expect(midnight['--accent']).toBe('#ba35ce');
 expect(midnight['--line']).toBe('#263d58');
});
it('provides readable Halloween text/status roles and contrasting filled controls/focus', () => {
 const p = palette('halloween');
 for (const surface of ['--surface', '--panel', '--panel-2', '--surface-raised', '--surface-hover', '--accent-subtle']) {
  for (const text of ['--text', '--text-strong', '--muted', '--accent', '--accent-strong', '--ok', '--warn', '--danger']) {
   expect(contrast(p[text], p[surface]), `${text} on ${surface}`).toBeGreaterThanOrEqual(4.5);
  }
  expect(contrast(p['--focus-ring'], p[surface])).toBeGreaterThanOrEqual(3);
 }
 expect(contrast(p['--on-accent'], p['--accent'])).toBeGreaterThanOrEqual(4.5);
 expect(contrast(p['--accent-contrast'], p['--accent'])).toBeGreaterThanOrEqual(3);
});

it('limits the Halloween operator bubble adjustment to a readable plum fill and warm text', () => {
 const block = halloweenCss.match(/\[data-theme="halloween"\] \.message\.operator \.message-bubble\s*\{([^}]*)\}/)?.[1];
 expect(block).toBeDefined();
 const declarations = Object.fromEntries(Array.from(block!.matchAll(/([\w-]+):\s*([^;]+);/g), match => [match[1], match[2].trim()]));
 expect(declarations).toEqual({ background: '#160e20', color: '#f5eee6' });
 expect(contrast(declarations.color, declarations.background)).toBeGreaterThanOrEqual(7);
 expect(palette('halloween')['--accent-border']).toBe('#8653a3');
});
