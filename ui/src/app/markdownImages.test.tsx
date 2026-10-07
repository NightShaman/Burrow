import {cleanup, fireEvent, render, screen} from '@testing-library/react';
import {afterEach, expect, it} from 'vitest';
import {MarkdownImage} from './markdownTables';
afterEach(cleanup);
it.each(['https://external.invalid/a.png','//external.invalid/a.png'])('requires source-specific consent for %s', src => {
 const view = render(<MarkdownImage src={src} alt="external"/>);
 expect(view.container.querySelector('img')).toBeNull();
 fireEvent.click(screen.getByRole('button')); expect(view.container.querySelector('img')?.getAttribute('src')).toBe(src);
 view.rerender(<MarkdownImage src="//other.invalid/b.png" alt="external"/>); expect(view.container.querySelector('img')).toBeNull();
});
