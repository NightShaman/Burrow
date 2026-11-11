import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  defaultImageDraft,
  ForgeImageOptions,
  imageDraftError,
  imageDraftOptions,
} from './ForgeImageOptions';

afterEach(cleanup);
const gif = () => ({ ...defaultImageDraft(), outputFormat: 'gif' as const });
describe('per-job Forge image options', () => {
  it('preserves still defaults and sends only applicable fields', () => {
    expect(imageDraftOptions(defaultImageDraft())).toBeUndefined();
    expect(imageDraftOptions({ ...gif(), outputFormat: 'jpeg' })).toEqual({ outputFormat: 'jpeg' });
    expect(imageDraftOptions({ ...gif(), outputFormat: 'webp' })).toEqual({ outputFormat: 'webp' });
    expect(imageDraftOptions(gif())).toEqual({
      outputFormat: 'gif',
      frameCount: 9,
      frameDurationMs: 200,
      size: 'auto',
    });
    expect(imageDraftOptions({ ...gif(), frameDurationMs: '207' })?.frameDurationMs).toBe(210);
  });
  it('validates frame counts and delay with useful empty and boundary states', () => {
    for (const frameCount of ['', '1', '17', '2.5'])
      expect(imageDraftError({ ...gif(), frameCount })).toMatch(/whole frames/);
    for (const frameDurationMs of ['', '0', '19', '2001'])
      expect(imageDraftError({ ...gif(), frameDurationMs })).toMatch(/frame delay/);
    for (const frameCount of ['2', '16'])
      for (const frameDurationMs of ['20', '2000'])
        expect(imageDraftError({ ...gif(), frameCount, frameDurationMs })).toBe('');
  });
  it('reveals only GIF controls and uses provided format and size capabilities', () => {
    const onChange = vi.fn();
    const props = {
      draft: defaultImageDraft(),
      formats: ['png', 'gif'] as const,
      sizes: ['auto', '1024x1024'],
      disabled: false,
      onChange,
    };
    const view = render(<ForgeImageOptions {...props} formats={[...props.formats]} />);
    expect(screen.queryByRole('spinbutton')).toBeNull();
    expect(screen.queryByRole('option', { name: 'JPEG' })).toBeNull();
    fireEvent.change(screen.getByLabelText('Output format'), { target: { value: 'gif' } });
    expect(onChange).toHaveBeenCalledWith(gif());
    view.rerender(<ForgeImageOptions {...props} formats={[...props.formats]} draft={gif()} />);
    expect(screen.getByLabelText('Frames')).toBeTruthy();
    expect(screen.getByLabelText('Frame delay (ms)')).toBeTruthy();
    expect(screen.getByText('Duration: 1.8 s')).toBeTruthy();
    expect(
      [...(screen.getByLabelText('GIF size') as HTMLSelectElement).options].map((o) => o.value),
    ).toEqual(['auto', '1024x1024']);
    fireEvent.change(screen.getByLabelText('Output format'), { target: { value: 'png' } });
    expect(onChange).toHaveBeenLastCalledWith(defaultImageDraft());
  });
  it('shows validation rather than NaN duration and normalizes delay on blur', () => {
    const onChange = vi.fn();
    const props = { formats: ['png', 'gif'] as const, sizes: ['auto'], disabled: false, onChange };
    const view = render(
      <ForgeImageOptions
        {...props}
        formats={[...props.formats]}
        draft={{ ...gif(), frameCount: '' }}
      />,
    );
    expect(screen.getByRole('alert').textContent).toMatch(/whole frames/);
    expect(screen.queryByText(/Duration:/)).toBeNull();
    view.rerender(
      <ForgeImageOptions
        {...props}
        formats={[...props.formats]}
        draft={{ ...gif(), frameDurationMs: '207' }}
      />,
    );
    fireEvent.blur(screen.getByLabelText('Frame delay (ms)'));
    expect(onChange).toHaveBeenLastCalledWith({ ...gif(), frameDurationMs: '210' });
  });
});
