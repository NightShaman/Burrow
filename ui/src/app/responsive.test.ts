import css from '../styles/responsive.css?raw';
import { expect, it } from 'vitest';
it('keeps existing rails and essential toolbar labels available during reflow', () => {
 expect(css).not.toContain('.left-rail,.right-rail{display:none}');
 expect(css).not.toContain('.workspace-toolbar label{display:none}');
 expect(css).toContain('.workspace-toolbar{display:flex;flex-wrap:wrap');
 expect(css).toContain('.cockpit{width:100%;height:auto');
});
