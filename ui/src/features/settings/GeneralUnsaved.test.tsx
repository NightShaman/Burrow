import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { api } from '../../app/api';
import { UnsavedChangesProvider, useUnsavedNavigation } from '../../app/UnsavedChanges';
import { BrowserTabSettings } from './BrowserTabSettings';
import { GlobalProfileDocuments } from './GlobalProfileDocuments';
import { ExecutionBoundaries } from './ExecutionBoundaries';

vi.mock('../../app/api', async original => ({ ...await original<typeof import('../../app/api')>(), api: vi.fn() }));
afterEach(() => { cleanup(); vi.resetAllMocks(); document.body.removeAttribute('data-destination'); });
function Destination() {
  const navigate = useUnsavedNavigation();
  return <button onClick={() => navigate(() => document.body.setAttribute('data-destination', 'yes'))}>Leave settings</button>;
}
function mount(form: React.ReactNode) { document.body.removeAttribute('data-destination'); render(<UnsavedChangesProvider>{form}<Destination /></UnsavedChangesProvider>); }

it('browser tab guards dirty navigation, failed Save stays, Discard restores accepted suffix', async () => {
  vi.mocked(api).mockResolvedValueOnce({ suffix: 'Dev' }).mockRejectedValueOnce(new Error('offline'));
  mount(<BrowserTabSettings />);
  const field = await screen.findByLabelText('Browser tab suffix');
  await waitFor(() => expect((field as HTMLInputElement).value).toBe('Dev'));
  fireEvent.change(field, { target: { value: 'Prod' } });
  fireEvent.click(screen.getByText('Leave settings'));
  fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
  await screen.findByText('Could not save browser tab suffix.');
  expect(document.body.getAttribute('data-destination')).toBeNull();
  expect((field as HTMLInputElement).value).toBe('Prod');
  fireEvent.click(screen.getByText('Leave settings'));
  fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
  expect((field as HTMLInputElement).value).toBe('Dev');
  expect(document.body.getAttribute('data-destination')).toBe('yes');
});

it('document selection guards dirty markdown and Stay retains it', async () => {
  vi.mocked(api).mockResolvedValue({ documents: [{ kind: 'RULES', markdown: 'saved' }, { kind: 'ORIENTATION', markdown: 'other' }] });
  const overflow = document.createElement('div'); document.body.append(overflow);
  mount(<GlobalProfileDocuments overflowTarget={overflow} />);
  const markdown = await screen.findByLabelText('Markdown');
  fireEvent.change(markdown, { target: { value: 'draft' } });
  fireEvent.click(screen.getByRole('button', { name: 'Global Orientation' }));
  expect(screen.getByText('Unsaved changes')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Stay' }));
  expect((markdown as HTMLTextAreaElement).value).toBe('draft');
});

it('boundary item selection guards dirty rule edits', async () => {
  vi.mocked(api).mockResolvedValue({ boundaries: { version: 1, hardBlocks: [
    { id: 'first', enabled: true, type: 'path', pattern: '/a', match: 'glob', operations: ['write'] },
    { id: 'second', enabled: true, type: 'path', pattern: '/b', match: 'glob', operations: ['write'] },
  ] } });
  mount(<ExecutionBoundaries />);
  fireEvent.click(await screen.findByRole('button', { name: /first/ }));
  fireEvent.change(screen.getByLabelText('Rule ID'), { target: { value: 'edited' } });
  fireEvent.click(screen.getByRole('button', { name: /second/ }));
  expect(screen.getByText('Unsaved changes')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
  expect((screen.getByLabelText('Rule ID') as HTMLInputElement).value).toBe('second');
});

it('retention policy rejects invalid guarded Save and preserves draft', async () => {
  const { RetentionSettings } = await import('./RetentionSettings');
  vi.mocked(api).mockResolvedValue({ policy: { enabled: false, traceMaxAgeDays: null, traceMaxBytes: null, intervalMinutes: 1440 }, state: {}, plan: {} });
  mount(<RetentionSettings />);
  const checkbox = await screen.findByRole('checkbox', { name: /Enable managed cleanup/ });
  await waitFor(() => expect((checkbox as HTMLInputElement).disabled).toBe(false));
  fireEvent.click(checkbox);
  fireEvent.click(screen.getByText('Leave settings'));
  fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
  expect(document.body.getAttribute('data-destination')).toBeNull();
  expect((checkbox as HTMLInputElement).checked).toBe(true);
  await waitFor(() => expect(screen.queryByText('Unsaved changes')).toBeNull());
  fireEvent.click(screen.getByText('Leave settings'));
  fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
  expect((checkbox as HTMLInputElement).checked).toBe(false);
});

it('document guarded Save commits and advances selection only after successful write', async () => {
  const documents = [{ kind: 'RULES', markdown: 'saved' }, { kind: 'ORIENTATION', markdown: 'other' }];
  vi.mocked(api).mockResolvedValueOnce({ documents }).mockResolvedValueOnce({ documents: [{ kind: 'RULES', markdown: 'edited' }, documents[1]] });
  const overflow = document.createElement('div'); document.body.append(overflow);
  mount(<GlobalProfileDocuments overflowTarget={overflow} />);
  const markdown = await screen.findByLabelText('Markdown');
  fireEvent.change(markdown, { target: { value: 'edited' } });
  fireEvent.click(screen.getByRole('button', { name: 'Global Orientation' }));
  fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
  await waitFor(() => expect((markdown as HTMLTextAreaElement).value).toBe('other'));
  expect(vi.mocked(api)).toHaveBeenLastCalledWith('/api/settings/global-profile-documents', expect.objectContaining({ method: 'PUT', body: JSON.stringify({ documents: [{ kind: 'RULES', markdown: 'edited' }, documents[1]] }) }));
});
