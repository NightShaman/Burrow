import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { api } from '../../app/api';
import { UnsavedChangesProvider, useUnsavedNavigation } from '../../app/UnsavedChanges';
import { RetentionSettings } from './RetentionSettings';

vi.mock('../../app/api', async original => ({ ...await original<typeof import('../../app/api')>(), api: vi.fn() }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });
function Leave() { const navigate = useUnsavedNavigation(); return <button onClick={() => navigate(() => {})}>Leave</button>; }
async function mount(bytes: number | null) {
  const policy = { enabled: false, traceMaxAgeDays: null, traceMaxBytes: bytes, intervalMinutes: 1440 };
  vi.mocked(api).mockImplementation(async (_path, options) => ({
    policy: options?.method === 'PUT' ? JSON.parse(options.body as string) : policy,
    state: { lastResult: { counts: { deleteTraceBytes: 10240 } } },
    plan: { counts: { deleteTraces: 3, deleteTraceBytes: 1.5 * 1024 ** 3 } },
    counts: { deleteTraces: 3, deleteTraceBytes: 1.5 * 1024 ** 3 },
  }));
  render(<UnsavedChangesProvider><RetentionSettings /><Leave /></UnsavedChangesProvider>);
  await waitFor(() => expect((screen.getByLabelText('Maximum storage') as HTMLInputElement).disabled).toBe(false));
  return { input: screen.getByLabelText('Maximum storage') as HTMLInputElement, unit: screen.getByLabelText('Storage unit') as HTMLSelectElement };
}
async function saveBytes() {
  fireEvent.click(screen.getByRole('button', { name: 'Save policy' }));
  await screen.findByText('Retention policy saved. Preview it before running cleanup.');
  const call = [...vi.mocked(api).mock.calls].reverse().find(([, options]) => options?.method === 'PUT');
  return JSON.parse(call![1]!.body as string).traceMaxBytes;
}

it.each([10240, 1073741825, 1234567890123])('preserves exact legacy bytes %s across toggles and unrelated save', async bytes => {
  const { input, unit } = await mount(bytes);
  expect(Number(input.value) * (unit.value === 'GiB' ? 1024 ** 3 : 1024 ** 2)).toBe(bytes);
  for (const value of ['GiB', 'MiB', 'GiB']) fireEvent.change(unit, { target: { value } });
  fireEvent.click(screen.getByText('Leave'));
  expect(screen.queryByText('Unsaved changes')).toBeNull();
  fireEvent.change(screen.getByLabelText('Run every (minutes)'), { target: { value: '60' } });
  expect(await saveBytes()).toBe(bytes);
});

it.each([['MiB', '1.5', 1572864], ['GiB', '2.25', 2415919104]])('converts an edited %s value to bytes', async (unitName, value, bytes) => {
  const { input, unit } = await mount(10240);
  fireEvent.change(unit, { target: { value: unitName } });
  fireEvent.change(input, { target: { value } });
  fireEvent.change(unit, { target: { value: unitName === 'MiB' ? 'GiB' : 'MiB' } });
  expect(await saveBytes()).toBe(bytes);
});

it('loads small legacy limits without rounding and discards edits', async () => {
  const { input } = await mount(10240);
  expect(input.value).toBe('0.009765625');
  fireEvent.change(input, { target: { value: '2' } });
  fireEvent.click(screen.getByText('Leave'));
  fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
  expect(input.value).toBe('0.009765625');
  expect(await saveBytes()).toBe(10240);
});

it('keeps empty limits empty on toggles and clears a limit explicitly', async () => {
  const { input, unit } = await mount(null);
  fireEvent.change(unit, { target: { value: 'GiB' } });
  expect(input.value).toBe('');
  fireEvent.change(input, { target: { value: '1' } });
  fireEvent.change(input, { target: { value: '' } });
  expect(await saveBytes()).toBeNull();
});

it('renders cleanup sizes in binary human-readable units including preview notice', async () => {
  await mount(10240);
  expect(screen.getByText('10.0 KiB')).toBeTruthy();
  expect(screen.getByText(/1.5 GiB/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Preview cleanup' }));
  expect(await screen.findByText('Preview: 3 traces, 1.5 GiB reclaimable.')).toBeTruthy();
});

it.each(['0', '-1', '0.00000001', '99999999999999'])('rejects unsupported storage value %s before saving', async value => {
  const { input } = await mount(null);
  fireEvent.change(input, { target: { value } });
  fireEvent.click(screen.getByRole('button', { name: 'Save policy' }));
  expect(vi.mocked(api).mock.calls.filter(([, options]) => options?.method === 'PUT')).toHaveLength(0);
  expect(screen.getAllByText('Storage limit must be at least 1 byte and within the supported range.').length).toBeGreaterThan(0);
});
