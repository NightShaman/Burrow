import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { api } from '../../app/api';
import { UnsavedChangesProvider, useUnsavedNavigation } from '../../app/UnsavedChanges';
import { RetentionSettings } from './RetentionSettings';

vi.mock('../../app/api', async original => ({ ...await original<typeof import('../../app/api')>(), api: vi.fn() }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });
const leave = vi.fn();
function Leave() { const navigate = useUnsavedNavigation(); return <button onClick={() => navigate(leave)}>Leave</button>; }
const counts = { deleteTraces: 3, deleteTraceBytes: 1.5 * 1024 ** 3 };
const initialPolicy = (bytes: number | null = 10240, enabled = false) => ({ version: 1, enabled, traceMaxAgeDays: null, traceMaxBytes: bytes, intervalMinutes: 1440 });
const response = (policy = initialPolicy()) => ({
  ok: true,
  policy,
  state: { lastResult: { counts: { deleteTraceBytes: 10240 } } },
  plan: { ok: true, dryRun: true, retention: {}, counts },
});
const cleanupResponse = (policy = initialPolicy(10240, true), dryRun = true) => ({ ok: true, policy, state: {}, dryRun, retention: {}, counts });
function renderSettings() { return render(<UnsavedChangesProvider><RetentionSettings /><Leave /></UnsavedChangesProvider>); }
async function mount(bytes: number | null, enabled = false) {
  let policy = initialPolicy(bytes, enabled);
  vi.mocked(api).mockImplementation(async (path, options) => {
    if (options?.method === 'PUT') {
      policy = JSON.parse(options.body as string);
      return { ok: true, policy, state: {} }; // Actual PUT does not return a plan.
    }
    if (path.endsWith('/preview') || path.endsWith('/run')) return cleanupResponse(policy, path.endsWith('/preview'));
    return response(policy);
  });
  renderSettings();
  await waitFor(() => expect((screen.getByLabelText('Maximum storage') as HTMLInputElement).disabled).toBe(false));
  return { input: screen.getByLabelText('Maximum storage') as HTMLInputElement, unit: screen.getByLabelText('Storage unit') as HTMLSelectElement };
}
async function saveBytes() {
  if ((screen.getByRole('button', { name: 'Apply policy' }) as HTMLButtonElement).disabled) fireEvent.change(screen.getByLabelText('Run every (minutes)'), { target: { value: '60' } });
  fireEvent.click(screen.getByRole('button', { name: 'Apply policy' }));
  await screen.findByText('Retention policy applied. Managed trace cleanup is disabled.');
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
  fireEvent.click(screen.getByRole('button', { name: 'Apply policy' }));
  expect(vi.mocked(api).mock.calls.filter(([, options]) => options?.method === 'PUT')).toHaveLength(0);
  expect(screen.getAllByText('Storage limit must be at least 1 byte and within the supported range.').length).toBeGreaterThan(0);
});

const writes = () => vi.mocked(api).mock.calls.filter(([, options]) => options?.method === 'PUT');

it('keeps enabled edits local until explicit Apply without adding a destructive confirmation', async () => {
  await mount(10240);
  fireEvent.click(screen.getByRole('checkbox', { name: /Enable managed cleanup/ }));
  fireEvent.blur(screen.getByLabelText('Maximum storage'));
  expect(writes()).toHaveLength(0);
  expect(screen.getByText('Disabled')).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Preview cleanup' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Apply policy' }));
  await screen.findByText('Retention policy applied. Scheduled deletion is active; preview is not required for automatic cleanup.');
  expect(screen.queryByRole('alertdialog')).toBeNull();
  expect(writes()).toHaveLength(1);
  expect(JSON.parse(writes()[0][1]!.body as string).enabled).toBe(true);
  expect(screen.getByText('Next scheduler check')).toBeTruthy();
  fireEvent.click(screen.getByText('Leave'));
  expect(leave).toHaveBeenCalledOnce();
});

it('failed guarded Save preserves the enabled draft and applied schedule', async () => {
  await mount(10240);
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(screen.getByText('Leave'));
  vi.mocked(api).mockRejectedValueOnce(new Error('offline'));
  fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
  await screen.findByText('Could not apply retention policy: offline');
  expect(leave).not.toHaveBeenCalled();
  expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(true);
  expect(screen.getByText('Disabled')).toBeTruthy();
  fireEvent.click(screen.getByText('Leave'));
  fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
  expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
  expect(leave).toHaveBeenCalledOnce();
});

it('shows the applied enabled schedule while disabling is still a draft, then explicitly applies without destructive confirmation', async () => {
  await mount(10240, true);
  fireEvent.click(screen.getByRole('checkbox'));
  expect(screen.getByText('Next scheduler check')).toBeTruthy();
  expect(writes()).toHaveLength(0);
  fireEvent.click(screen.getByRole('button', { name: 'Apply policy' }));
  await screen.findByText('Retention policy applied. Managed trace cleanup is disabled.');
  expect(screen.queryByRole('alertdialog')).toBeNull();
  expect(writes()).toHaveLength(1);
  expect(screen.getByText('Disabled')).toBeTruthy();
});

it('requires preview and explicit Run; edits invalidate even a reverted preview', async () => {
  await mount(10240, true);
  const run = screen.getByRole('button', { name: 'Run now' }) as HTMLButtonElement;
  expect(run.disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Preview cleanup' }));
  await screen.findByText('Preview: 3 traces, 1.5 GiB reclaimable.');
  expect(run.disabled).toBe(false);
  expect(vi.mocked(api).mock.calls.filter(([path]) => path.endsWith('/run'))).toHaveLength(0);
  fireEvent.change(screen.getByLabelText('Run every (minutes)'), { target: { value: '60' } });
  fireEvent.change(screen.getByLabelText('Run every (minutes)'), { target: { value: '1440' } });
  expect(run.disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Preview cleanup' }));
  await screen.findByText('Preview: 3 traces, 1.5 GiB reclaimable.');
  fireEvent.click(run);
  await screen.findByText('Cleanup complete: 3 traces removed, 1.5 GiB reclaimed.');
  expect(vi.mocked(api).mock.calls.filter(([path]) => path.endsWith('/run'))).toHaveLength(1);
  expect(run.disabled).toBe(true); // One preview cannot authorize repeated runs.
});

it.each(['', '14', '15.5', '10081'])('rejects invalid cadence %s before PUT', async value => {
  await mount(10240);
  fireEvent.change(screen.getByLabelText('Run every (minutes)'), { target: { value } });
  fireEvent.click(screen.getByRole('button', { name: 'Apply policy' }));
  expect(writes()).toHaveLength(0);
  expect(screen.getAllByText('Cadence must be a whole number between 15 minutes and 7 days.').length).toBeGreaterThan(0);
});

it.each(['0', '1.5', '36501'])('rejects invalid maximum age %s before PUT', async value => {
  await mount(10240);
  fireEvent.change(screen.getByLabelText('Maximum age (days)'), { target: { value } });
  fireEvent.click(screen.getByRole('button', { name: 'Apply policy' }));
  expect(writes()).toHaveLength(0);
  expect(screen.getAllByText('Maximum age must be a whole number between 1 and 36500 days.').length).toBeGreaterThan(0);
});

it('changing limits on an enabled policy still requires explicit Apply, not confirmation', async () => {
  const { input } = await mount(10240, true);
  fireEvent.change(input, { target: { value: '1' } });
  expect(writes()).toHaveLength(0);
  fireEvent.click(screen.getByRole('button', { name: 'Apply policy' }));
  await screen.findByText('Retention policy applied. Scheduled deletion is active; preview is not required for automatic cleanup.');
  expect(writes()).toHaveLength(1);
  expect(screen.queryByRole('alertdialog')).toBeNull();
});

it('locks controls and navigation while Apply is in flight and accepts only one write', async () => {
  const { input } = await mount(10240);
  fireEvent.change(input, { target: { value: '1' } });
  const policy = { version: 1, enabled: false, traceMaxAgeDays: null, traceMaxBytes: 1048576, intervalMinutes: 1440 };
  let resolve!: (result: unknown) => void;
  vi.mocked(api).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  fireEvent.click(screen.getByRole('button', { name: 'Apply policy' }));
  const applying = screen.getByRole('button', { name: 'Applying…' }) as HTMLButtonElement;
  expect(input.disabled).toBe(true);
  expect(applying.disabled).toBe(true);
  fireEvent.click(applying);
  fireEvent.click(screen.getByText('Leave'));
  expect(leave).not.toHaveBeenCalled();
  expect(writes()).toHaveLength(1);
  resolve({ ok: true, policy, state: {} });
  await screen.findByText('Retention policy applied. Managed trace cleanup is disabled.');
  expect(input.disabled).toBe(false);
  expect(screen.getByText('Preview to estimate')).toBeTruthy();
});

it('ignores an Apply completion after unmount', async () => {
  const { input } = await mount(10240);
  fireEvent.change(input, { target: { value: '1' } });
  let resolve!: (value: unknown) => void;
  vi.mocked(api).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  fireEvent.click(screen.getByRole('button', { name: 'Apply policy' }));
  cleanup();
  resolve({ ok: true, policy: initialPolicy(1048576), state: {} });
  await Promise.resolve();
  expect(writes()).toHaveLength(1);
});

it('a failed preview invalidates previous permission to run', async () => {
  await mount(10240, true);
  fireEvent.click(screen.getByRole('button', { name: 'Preview cleanup' }));
  await screen.findByText('Preview: 3 traces, 1.5 GiB reclaimable.');
  vi.mocked(api).mockRejectedValueOnce(new Error('offline'));
  fireEvent.click(screen.getByRole('button', { name: 'Preview cleanup' }));
  await screen.findByText('Could not preview retention cleanup: offline');
  expect((screen.getByRole('button', { name: 'Run now' }) as HTMLButtonElement).disabled).toBe(true);
});

const malformedPolicyAcks: [string, unknown][] = [
  ['null', null],
  ['empty', {}],
  ['false success', { ...response(), ok: false }],
  ['missing policy', { ok: true, state: {} }],
  ['partial policy', { ...response(), policy: { enabled: false } }],
  ['coerced boolean', { ...response(), policy: { ...initialPolicy(), enabled: 'false' } }],
  ['missing nullable limit', { ...response(), policy: { ...initialPolicy(), traceMaxBytes: undefined } }],
  ['unsupported version', { ...response(), policy: { ...initialPolicy(), version: 2 } }],
  ['invalid cadence', { ...response(), policy: { ...initialPolicy(), intervalMinutes: 0 } }],
  ['invalid age', { ...response(), policy: { ...initialPolicy(), traceMaxAgeDays: 1.5 } }],
  ['unsafe bytes', { ...response(), policy: { ...initialPolicy(), traceMaxBytes: Number.MAX_SAFE_INTEGER + 1 } }],
  ['missing state', { ...response(), state: undefined }],
  ['malformed state', { ...response(), state: [] }],
];

it.each(malformedPolicyAcks)('keeps malformed GET %s locked until a valid retry', async (_label, ack) => {
  vi.mocked(api).mockResolvedValueOnce(ack).mockResolvedValueOnce(response());
  renderSettings();
  await screen.findByText(/Could not load retention settings: Invalid retention response/);
  expect((screen.getByLabelText('Maximum storage') as HTMLInputElement).disabled).toBe(true);
  expect((screen.getByRole('button', { name: 'Apply policy' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await waitFor(() => expect((screen.getByLabelText('Maximum storage') as HTMLInputElement).disabled).toBe(false));
  expect((screen.getByLabelText('Maximum storage') as HTMLInputElement).value).toBe('0.009765625');
});

it.each(malformedPolicyAcks)('malformed PUT %s preserves draft, baseline and guarded navigation', async (_label, ack) => {
  const { input } = await mount(10240);
  fireEvent.change(input, { target: { value: '2' } });
  vi.mocked(api).mockResolvedValueOnce(ack);
  fireEvent.click(screen.getByText('Leave'));
  fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
  await screen.findByText(/Could not apply retention policy: Invalid retention response/);
  expect(input.value).toBe('2');
  expect(leave).not.toHaveBeenCalled();
  expect(screen.queryByText(/Retention policy applied\./)).toBeNull();
  expect((screen.getByRole('button', { name: 'Preview cleanup' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByText('Leave'));
  fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
  expect(input.value).toBe('0.009765625');
  expect(leave).toHaveBeenCalledOnce();
});

const malformedCleanupAcks: [string, unknown][] = [
  ['empty', {}],
  ['false success', { ...cleanupResponse(), ok: false }],
  ['missing counts', { ...cleanupResponse(), counts: undefined }],
  ['missing byte count', { ...cleanupResponse(), counts: { deleteTraces: 0 } }],
  ['negative count', { ...cleanupResponse(), counts: { ...counts, deleteTraces: -1 } }],
  ['string count', { ...cleanupResponse(), counts: { ...counts, deleteTraceBytes: '0' } }],
  ['missing dryRun', { ...cleanupResponse(), dryRun: undefined }],
  ['missing retention', { ...cleanupResponse(), retention: undefined }],
  ['different policy', { ...cleanupResponse(), policy: initialPolicy(20480, true) }],
];

it.each(malformedCleanupAcks)('malformed preview %s cannot authorize Run or report zero success', async (_label, ack) => {
  await mount(10240, true);
  fireEvent.click(screen.getByRole('button', { name: 'Preview cleanup' }));
  await screen.findByText('Preview: 3 traces, 1.5 GiB reclaimable.');
  vi.mocked(api).mockResolvedValueOnce(ack);
  fireEvent.click(screen.getByRole('button', { name: 'Preview cleanup' }));
  await screen.findByText(/Could not preview retention cleanup: Invalid/);
  expect(screen.queryByText(/^Preview:/)).toBeNull();
  expect((screen.getByRole('button', { name: 'Run now' }) as HTMLButtonElement).disabled).toBe(true);
  expect(vi.mocked(api).mock.calls.filter(([path]) => path.endsWith('/run'))).toHaveLength(0);
});

it.each([...malformedCleanupAcks, ['wrong dryRun', cleanupResponse()] as [string, unknown]])('malformed run %s reports failure and consumes preview authorization', async (_label, ack) => {
  await mount(10240, true);
  fireEvent.click(screen.getByRole('button', { name: 'Preview cleanup' }));
  await screen.findByText('Preview: 3 traces, 1.5 GiB reclaimable.');
  vi.mocked(api).mockResolvedValueOnce(ack);
  fireEvent.click(screen.getByRole('button', { name: 'Run now' }));
  await screen.findByText(/Could not run retention cleanup: Invalid/);
  expect(screen.queryByText(/^Cleanup complete:/)).toBeNull();
  expect((screen.getByRole('button', { name: 'Run now' }) as HTMLButtonElement).disabled).toBe(true);
});

it('accepts real zero-count cleanup responses and requires the endpoint dryRun mode', async () => {
  await mount(10240, true);
  vi.mocked(api).mockResolvedValueOnce({ ...cleanupResponse(), dryRun: false });
  fireEvent.click(screen.getByRole('button', { name: 'Preview cleanup' }));
  await screen.findByText(/Could not preview retention cleanup: Invalid cleanup response/);
  const zero = { deleteTraces: 0, deleteTraceBytes: 0 };
  vi.mocked(api).mockResolvedValueOnce({ ...cleanupResponse(), counts: zero });
  fireEvent.click(screen.getByRole('button', { name: 'Preview cleanup' }));
  await screen.findByText('Preview: 0 traces, 0 B reclaimable.');
  vi.mocked(api).mockResolvedValueOnce({ ...cleanupResponse(initialPolicy(10240, true), false), counts: zero });
  fireEvent.click(screen.getByRole('button', { name: 'Run now' }));
  await screen.findByText('Cleanup complete: 0 traces removed, 0 B reclaimed.');
  expect(JSON.parse(vi.mocked(api).mock.calls.at(-1)![1]!.body as string)).toEqual({ policy: initialPolicy(10240, true) });
});

it.each([undefined, {}, { ...response().plan, counts: {} }])('rejects a missing or malformed GET plan', async plan => {
  vi.mocked(api).mockResolvedValueOnce({ ...response(), plan });
  renderSettings();
  await screen.findByText(/Could not load retention settings: Invalid retention response/);
  expect((screen.getByRole('button', { name: 'Preview cleanup' }) as HTMLButtonElement).disabled).toBe(true);
});
