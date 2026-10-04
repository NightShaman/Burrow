import base from '../styles/base.css?raw';
import { expect, it } from 'vitest';
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
 for (const theme of ['nexus','hatchet','chaos','paper','terminal','high-contrast']) {
  const block = base.slice(base.indexOf(`[data-theme="${theme}"]`)).split('}')[0];
  for (const token of ['--accent:','--line:','--muted:','--ok:','--warn:']) expect(block).toContain(token);
 }
});
