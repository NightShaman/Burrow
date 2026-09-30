import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ImagePreview } from './ImagePreview';
afterEach(cleanup);
describe('ImagePreview', () => {
  it('opens, switches size, traps focus, closes with Escape and restores focus', () => {
    render(<ImagePreview src="/test.png" alt="Artwork" />);
    const trigger = screen.getByRole('button', { name: 'Enlarge Artwork' });
    fireEvent.click(trigger);
    expect(screen.getByRole('dialog').getAttribute('aria-modal')).toBe('true');
    const close = screen.getByRole('button', { name: 'Close image viewer' });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Actual size' }));
    fireEvent.click(screen.getByRole('button', { name: 'Actual size' }));
    expect(screen.getByRole('button', { name: 'Fit to screen' })).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
  it('closes from the backdrop or close button and displays load failures', () => {
    render(<ImagePreview src="/test.png" alt="Artwork" />);
    const open = () => fireEvent.click(screen.getByRole('button', { name: 'Enlarge Artwork' }));
    open();
    fireEvent.error(screen.getByRole('dialog').querySelector('img')!);
    expect(screen.getByRole('alert').textContent).toContain('could not be loaded');
    fireEvent.click(screen.getByRole('dialog').parentElement!);
    expect(screen.queryByRole('dialog')).toBeNull();
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Close image viewer' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
