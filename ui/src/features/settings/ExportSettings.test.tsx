import { ConfirmProvider } from '../../app/ConfirmDialog';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render as baseRender, screen, waitFor } from '@testing-library/react';
import { api, downloadExport, importExport } from '../../app/api';
import { ExportSettings } from './ExportSettings';
import catalog from '../../../scripts/export-settings-fixture/catalog.json';

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

function render(ui: Parameters<typeof baseRender>[0]) { return baseRender(ui, { wrapper: ConfirmProvider }); }

it('uses shared confirmation, cancels without applying, and applies once after approval', async () => {
  vi.mocked(api).mockResolvedValue({ categories: [], passwordMinLength: 12 });
  vi.mocked(importExport).mockResolvedValue({ supported: ['settings'] });
  render(<ExportSettings />);
  await choose();
  fireEvent.click(screen.getByRole('button', { name: 'Import export' }));
  expect(screen.getByRole('alertdialog', { name: 'Import this export?' })).toBeTruthy();
  expect(screen.getByLabelText('Conflict handling')).toHaveProperty('disabled', true);
  expect(vi.mocked(importExport).mock.calls).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  await waitFor(() => expect(screen.getByLabelText('Conflict handling')).toHaveProperty('disabled', false));
  fireEvent.click(screen.getByRole('button', { name: 'Import export' }));
  fireEvent.click(screen.getByRole('alertdialog').querySelector('button.danger')!);
  await waitFor(() => expect(vi.mocked(importExport).mock.calls).toHaveLength(2));
  expect(vi.mocked(importExport).mock.calls[1][0]).toMatchObject({ confirm: true, conflictPolicy: 'error' });
});

it('renders the expanded catalog unchanged and exports only explicitly selected categories', async () => {
  vi.mocked(api).mockResolvedValue(catalog);
  vi.mocked(downloadExport).mockRejectedValue(new Error('fixture download blocked'));
  render(<ExportSettings />);
  await screen.findByRole('checkbox', { name: /Scheduled jobs/ });
  expect(screen.getAllByRole('checkbox')).toHaveLength(8);
  for (const category of catalog.categories) {
    expect(screen.getByText(category.description)).toBeTruthy();
    expect((screen.getByRole('checkbox', { name: new RegExp(category.label) }) as HTMLInputElement).checked).toBe(category.id === 'settings');
  }
  fireEvent.click(screen.getByRole('checkbox', { name: /^Settings/ }));
  fireEvent.click(screen.getByRole('checkbox', { name: /Scheduled jobs/ }));
  fireEvent.click(screen.getByRole('checkbox', { name: /Operator text skills/ }));
  expect(screen.queryByLabelText('Export password (12+ characters)')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Download export' }));
  await waitFor(() => expect(downloadExport).toHaveBeenCalledWith(['scheduled-jobs', 'skills'], undefined));
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'fixture download blocked');
  expect(screen.getByText(/Dependencies are not selected automatically/)).toBeTruthy();
  expect(screen.getByText(/non-secret field redaction does not detect secrets in prose/)).toBeTruthy();
});

it('keeps secret-category password gating and clears the transient password after download', async () => {
  vi.mocked(api).mockResolvedValue(catalog);
  vi.mocked(downloadExport).mockResolvedValue({ blob: new Blob(['fixture']), filename: 'fixture.bin' });
  const createUrl = vi.fn(() => 'blob:fixture');
  const revokeUrl = vi.fn();
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createUrl });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeUrl });
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  try {
    render(<ExportSettings />);
    fireEvent.click(await screen.findByRole('checkbox', { name: /Model connections/ }));
    const button = screen.getByRole('button', { name: 'Download export' });
    const password = screen.getByLabelText('Export password (12+ characters)');
    expect(button).toHaveProperty('disabled', true);
    fireEvent.change(password, { target: { value: 'short' } });
    expect(button).toHaveProperty('disabled', true);
    fireEvent.change(password, { target: { value: 'fixture-only-password' } });
    fireEvent.click(button);
    await waitFor(() => expect(downloadExport).toHaveBeenCalledWith(['settings', 'model-connections'], 'fixture-only-password'));
    await waitFor(() => expect(password).toHaveProperty('value', ''));
    expect(click).toHaveBeenCalledOnce();
    expect(revokeUrl).toHaveBeenCalledWith('blob:fixture');
  } finally { click.mockRestore(); }
});

it('previews and confirms expanded categories with portable-limit and enabled-job warnings', async () => {
  vi.mocked(api).mockResolvedValue(catalog);
  vi.mocked(importExport).mockResolvedValue({ supported: ['agents', 'settings', 'skills', 'scheduled-jobs'], unsupported: [] });
  render(<ExportSettings />);
  await choose();
  expect(screen.getByText('Supported: 4 items')).toBeTruthy();
  expect(screen.getByText(/skill packages are not installed/)).toBeTruthy();
  expect(screen.getByText(/Enabled scheduled jobs remain enabled/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Import export' }));
  fireEvent.click(screen.getByRole('alertdialog').querySelector('button.danger')!);
  await waitFor(() => expect(importExport).toHaveBeenCalledWith({ payload: 'AQI=', confirm: true, conflictPolicy: 'error' }));
});
