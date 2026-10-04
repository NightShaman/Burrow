import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { Editor } from './ChatPage';
afterEach(cleanup);
it.each([undefined, false])('disables Edit until loaded (%s)', fileLoaded => {
  render(<Editor tab={{ id: 'file', label: 'file', kind: 'file', content: '', fileLoaded }} setTabs={vi.fn()} onSave={vi.fn()} />);
  expect((screen.getByRole('button', { name: 'Edit' }) as HTMLButtonElement).disabled).toBe(true);
});
it('allows editing a successfully loaded empty file', () => {
  render(<Editor tab={{ id: 'file', label: 'file', kind: 'file', content: '', fileLoaded: true }} setTabs={vi.fn()} onSave={vi.fn()} />);
  expect((screen.getByRole('button', { name: 'Edit' }) as HTMLButtonElement).disabled).toBe(false);
});
