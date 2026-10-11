import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { api, importExport } from '../../app/api';
import { ExportSettings } from './ExportSettings';

vi.mock('../../app/api', () => ({ api: vi.fn(), importExport: vi.fn(), downloadExport: vi.fn() }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });

const choose = async () => {
  const file = new File(['data'], 'sample.gz');
  Object.defineProperty(file, 'arrayBuffer', { value: async () => new Uint8Array([1, 2]).buffer });
  fireEvent.change(document.querySelector('.export-file-input')!, { target: { files: [file] } });
  await screen.findByText('Export preview');
};

it('invalidates preview when policy changes and applies only after successful repeat preview', async () => {
  vi.mocked(api).mockResolvedValue({ categories: [], passwordMinLength: 12 });
  vi.mocked(importExport).mockResolvedValueOnce({ supported: ['settings'] }).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ supported: ['settings'] }).mockResolvedValue({});
  render(<ExportSettings />);
  await choose();
  fireEvent.change(screen.getByLabelText('Conflict handling'), { target: { value: 'replace' } });
  expect(screen.queryByText('Export preview')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Preview export' }));
  await screen.findByRole('alert');
  expect(screen.queryByRole('button', { name: 'Import export' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Preview export' }));
  expect(await screen.findByRole('button', { name: 'Import export' })).toBeTruthy();
  expect(vi.mocked(importExport).mock.calls[2][0]).toMatchObject({ conflictPolicy: 'replace' });
});

it('does not allow apply for password challenge or a changed password', async () => {
  vi.mocked(api).mockResolvedValue({ categories: [], passwordMinLength: 12 });
  vi.mocked(importExport).mockRejectedValueOnce(new Error('import_password_required')).mockResolvedValue({ supported: ['settings'] });
  render(<ExportSettings />);
  const file = new File(['data'], 'protected.gz');
  Object.defineProperty(file, 'arrayBuffer', { value: async () => new Uint8Array([1]).buffer });
  fireEvent.change(document.querySelector('.export-file-input')!, { target: { files: [file] } });
  await screen.findByRole('alert');
  expect(screen.queryByRole('button', { name: 'Import export' })).toBeNull();
  fireEvent.change(screen.getByLabelText('Export password'), { target: { value: 'first' } });
  fireEvent.click(screen.getByRole('button', { name: 'Preview export' }));
  expect(await screen.findByRole('button', { name: 'Import export' })).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Export password'), { target: { value: 'second' } });
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Import export' })).toBeNull());
});
