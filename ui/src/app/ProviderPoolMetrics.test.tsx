import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProviderPoolMetrics, type ProviderPoolWindow } from './ProviderPoolMetrics';
import { api } from './api';
vi.mock('./api', () => ({ api: vi.fn() }));
const day: ProviderPoolWindow = { requests: 100, successes: 90, failures: 5, cancellations: 5, attempts: 110, retries: 10, inputTokens: 1000, outputTokens: 200, cachedTokens: 500, cachePercent: 50, errorPercent: 5, durationMs: 123, coverage: { inputAttempts: 110, outputAttempts: 110, cachedAttempts: 80, cacheAttempts: 80, cacheInputTokens: 1000 } };
const week = { ...day, requests: 500, inputTokens: null, cachePercent: null, errorPercent: 0 };
const response = { ok: true, windows: { '24h': day, '7d': week } };
afterEach(() => { cleanup(); vi.useRealTimers(); });
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });
describe('ProviderPoolMetrics', () => {
  it('renders combined counts, does not add cache, and switches windows without refetch', async () => {
    vi.mocked(api).mockResolvedValue(response);
    render(<ProviderPoolMetrics />); await flush();
    expect(screen.getByText('1.2K')).toBeTruthy();
    expect(screen.getByText('5%')).toBeTruthy();
    expect(screen.getByTitle(/Partial cache coverage: 80 of 110/)).toBeTruthy();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '7d' } });
    expect(screen.getByText('500')).toBeTruthy();
    expect(screen.getAllByText('—')).toHaveLength(2);
    expect(screen.getByText('0%')).toBeTruthy();
    expect(api).toHaveBeenCalledTimes(1);
  });
  it('shows unknown while loading and on failures, then recovers on the next poll', async () => {
    vi.useFakeTimers(); vi.mocked(api).mockRejectedValueOnce(new Error('offline')).mockResolvedValue(response);
    render(<ProviderPoolMetrics />);
    expect(screen.getAllByText('—')).toHaveLength(4); await flush();
    expect(screen.getByTitle(/unavailable; retrying/)).toBeTruthy();
    await act(async () => { vi.advanceTimersByTime(30_000); }); await flush();
    expect(screen.getByText('100')).toBeTruthy();
  });
  it('treats an unsupported or malformed endpoint response as unavailable', async () => {
    vi.mocked(api).mockResolvedValue({ ok: true });
    render(<ProviderPoolMetrics />); await flush();
    expect(screen.getAllByText('—')).toHaveLength(4);
    expect(screen.getByTitle(/unavailable; retrying/)).toBeTruthy();
  });
  it('does not overlap polls and aborts in-flight work on unmount', async () => {
    vi.useFakeTimers(); let resolve!: (value: unknown) => void;
    vi.mocked(api).mockImplementation(() => new Promise(r => { resolve = r; }));
    const view = render(<ProviderPoolMetrics />); await flush();
    await act(async () => { vi.advanceTimersByTime(30_000); });
    expect(api).toHaveBeenCalledTimes(1);
    const signal = vi.mocked(api).mock.calls[0][1]!.signal!;
    view.unmount(); expect(signal.aborted).toBe(true);
    await act(async () => { resolve(response); });
  });
});
