import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createArchiveRepository } from './archiveRepository';
import { DreamArchiveShelf } from './DreamArchiveShelf';
import type { DreamArchiveGroup, DreamGroupSummary, DreamPhaseAttempt } from './archiveTypes';

afterEach(cleanup);
const summary = (): DreamGroupSummary => ({
  agentId: 'a', agentName: 'Agent', day: '2026-10-25', timezone: 'UTC', createdAt: '2026-10-25T10:00:00Z',
  phases: {
    light: { phase: 'light', diaryCount: 2, attemptCount: 2, latestStatus: 'failed', latestError: 'Retry failed', latestDiary: { id: 'd2', entryDate: '2026-10-24', createdAt: '2026-10-25T10:00:00Z', excerpt: 'Second diary' } },
    deep: { phase: 'deep', diaryCount: 0, attemptCount: 1, latestStatus: 'failed', latestError: 'Extraction failed', latestDiary: null },
    rem: { phase: 'rem', diaryCount: 0, attemptCount: 0, latestStatus: null, latestError: null, latestDiary: null },
  },
  otherDiaries: { diaryCount: 1, latestDiary: null },
  cycleAttempts: { count: 1, latestStatus: 'interrupted', latestError: 'Cycle interrupted' },
});
const attempt = (changes: Partial<DreamPhaseAttempt> = {}): DreamPhaseAttempt => ({
  runId: 'retry', status: 'failed', error: 'Retry failed', errors: { diary: 'Retry failed' },
  startedAt: null, completedAt: null, runStartedAt: '2026-10-25T10:00:00Z', runCompletedAt: '2026-10-25T10:01:00Z', diaryId: null, ...changes,
});
const detail = (): DreamArchiveGroup => ({
  ...summary(),
  phases: {
    light: { phase: 'light', diaries: [
      { id: 'd2', phase: 'light', createdAt: '2026-10-25T10:00:00Z', entryDate: '2026-10-24', markdown: 'Second full diary' },
      { id: 'd1', phase: 'light', createdAt: '2026-10-25T09:00:00Z', entryDate: null, markdown: 'Earlier full diary' },
    ], attempts: [attempt(), attempt({ runId: 'success', status: 'completed', error: null, errors: {}, diaryId: 'd1' })] },
    deep: { phase: 'deep', diaries: [], attempts: [attempt({ runId: 'deep-failure', error: 'Extraction failed', errors: { extraction: 'Extraction failed' } })] },
    rem: { phase: 'rem', diaries: [], attempts: [] },
  },
  otherDiaries: [{ id: 'other', phase: 'legacy', createdAt: null, entryDate: null, markdown: 'Other full diary' }],
  cycleAttempts: [{ runId: 'interrupted', status: 'interrupted', error: 'Cycle interrupted', startedAt: '2026-10-25T10:00:00Z', completedAt: null }],
});
const page = (items = [summary()], nextCursor: string | null = null) => ({ items, nextCursor, hasMore: !!nextCursor });
function setup(search = '') {
  const repository = createArchiveRepository();
  const list = vi.spyOn(repository, 'listDreams').mockResolvedValue(page());
  const load = vi.spyOn(repository, 'loadDreamGroup').mockResolvedValue(detail());
  const props = { archiveRepository: repository, selectedAgent: '', selectedDate: '', search, queryKey: search, onCount: vi.fn() };
  return { repository, list, load, props };
}
async function selectGroup() { fireEvent.click(await screen.findByRole('button', { name: /Agent Dreams/ })); }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }

describe('Dreams Archive groups', () => {
  it('keeps the day list calm: one short record summary, no phase errors, run IDs or timing', async () => {
    const { props } = setup();
    render(<DreamArchiveShelf {...props} />);
    const day = await screen.findByRole('button', { name: /Agent Dreams 10-25-2026/ });
    expect(within(day).getByText('3 retained diaries · Light, Deep, Other diaries, Cycle records')).toBeTruthy();
    expect(day.querySelectorAll('p')).toHaveLength(1);
    for (const diagnostic of ['Retry failed', 'Extraction failed', 'Cycle interrupted', 'failed', 'UTC', 'Not recorded']) {
      expect(day.textContent).not.toContain(diagnostic);
    }
    expect(day.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(day);
    await screen.findByText('Second full diary');
    expect(day.getAttribute('aria-pressed')).toBe('true');
  });

  it('puts narratives and inline failures ahead of collapsed provenance, with distinct attempt records', async () => {
    const { props } = setup();
    render(<DreamArchiveShelf {...props} />);
    await selectGroup();
    const light = await screen.findByRole('region', { name: 'light evidence' });
    expect(within(light).queryByText('2 retained diaries · 2 recorded attempts')).toBeNull();
    expect(within(light).getByText('Recorded statuses: 1 failed')).toBeTruthy();
    // jsdom's role queries include closed-details descendants: assert the
    // native disclosure boundary rather than treating them as absent DOM.
    for (const heading of within(light).getAllByRole('heading', { name: /Recorded attempt/ })) {
      expect(heading.closest('details')?.open).toBe(false);
      expect(heading.closest('details')?.classList.contains('dream-phase-attempt-details')).toBe(true);
    }
    const attemptDetails = light.querySelectorAll('.dream-phase-attempt-details');
    expect(attemptDetails).toHaveLength(1);
    const disclosure = attemptDetails[0] as HTMLDetailsElement;
    expect(disclosure.open).toBe(false);
    expect(disclosure.querySelectorAll('details')).toHaveLength(0);
    expect(disclosure.querySelectorAll('.dream-attempt')).toHaveLength(2);
    fireEvent.click(within(disclosure).getByText('Attempt details (2)'));
    expect(disclosure.open).toBe(true);
    expect(within(disclosure).getByRole('heading', { name: 'Recorded attempt 1 · failed' })).toBeTruthy();
    expect(within(disclosure).getByRole('heading', { name: 'Recorded attempt 2 · completed' })).toBeTruthy();
    fireEvent.click(within(disclosure).getByText('Attempt details (2)'));
    const narrative = within(light).getByText('Second full diary');
    const failure = within(light).getByText('Attempt 1 · diary: Retry failed');
    expect(narrative.closest('details')).toBeNull();
    expect(failure.closest('details')).toBeNull();
    expect(narrative.compareDocumentPosition(failure) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    for (const region of [light, screen.getByRole('region', { name: 'deep evidence' }), screen.getByRole('region', { name: 'Unattributed cycle attempts' })]) {
      for (const details of region.querySelectorAll('details')) expect(details.open).toBe(false);
    }
    for (const text of ['Run: retry', 'Recorded diary ID: d1', 'Diary: d2']) {
      expect(within(light).getByText(text).closest('details')).toBeTruthy();
    }
    for (const timing of within(light).getAllByText('Phase started: Not recorded · Phase completed: Not recorded')) {
      expect(timing.closest('details')?.open).toBe(false);
    }
    const provenance = within(light).getByText('Diary: d2').closest('details')!;
    fireEvent.click(within(provenance).getByText('Diary 1 provenance'));
    expect(provenance.open).toBe(true);
    expect(within(provenance).getByText('Created: ' + new Date('2026-10-25T10:00:00Z').toLocaleString() + ' · Entry date: 2026-10-24')).toBeTruthy();
  });

  it('keeps routine successful attempts quiet while retaining their details and the copy action', async () => {
    const { props, load } = setup();
    const group = detail();
    group.phases.light.diaries = [group.phases.light.diaries[0]];
    group.phases.light.attempts = [attempt({ status: 'completed', error: null, errors: {}, diaryId: 'd2' })];
    load.mockResolvedValue(group);
    render(<DreamArchiveShelf {...props} />);
    await selectGroup();
    const light = await screen.findByRole('region', { name: 'light evidence' });
    expect(light.querySelector('.dream-phase-status')).toBeNull();
    expect(light.querySelector('.dream-phase-heading')?.textContent).toBe('Light');
    expect(within(light).getByText('Second full diary').closest('details')).toBeNull();
    const details = light.querySelector('.dream-phase-attempt-details') as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(within(details).getByRole('heading', { name: 'Recorded attempt 1 · completed' })).toBeTruthy();
    expect(light.querySelector('.dream-archive-entry-actions button')).toBeTruthy();
  });

  it('keeps complete search groups, duplicate phase diaries, retry evidence, other diaries and unattributed cycles', async () => {
    const { props, list, load } = setup('only deep matches');
    const { container } = render(<DreamArchiveShelf {...props} />);
    await selectGroup();
    expect(list).toHaveBeenCalledWith(expect.any(AbortSignal), null, undefined, undefined, 'only deep matches');
    expect(load).toHaveBeenCalledWith(summary(), expect.any(AbortSignal));
    await screen.findByText('Earlier full diary');
    expect(screen.getByText('Second full diary')).toBeTruthy();
    expect(screen.getByText('Other full diary')).toBeTruthy();
    const light = screen.getByRole('region', { name: 'light evidence' });
    // A phase is the card, not a stack of diary cards plus an activity card.
    expect(light.classList.contains('dream-phase-card')).toBe(true);
    expect(light.classList.contains('dream-archive-entry')).toBe(true);
    expect(light.querySelectorAll('.dream-archive-entry')).toHaveLength(0);
    expect(light.querySelectorAll('.dream-diary')).toHaveLength(2);
    expect(light.querySelectorAll('.dream-attempt')).toHaveLength(2);
    for (const text of ['Earlier full diary', 'Second full diary', 'Attempt 1 · diary: Retry failed']) {
      expect(within(light).getByText(text, { exact: true }).closest('.dream-archive-entry')).toBe(light);
    }
    expect(within(light).queryByRole('heading', { name: 'light attempts' })).toBeNull();
    expect(within(light).getByText('Recorded diary ID: d1')).toBeTruthy();
    expect(within(light).getByText('No diary ID recorded for this attempt.')).toBeTruthy();
    expect(within(light).getAllByText('Phase started: Not recorded · Phase completed: Not recorded')).toHaveLength(2);
    expect(within(light).getAllByText(/Run started:/)).toHaveLength(2);
    const deep = screen.getByRole('region', { name: 'deep evidence' });
    expect(deep.classList.contains('dream-phase-card')).toBe(true);
    expect(within(deep).getByText('Attempt 1 · extraction: Extraction failed').closest('.dream-archive-entry')).toBe(deep);
    expect(deep.querySelectorAll('.dream-diary, .dream-archive-entry')).toHaveLength(0);
    expect(deep.querySelectorAll('.dream-archive-entry-actions')).toHaveLength(0);
    expect(screen.queryByRole('region', { name: 'rem evidence' })).toBeNull();
    expect(container.querySelectorAll('.dream-phase-card')).toHaveLength(2);
    expect(screen.getByRole('region', { name: 'Unattributed cycle attempts' })).toBeTruthy();
    expect(container.querySelectorAll('.dream-archive-entry-actions')).toHaveLength(3);
  });

  it('keeps REM success and a recorded failure inside its single phase card, and diary-only phases have no invented results', async () => {
    const { props, load } = setup();
    const group = detail();
    group.phases.light.attempts = [];
    group.phases.rem = { phase: 'rem', diaries: [
      { id: 'rem-success', phase: 'rem', createdAt: null, entryDate: null, markdown: 'Retained REM success' },
    ], attempts: [
      attempt({ runId: 'rem-retry', error: 'REM retry failed', errors: { diary: 'REM retry failed' } }),
      attempt({ runId: 'rem-first', status: 'completed', error: null, errors: {}, diaryId: 'rem-success' }),
    ] };
    load.mockResolvedValue(group);
    const { container } = render(<DreamArchiveShelf {...props} />);
    await selectGroup();
    const rem = await screen.findByRole('region', { name: 'rem evidence' });
    expect(within(rem).getByRole('heading', { name: 'REM' })).toBeTruthy();
    for (const text of ['Retained REM success', 'Attempt 1 · diary: REM retry failed']) {
      expect(within(rem).getByText(text, { exact: true }).closest('.dream-archive-entry')).toBe(rem);
    }
    expect(rem.querySelectorAll('.dream-diary')).toHaveLength(1);
    expect(rem.querySelectorAll('.dream-archive-entry')).toHaveLength(0);
    const light = screen.getByRole('region', { name: 'light evidence' });
    expect(light.querySelectorAll('.dream-diary')).toHaveLength(2);
    expect(light.querySelectorAll('.dream-attempt')).toHaveLength(0);
    expect(light.querySelectorAll('.dream-phase-status, .dream-phase-attempt-details')).toHaveLength(0);
    expect(container.querySelectorAll('.dream-phase-card')).toHaveLength(3);
  });

  it('renders receipt-only evidence without fake phase diaries or inferred phase failure', async () => {
    const { props, load } = setup();
    const group = detail();
    group.phases.light = { phase: 'light', diaries: [], attempts: [] };
    group.phases.deep = { phase: 'deep', diaries: [], attempts: [] };
    group.otherDiaries = [];
    load.mockResolvedValue(group);
    const { container } = render(<DreamArchiveShelf {...props} />);
    await selectGroup();
    await screen.findByRole('region', { name: 'Unattributed cycle attempts' });
    expect(container.querySelectorAll('.dream-archive-entry-actions')).toHaveLength(0);
    expect(screen.queryByRole('region', { name: 'light evidence' })).toBeNull();
    expect((screen.getByRole('button', { name: 'Copy dreams as Markdown' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it.each(['running', 'partial', 'unknown'])('preserves recorded %s status without inventing a diary or phase timing', async status => {
    const { props, load } = setup();
    const group = detail();
    group.phases.light = { phase: 'light', diaries: [], attempts: [attempt({ status, error: null, errors: {} })] };
    load.mockResolvedValue(group);
    render(<DreamArchiveShelf {...props} />);
    await selectGroup();
    const light = await screen.findByRole('region', { name: 'light evidence' });
    expect(within(light).getByText(`Recorded statuses: 1 ${status}`)).toBeTruthy();
    // jsdom's role queries include closed-details descendants: assert the
    // native disclosure boundary rather than treating them as absent DOM.
    for (const heading of within(light).getAllByRole('heading', { name: /Recorded attempt/ })) {
      expect(heading.closest('details')?.open).toBe(false);
      expect(heading.closest('details')?.classList.contains('dream-phase-attempt-details')).toBe(true);
    }
    const disclosure = light.querySelector('.dream-phase-attempt-details') as HTMLDetailsElement;
    expect(disclosure.open).toBe(false);
    fireEvent.click(within(disclosure).getByText('Attempt details (1)'));
    expect(within(disclosure).getByRole('heading', { name: `Recorded attempt 1 · ${status}` })).toBeTruthy();
    expect(within(light).getByText('Phase started: Not recorded · Phase completed: Not recorded')).toBeTruthy();
    expect(light.querySelectorAll('.dream-archive-entry-actions')).toHaveLength(0);
  });

  it('summarizes all mixed statuses without choosing a latest result, keeping every failure and provenance', async () => {
    const { props, load } = setup();
    const group = detail();
    const records = [
      attempt({ runId: 'same-run', status: 'completed', error: null, errors: {}, diaryId: 'd2', startedAt: '2026-10-25T12:00:00Z', completedAt: '2026-10-25T12:01:00Z' }),
      attempt({ runId: 'same-run', status: 'unknown', error: 'General failure', errors: { extraction: 'Extraction error', diary: 'Diary error' }, runStartedAt: null, runCompletedAt: null }),
      attempt({ status: 'running', error: null, errors: {} }),
      attempt({ status: 'partial', error: 'Shared error', errors: { extraction: 'Shared error', diary: 'Shared error' } }),
      attempt({ status: 'failed', error: 'General failure', errors: {} }),
      attempt({ status: 'completed', error: null, errors: {} }),
    ];
    group.phases.light.attempts = records;
    load.mockResolvedValue(group);
    render(<DreamArchiveShelf {...props} />);
    await selectGroup();
    const light = await screen.findByRole('region', { name: 'light evidence' });
    const status = within(light).getByText('Recorded statuses: 1 failed · 1 partial · 1 running · 1 unknown');
    expect(status.closest('details')).toBeNull();
    expect(light.querySelectorAll('.dream-phase-status')).toHaveLength(1);
    // jsdom's role queries include closed-details descendants: assert the
    // native disclosure boundary rather than treating them as absent DOM.
    for (const heading of within(light).getAllByRole('heading', { name: /Recorded attempt/ })) {
      expect(heading.closest('details')?.open).toBe(false);
      expect(heading.closest('details')?.classList.contains('dream-phase-attempt-details')).toBe(true);
    }
    const failures = light.querySelector('.dream-attempt-errors')!;
    expect(failures.closest('details')).toBeNull();
    expect([...failures.querySelectorAll('p')].map(node => node.textContent)).toEqual([
      'Attempt 2 · extraction: Extraction error', 'Attempt 2 · diary: Diary error', 'Attempt 2 · General failure',
      'Attempt 4 · extraction: Shared error', 'Attempt 4 · diary: Shared error', 'Attempt 5 · General failure',
    ]);
    expect(within(light).getByText('Second full diary').closest('details')).toBeNull();
    const disclosures = light.querySelectorAll('.dream-phase-attempt-details');
    expect(disclosures).toHaveLength(1);
    const disclosure = disclosures[0] as HTMLDetailsElement;
    expect(disclosure.open).toBe(false);
    expect(disclosure.querySelectorAll('details')).toHaveLength(0);
    fireEvent.click(within(disclosure).getByText('Attempt details (6)'));
    const attempts = disclosure.querySelectorAll('.dream-attempt');
    expect(attempts).toHaveLength(records.length);
    records.forEach((record, index) => {
      const retained = within(attempts[index] as HTMLElement);
      expect(retained.getByRole('heading', { name: `Recorded attempt ${index + 1} · ${record.status}` })).toBeTruthy();
      expect(retained.getByText(`Run: ${record.runId}`)).toBeTruthy();
      const time = (value: string | null) => value ? new Date(value).toLocaleString() : 'Not recorded';
      expect(retained.getByText(`Phase started: ${time(record.startedAt)} · Phase completed: ${time(record.completedAt)}`)).toBeTruthy();
      expect(retained.getByText(`Run started: ${time(record.runStartedAt)} · Run completed: ${time(record.runCompletedAt)}`)).toBeTruthy();
      expect(retained.getByText(record.diaryId ? `Recorded diary ID: ${record.diaryId}` : 'No diary ID recorded for this attempt.')).toBeTruthy();
      for (const [stage, error] of Object.entries(record.errors)) expect(retained.getByText(`${stage}: ${error}`)).toBeTruthy();
      if (record.error && !Object.values(record.errors).includes(record.error)) expect(retained.getByText(record.error)).toBeTruthy();
    });
    expect(light.textContent).not.toMatch(/latest|earliest|first attempt|last attempt/i);
  });

  it('shows truthful list failure and retry, then detail failure and independent retry', async () => {
    const { props, list, load } = setup();
    list.mockRejectedValueOnce(new Error('List unavailable'));
    load.mockRejectedValueOnce(new Error('Detail unavailable'));
    render(<DreamArchiveShelf {...props} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Retry dreams' }));
    await selectGroup();
    const retry = await screen.findByRole('button', { name: 'Retry dream details' });
    expect(screen.queryByText('Second full diary')).toBeNull();
    fireEvent.click(retry);
    await screen.findByText('Second full diary');
    expect(load).toHaveBeenCalledTimes(2);
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('preserves existing groups on page failure and retries the same cursor without splitting or duplicating groups', async () => {
    const { props, list } = setup();
    list.mockResolvedValueOnce(page([summary()], 'next')).mockRejectedValueOnce(new Error('Next unavailable')).mockResolvedValueOnce(page([summary(), { ...summary(), agentId: 'b', agentName: 'Other' }]));
    render(<DreamArchiveShelf {...props} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Load more dreams' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Retry more dreams' }));
    await screen.findByRole('button', { name: /Other Dreams/ });
    expect(screen.getAllByRole('button', { name: /Agent Dreams/ })).toHaveLength(1);
    expect(list.mock.calls.slice(1).map(call => call[1])).toEqual(['next', 'next']);
  });

  it('aborts detail on selection replacement and ignores a late result even if transport ignores abort', async () => {
    const { props, list, load } = setup();
    const pending = deferred<DreamArchiveGroup>();
    list.mockResolvedValue(page([summary(), { ...summary(), day: '2026-10-24' }]));
    load.mockReturnValueOnce(pending.promise).mockResolvedValueOnce({ ...detail(), day: '2026-10-24' });
    render(<DreamArchiveShelf {...props} />);
    fireEvent.click(await screen.findByRole('button', { name: /Agent Dreams 10-25-2026/ }));
    const signal = load.mock.calls[0][1];
    fireEvent.click(screen.getByRole('button', { name: /Agent Dreams 10-24-2026/ }));
    expect(signal?.aborted).toBe(true);
    await screen.findByText('Second full diary');
    await act(async () => pending.resolve({ ...detail(), otherDiaries: [{ id: 'late', phase: 'other', createdAt: null, entryDate: null, markdown: 'Late intruder' }] }));
    expect(screen.queryByText('Late intruder')).toBeNull();
  });

  it('clears selection and aborts detail and pagination when filter scope changes', async () => {
    const { props, list, load } = setup();
    const pendingDetail = deferred<DreamArchiveGroup>(); const pendingPage = deferred<ReturnType<typeof page>>();
    list.mockResolvedValueOnce(page([summary()], 'next')).mockReturnValueOnce(pendingPage.promise).mockResolvedValue(page([]));
    load.mockReturnValue(pendingDetail.promise);
    const { rerender } = render(<DreamArchiveShelf {...props} />);
    await selectGroup();
    fireEvent.click(screen.getByRole('button', { name: 'Load more dreams' }));
    const detailSignal = load.mock.calls[0][1]; const pageSignal = list.mock.calls[1][0];
    rerender(<DreamArchiveShelf {...props} queryKey="new" search="new" />);
    expect(detailSignal?.aborted).toBe(true); expect(pageSignal?.aborted).toBe(true);
    await screen.findByText('No dreams match this shelf.');
    await act(async () => { pendingDetail.resolve(detail()); pendingPage.resolve(page()); });
    expect(screen.queryByText('Second full diary')).toBeNull();
    expect(screen.queryByRole('button', { name: /Agent Dreams/ })).toBeNull();
    await waitFor(() => expect(list).toHaveBeenLastCalledWith(expect.any(AbortSignal), null, undefined, undefined, 'new'));
  });
});
