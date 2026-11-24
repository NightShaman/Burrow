import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { Archive } from './ArchivePage';
import {
  archiveRepository,
  type ArchiveCalendarAvailability,
  type ArchivePage,
} from './archiveRepository';
import type { ArchiveWorkflowEvent } from './archiveTypes';
import type { Agent } from '../../app/types';

const empty = { items: [], nextCursor: null, hasMore: false };
function setup() {
  vi.spyOn(archiveRepository, 'listSessions').mockResolvedValue(empty);
  vi.spyOn(archiveRepository, 'listDreams').mockResolvedValue({
    ...empty,
    items: [{} as any, {} as any],
  });
  vi.spyOn(archiveRepository, 'listContinuityCards').mockResolvedValue({
    ...empty,
    items: [{ id: 'c', title: 'Card', summary: 'Card summary' } as any],
  });
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async (input) =>
      new Response(
        JSON.stringify(
          String(input).includes('/task-board/tasks')
            ? { tasks: [{ archived: true }] }
            : String(input).includes('/task-board/projects')
              ? { projects: [] }
              : { mods: [] },
        ),
        { headers: { 'content-type': 'application/json' } },
      ),
  );
  return vi
    .spyOn(archiveRepository, 'listCalendarAvailability')
    .mockImplementation(async (kind, month) => ({ ok: true, kind, month, dates: [] }));
}
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

it('integrates built-in Workflow Events with server day/search/agent filters and workflow calendar without changing badges', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 9, 25, 12));
  const calendar = setup();
  calendar.mockImplementation(async (kind, month) => ({
    ok: true,
    kind,
    month,
    dates: kind === 'workflow-events' ? [`${month}-25`] : [],
  }));
  const list = vi.spyOn(archiveRepository, 'listWorkflowEvents').mockResolvedValue(empty);
  render(
    <Archive agents={[{ id: 'a', name: 'Agent A' } as Agent]} repository={archiveRepository} />,
  );
  await screen.findByRole('button', { name: /^Dreams\s*2$/ });
  expect(screen.getByRole('button', { name: /^Tiddle\s*1$/ })).toBeTruthy();
  expect(screen.getByRole('button', { name: /^Tasks\s*1$/ })).toBeTruthy();
  expect(list).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: /^Workflow Events/ }));
  expect(screen.getByRole('searchbox').getAttribute('placeholder')).toBe('Search workflow events');
  fireEvent.click(
    await screen.findByRole('button', { name: 'Select 2026-10-25, has archived records' }),
  );
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'deploy' } });
  await waitFor(() =>
    expect(list).toHaveBeenLastCalledWith(
      'deploy',
      expect.any(AbortSignal),
      null,
      '2026-10-25',
      undefined,
    ),
  );
  fireEvent.change(screen.getByLabelText('Filter by agent'), { target: { value: 'a' } });
  await waitFor(() =>
    expect(list).toHaveBeenLastCalledWith('deploy', expect.any(AbortSignal), null, undefined, 'a'),
  );
  expect(calendar).toHaveBeenLastCalledWith(
    'workflow-events',
    '2026-10',
    'a',
    expect.any(AbortSignal),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Select 2026-10-25, has archived records' }));
  await waitFor(() =>
    expect(list).toHaveBeenLastCalledWith(
      'deploy',
      expect.any(AbortSignal),
      null,
      '2026-10-25',
      'a',
    ),
  );
  fireEvent.click(screen.getByRole('button', { name: 'All dates' }));
  await waitFor(() =>
    expect(list).toHaveBeenLastCalledWith('deploy', expect.any(AbortSignal), null, undefined, 'a'),
  );
});

it('aborts workflow requests on shelf switch and ignores late rows and calendar dates', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 9, 25, 12));
  const calendar = setup();
  let finishCalendar!: (value: ArchiveCalendarAvailability) => void;
  calendar.mockImplementation((kind, month) =>
    kind === 'workflow-events'
      ? new Promise((resolve) => {
          finishCalendar = resolve;
        })
      : Promise.resolve({ ok: true, kind, month, dates: [] }),
  );
  let finish!: (value: ArchivePage<ArchiveWorkflowEvent>) => void;
  const list = vi.spyOn(archiveRepository, 'listWorkflowEvents').mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  render(<Archive agents={[]} repository={archiveRepository} />);
  fireEvent.click(screen.getByRole('button', { name: /^Workflow Events/ }));
  await waitFor(() => expect(list).toHaveBeenCalledOnce());
  const signal = list.mock.calls[0][1];
  const calendarSignal = calendar.mock.calls.find((call) => call[0] === 'workflow-events')![3];
  fireEvent.click(screen.getByRole('button', { name: /^Chat/ }));
  expect(signal?.aborted).toBe(true);
  expect(calendarSignal?.aborted).toBe(true);
  await act(async () => {
    finish({
      ...empty,
      items: [{ id: 'late', workflow: 'Late intruder' } as ArchiveWorkflowEvent],
    });
    finishCalendar({ ok: true, kind: 'workflow-events', month: '2026-10', dates: ['2026-10-25'] });
  });
  expect(screen.queryByText('Late intruder')).toBeNull();
  expect(
    screen.queryByRole('button', { name: 'Select 2026-10-25, has archived records' }),
  ).toBeNull();
  await screen.findByText('No conversations match this shelf.');
});

it('opens only the associated Proof and resolves the exact triggering event beyond page one', async () => {
  setup();
  const event = {
    agentId: 'hatchet',
    id: 'delivery-b',
    workflow: 'Public promotion',
    status: 'succeeded',
    runId: '321',
    sessionId: 'ci-b',
    chatRunId: 'handling-b',
    instruction: 'Inspect the intended public tree.',
  } as ArchiveWorkflowEvent;
  const other = { ...event, id: 'delivery-a', sessionId: 'ci-a', chatRunId: 'handling-a' };
  const list = vi
    .spyOn(archiveRepository, 'listWorkflowEvents')
    .mockResolvedValueOnce({ ...empty, items: [other, event] })
    .mockResolvedValue({ ...empty, items: [other] });
  const target = { agentId: event.agentId, sessionId: event.sessionId, runId: event.chatRunId! };
  const detail = vi.spyOn(archiveRepository, 'loadWorkflowEvent').mockResolvedValue({
    ok: true,
    event,
    handlingProof: {
      status: 'available',
      target,
      reasonCode: 'retained',
      reason: 'Exact proof retained.',
    },
  });
  const run = {
    ...target,
    id: target.runId,
    status: 'completed' as const,
    objective: 'Handle Public promotion delivery B',
    workflowEvent: {
      id: event.id,
      workflow: event.workflow,
      runId: event.runId,
      conclusion: 'success',
    },
    counts: {
      observations: 1,
      changes: 0,
      verifications: 0,
      unresolved: 0,
      failures: 0,
      toolActivities: 0,
      subagents: 0,
    },
    evidence: { observations: [], changes: [], verifications: [], unresolved: [], failures: [] },
    timeline: [],
    subagents: [],
    references: { trace: null, sourceRefs: [] },
  };
  vi.spyOn(archiveRepository, 'listRuns').mockResolvedValue({
    ...empty,
    items: [
      {
        ...run,
        ...{
          id: 'handling-a',
          runId: 'handling-a',
          sessionId: 'ci-a',
          objective: 'Another delivery',
        },
      },
    ],
  });
  const load = vi.spyOn(archiveRepository, 'loadRun').mockResolvedValue(run);
  render(<Archive agents={[]} repository={archiveRepository} />);
  fireEvent.click(screen.getByRole('button', { name: /^Workflow Events/ }));
  const rows = await screen.findAllByRole('button', { name: /Public promotion/ });
  expect(detail).not.toHaveBeenCalled();
  fireEvent.click(rows[1]);
  expect(await screen.findByText('Exact proof retained.')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: /Open run proof/ }));
  await screen.findByRole('heading', { level: 2, name: run.objective });
  expect(load).toHaveBeenCalledTimes(1);
  expect(load).toHaveBeenCalledWith('handling-b', 'hatchet', expect.any(AbortSignal), 'ci-b');
  fireEvent.click(screen.getByRole('button', { name: 'Open triggering event' }));
  await screen.findByText(event.id);
  expect(detail).toHaveBeenCalledTimes(2);
  expect(detail.mock.calls.map(([key]) => key)).toEqual(
    Array(2).fill({ id: event.id, agentId: 'hatchet' }),
  );
  await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
  expect(screen.getByText(event.instruction)).toBeTruthy();
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'another' } });
  expect(screen.queryByText(event.id)).toBeNull();
});
