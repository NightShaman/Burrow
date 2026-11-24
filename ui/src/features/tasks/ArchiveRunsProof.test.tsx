import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { ArchiveRunDetail, ArchiveOutcomeCheck } from '../../app/api';
import { ArchiveRunsProof } from './ArchiveRunsProof';
import { archiveRepository, type ArchivePage } from './archiveRepository';

const runsPage = (runs: ArchiveRunDetail[]): ArchivePage<ArchiveRunDetail> => ({
  items: runs,
  nextCursor: null,
  hasMore: false,
});

function run(agentId = 'smatchet'): ArchiveRunDetail {
  return {
    id: 'shared',
    runId: 'shared',
    agentId,
    sessionId: 'default',
    status: 'completed',
    objective: `${agentId} objective`,
    counts: {
      observations: 0,
      changes: 0,
      verifications: 0,
      unresolved: 0,
      failures: 0,
      toolActivities: 0,
      subagents: 0,
    },
    evidence: { observations: [], changes: [], verifications: [], unresolved: [], failures: [] },
    timeline: [],
    references: { trace: null, sourceRefs: [] },
    subagents: [],
  };
}
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const statuses = [
  ['passed', 'verification passed'],
  ['failed', 'verification failed'],
  ['failed_expected', 'verification failed as expected'],
  ['not_run', 'verification not run'],
] as const;
for (const [status, label] of statuses)
  for (const expected of [false, true])
    for (const actionRequired of [false, true]) {
      it(`${status}: expected=${expected}, actionRequired=${actionRequired}`, async () => {
        const value = run();
        value.subagents = [
          {
            id: 'child',
            status: 'succeeded',
            phase: null,
            purpose: 'Child check',
            createdAt: null,
            completedAt: null,
            model: null,
            result: null,
            trace: {},
            verification: {
              status,
              expected,
              actionRequired,
              check: 'test',
              observed: 'receipt outcome',
            },
          },
        ];
        vi.spyOn(archiveRepository, 'listRuns').mockResolvedValue(runsPage([value]));
        vi.spyOn(archiveRepository, 'loadRun').mockResolvedValue(value);
        render(<ArchiveRunsProof selectedAgent="" search="" />);
        fireEvent.click(await screen.findByRole('button', { name: /smatchet objective/ }));
        const outcome = await screen.findByText(`Minion completed · ${label}`);
        expect(outcome.classList.contains('proof-status-failed')).toBe(status === 'failed');
        expect(
          screen.getByText(actionRequired ? 'Action required' : 'No action required'),
        ).toBeTruthy();
        expect(
          screen.queryByText(actionRequired ? 'No action required' : 'Action required'),
        ).toBeNull();
      });
    }

it('keeps aggregate selection agent-qualified and ignores stale detail responses', async () => {
  const first = run('hatchet'),
    second = run('smatchet');
  let finishFirst!: (value: ArchiveRunDetail) => void;
  const pending = new Promise<ArchiveRunDetail>((resolve) => {
    finishFirst = resolve;
  });
  vi.spyOn(archiveRepository, 'listRuns').mockResolvedValue(runsPage([first, second]));
  const load = vi
    .spyOn(archiveRepository, 'loadRun')
    .mockImplementation((_id, agent) => (agent === 'hatchet' ? pending : Promise.resolve(second)));
  const view = render(<ArchiveRunsProof selectedAgent="" search="" />);
  const firstButton = await screen.findByRole('button', { name: /hatchet objective/ });
  const secondButton = screen.getByRole('button', { name: /smatchet objective/ });
  fireEvent.click(firstButton);
  fireEvent.click(secondButton);
  await screen.findByRole('heading', { level: 2, name: 'smatchet objective' });
  await act(async () => finishFirst(first));
  expect(firstButton.classList.contains('selected')).toBe(false);
  expect(secondButton.classList.contains('selected')).toBe(true);
  expect(screen.queryByRole('heading', { level: 2, name: 'hatchet objective' })).toBeNull();
  expect(load).toHaveBeenLastCalledWith('shared', 'smatchet', expect.any(AbortSignal), 'default');
  view.rerender(<ArchiveRunsProof selectedAgent="hatchet" search="" />);
  expect(screen.queryByRole('heading', { level: 2, name: 'smatchet objective' })).toBeNull();
});

it('does not restore pending detail after changing the agent filter', async () => {
  const value = run();
  let finish!: (value: ArchiveRunDetail) => void;
  vi.spyOn(archiveRepository, 'listRuns').mockResolvedValue(runsPage([value]));
  vi.spyOn(archiveRepository, 'loadRun').mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const view = render(<ArchiveRunsProof selectedAgent="" search="" />);
  fireEvent.click(await screen.findByRole('button', { name: /smatchet objective/ }));
  view.rerender(<ArchiveRunsProof selectedAgent="hatchet" search="" />);
  await act(async () => finish(value));
  expect(screen.queryByRole('heading', { level: 2, name: 'smatchet objective' })).toBeNull();
});

it('renders linked child summaries as safe Markdown with chat line breaks', async () => {
  const value = run();
  value.subagents = [
    {
      id: 'child',
      status: 'succeeded',
      phase: null,
      purpose: 'Markdown child',
      createdAt: null,
      completedAt: null,
      model: null,
      trace: {},
      result: {
        summary:
          '## Child reply\n\n**Completed** with `code`\nNext line\n\n- First finding\n- Second finding\n\n```js\nconst done = true;\n```\n\n[Reference](https://example.com)\n\n<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n[Unsafe](javascript:alert(1))',
        evidence: 2,
        changedFiles: 0,
      },
    },
  ];
  vi.spyOn(archiveRepository, 'listRuns').mockResolvedValue(runsPage([value]));
  vi.spyOn(archiveRepository, 'loadRun').mockResolvedValue(value);
  render(<ArchiveRunsProof selectedAgent="" search="" />);
  fireEvent.click(await screen.findByRole('button', { name: /smatchet objective/ }));
  const heading = await screen.findByRole('heading', { name: 'Child reply', level: 2 });
  const summary = heading.closest('.proof-child-summary')!;
  expect(summary.querySelector('strong')?.textContent).toBe('Completed');
  expect(summary.querySelector('code')?.textContent).toBe('code');
  expect(summary.querySelector('br')).not.toBeNull();
  expect(summary.querySelectorAll('ul > li')).toHaveLength(2);
  expect(summary.querySelector('pre > code')?.textContent).toBe('const done = true;\n');
  expect(screen.getByRole('link', { name: 'Reference' }).getAttribute('href')).toBe(
    'https://example.com',
  );
  expect(summary.querySelector('script, img, [onerror]')).toBeNull();
  expect(screen.getByText('Unsafe').getAttribute('href')).not.toContain('javascript:');
});

it('lazy-loads and expands full redacted tool evidence from the trace API', async () => {
  const value = run();
  value.sessionId = 'proof-session';
  vi.spyOn(archiveRepository, 'listRuns').mockResolvedValue(runsPage([value]));
  vi.spyOn(archiveRepository, 'loadRun').mockResolvedValue(value);
  const trace = vi
    .spyOn(archiveRepository, 'loadRunTrace')
    .mockResolvedValue({ tools: [{ name: 'shell', output: '[REDACTED]' }] });
  render(<ArchiveRunsProof selectedAgent="" search="" />);
  fireEvent.click(await screen.findByRole('button', { name: /smatchet objective/ }));
  const summary = await screen.findByText('Full redacted tool evidence');
  expect(trace).not.toHaveBeenCalled();
  fireEvent.click(summary);
  expect(await screen.findByText(/"output": "\[REDACTED\]"/)).toBeTruthy();
  expect(trace).toHaveBeenCalledWith(
    'shared',
    'smatchet',
    'proof-session',
    expect.any(AbortSignal),
  );
});

it('copies archived proof with real Markdown newlines while preserving literal request text', async () => {
  const value = run();
  value.request = 'Keep literal \\n in user text';
  value.finalAnswer = 'Finished';
  value.evidence.changes = [
    { status: 'validated', text: 'First', sourceRefs: [] },
    { status: 'validated', text: 'Second', sourceRefs: [] },
  ] as ArchiveRunDetail['evidence']['changes'];
  vi.spyOn(archiveRepository, 'listRuns').mockResolvedValue(runsPage([value]));
  vi.spyOn(archiveRepository, 'loadRun').mockResolvedValue(value);
  const copy = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('isSecureContext', true);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: copy } });
  render(<ArchiveRunsProof selectedAgent="" search="" />);
  fireEvent.click(await screen.findByRole('button', { name: /smatchet objective/ }));
  fireEvent.click(await screen.findByRole('button', { name: 'Copy proof as Markdown' }));
  expect(copy).toHaveBeenCalledOnce();
  const text = copy.mock.calls[0][0] as string;
  expect(text).toContain('# smatchet objective\n- Agent: smatchet\n- Status: Completed');
  expect(text).toContain('## Request\n\nKeep literal \\n in user text');
  expect(text).toContain('## Final outcome\n\nFinished');
  expect(text).toContain('### Actions / changes\n- **validated** First\n- **validated** Second');
  expect(text).toContain('## Timeline\n_No timeline evidence recorded._');
  expect(text.replace(value.request, '')).not.toContain('\\n');
  vi.unstubAllGlobals();
});

it('searches for unloaded runs and paginates the same query, then restores browsing when cleared', async () => {
  const latest = run('smatchet');
  const older = { ...run('ratchet'), runId: 'default-1794944873459' };
  const another = { ...run('ratchet'), runId: 'next-result', objective: 'Another match' };
  const list = vi
    .spyOn(archiveRepository, 'listRuns')
    .mockImplementation(async (_agent, _signal, cursor, query) => {
      if (query !== older.runId)
        return { ...runsPage([latest]), hasMore: true, nextCursor: 'unfiltered' };
      return cursor
        ? runsPage([another])
        : { ...runsPage([older]), hasMore: true, nextCursor: 'filtered' };
    });
  const view = render(<ArchiveRunsProof selectedAgent="" search="" />);
  await screen.findByRole('button', { name: /smatchet objective/ });
  view.rerender(<ArchiveRunsProof selectedAgent="" search={` ${older.runId} `} />);
  expect(screen.queryByRole('button', { name: 'Load more runs' })).toBeNull();
  await screen.findByRole('button', { name: /ratchet objective/ });
  expect(list).toHaveBeenLastCalledWith('', expect.any(AbortSignal), null, older.runId);
  fireEvent.click(screen.getByRole('button', { name: 'Load more runs' }));
  await screen.findByRole('button', { name: /Another match/ });
  expect(list).toHaveBeenLastCalledWith('', expect.any(AbortSignal), 'filtered', older.runId);
  view.rerender(<ArchiveRunsProof selectedAgent="" search=" " />);
  await screen.findByRole('button', { name: /smatchet objective/ });
  expect(screen.queryByRole('button', { name: /ratchet objective/ })).toBeNull();
  expect(list).toHaveBeenLastCalledWith('', expect.any(AbortSignal), null, '');
});

it('debounces typing and ignores a stale search page after the query changes', async () => {
  const stale = run('hatchet');
  const current = run('ratchet');
  const list = vi.spyOn(archiveRepository, 'listRuns');
  list.mockResolvedValueOnce(runsPage([stale]));
  let finishOldPage!: (page: ArchivePage<ArchiveRunDetail>) => void;
  list.mockReturnValueOnce(
    new Promise((resolve) => {
      finishOldPage = resolve;
    }),
  );
  list.mockResolvedValueOnce(runsPage([current]));
  const view = render(<ArchiveRunsProof selectedAgent="ratchet" search="" />);
  await screen.findByRole('button', { name: /hatchet objective/ });
  view.rerender(<ArchiveRunsProof selectedAgent="ratchet" search="de" />);
  view.rerender(<ArchiveRunsProof selectedAgent="ratchet" search="default" />);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 200));
  });
  expect(list).toHaveBeenCalledTimes(2);
  expect(list).toHaveBeenLastCalledWith('ratchet', expect.any(AbortSignal), null, 'default');
  const oldSignal = list.mock.lastCall?.[1];
  view.rerender(<ArchiveRunsProof selectedAgent="ratchet" search="default-1794944873459" />);
  await screen.findByRole('button', { name: /ratchet objective/ });
  expect(oldSignal?.aborted).toBe(true);
  await act(async () => finishOldPage(runsPage([stale])));
  expect(screen.queryByRole('button', { name: /hatchet objective/ })).toBeNull();
});

it('merges overlapping pages and opens same-run occurrences by session', async () => {
  const first = run();
  const second = { ...first, sessionId: 'second', objective: 'Second occurrence' };
  const third = { ...first, runId: 'third', objective: 'Third occurrence' };
  vi.spyOn(archiveRepository, 'listRuns')
    .mockResolvedValueOnce({ items: [first], nextCursor: 'next', hasMore: true })
    .mockResolvedValueOnce(runsPage([first, second, first, third]));
  const load = vi.spyOn(archiveRepository, 'loadRun').mockResolvedValue(second);
  render(<ArchiveRunsProof selectedAgent="" search="" />);
  fireEvent.click(await screen.findByRole('button', { name: /load more/i }));
  const row = await screen.findByRole('button', { name: /Second occurrence/ });
  expect(screen.getByRole('button', { name: /Third occurrence/ })).toBeTruthy();
  const original = screen.getByRole('button', { name: /smatchet objective/ });
  fireEvent.click(row);
  expect(load).toHaveBeenCalledWith('shared', 'smatchet', expect.any(AbortSignal), 'second');
  expect(row.classList.contains('selected')).toBe(true);
  expect(original.classList.contains('selected')).toBe(false);
  expect(await screen.findByRole('heading', { level: 2, name: 'Second occurrence' })).toBeTruthy();
});

const checkedAt = '2026-11-24T20:45:21.000Z';
function checkReceipt(status: ArchiveOutcomeCheck['status']): ArchiveOutcomeCheck {
  const absent = status === 'unverified';
  const repository = 'GoblinKing-Burrow/Burrow',
    version = '2026.11.24';
  const artifact = {
    sourceTreeSha: 'a'.repeat(40),
    imageRepository: 'ghcr.io/example/burrow',
    imageId: `sha256:${'b'.repeat(64)}`,
  };
  return {
    schemaVersion: 1,
    kind: 'outcome-check',
    verifier: 'github_public_release',
    status,
    checkedAt,
    expected: { repository, version, artifact },
    observed: {
      repository,
      version: absent ? null : status === 'mismatch' ? '2026.11.23' : version,
      artifact: absent
        ? { sourceTreeSha: null }
        : {
            ...artifact,
            imageId: status === 'mismatch' ? `sha256:${'c'.repeat(64)}` : artifact.imageId,
            manifestDigest: `sha256:${'d'.repeat(64)}`,
          },
    },
    reasonCode: absent ? 'tag_missing' : status,
    reason: absent
      ? 'No public tag found for 2026.11.24.'
      : status === 'mismatch'
        ? 'Public version and image do not match the intended release.'
        : 'The public tree and image match.',
    evidenceSources: [
      {
        kind: 'github_ref',
        url: `https://api.github.com/repos/${repository}/git/ref/tags/${version}`,
        checkedAt,
        statusCode: absent ? 404 : 200,
      },
    ],
    intentSource: { kind: 'caller_supplied', sourceRefs: [] },
  };
}
async function openProof(value: ArchiveRunDetail) {
  vi.spyOn(archiveRepository, 'listRuns').mockResolvedValue(runsPage([value]));
  vi.spyOn(archiveRepository, 'loadRun').mockResolvedValue(value);
  render(<ArchiveRunsProof selectedAgent="" search="" />);
  fireEvent.click(await screen.findByRole('button', { name: /smatchet objective/ }));
  await screen.findByRole('heading', { name: 'smatchet objective', level: 2 });
}
for (const status of ['verified', 'mismatch', 'unverified'] as const) {
  it(`keeps green workflow, completed handling and ${status} publication independent in Proof and Markdown`, async () => {
    const value = run(),
      check = checkReceipt(status);
    value.workflowEvent = {
      workflow: 'Public promotion',
      conclusion: 'success',
      runId: 421,
      runAttempt: 2,
    };
    value.evidence.verifications.push({
      status: 'observed',
      text: 'Native receipt',
      sourceRefs: [],
      outcomeCheck: check,
    });
    value.timeline.push({
      kind: 'verification',
      ts: checkedAt,
      status: 'observed',
      evidence: 'outcome_check',
      summary: `Release check: ${status}`,
    });
    value.counts.verifications = 1;
    const copy = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('isSecureContext', true);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: copy },
    });
    try {
      await openProof(value);
      expect(
        screen.getByText('GitHub conclusion: success · Public promotion #421 · attempt 2'),
      ).toBeTruthy();
      expect(screen.getByText('smatchet · Burrow handling: Completed')).toBeTruthy();
      expect(screen.getByText(check.reason)).toBeTruthy();
      const expected = within(screen.getByText('Expected (caller supplied)').parentElement!);
      const observed = within(screen.getByText('Observed', { exact: true }).parentElement!);
      expect(expected.getByText(check.expected.version)).toBeTruthy();
      expect(expected.getByText(check.expected.artifact.imageId!)).toBeTruthy();
      expect(
        observed.getAllByText(check.observed.version ?? 'Not observed').length,
      ).toBeGreaterThan(0);
      expect(
        observed.getAllByText(check.observed.artifact.sourceTreeSha ?? 'Not observed').length,
      ).toBeGreaterThan(0);
      expect(
        observed.getAllByText(check.observed.artifact.imageId ?? 'Not observed').length,
      ).toBeGreaterThan(0);
      const verdict = screen.getByText(status, {
        exact: false,
        selector: '.proof-outcome-heading strong',
      });
      expect(verdict.textContent?.toLowerCase()).toBe(status);
      expect(screen.getByText(`Release check: ${status}`)).toBeTruthy();
      expect(screen.getByText(/^Checked /).getAttribute('datetime')).toBe(check.checkedAt);
      fireEvent.click(screen.getByText(/Evidence sources: api.github.com/));
      expect(screen.getByText(check.evidenceSources[0].url, { exact: false })).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'Copy proof as Markdown' }));
      const text = copy.mock.calls[0][0] as string;
      for (const part of [
        check.checkedAt,
        check.expected.version,
        check.expected.artifact.sourceTreeSha,
        check.observed.version ?? 'Not observed',
        check.reason,
        check.evidenceSources[0].url,
        `HTTP ${check.evidenceSources[0].statusCode}`,
        'Burrow handling: Completed',
        'GitHub conclusion: success',
        `Public release: ${verdict.textContent}`,
        'Expected (caller supplied)',
        'Observed:',
      ])
        expect(text).toContain(part);
      if (check.observed.artifact.manifestDigest)
        expect(text).toContain(check.observed.artifact.manifestDigest);
    } finally {
      vi.unstubAllGlobals();
    }
  });
}
it('does not infer a publication check from plain evidence or the agent’s final answer', async () => {
  const value = run();
  value.workflowEvent = { conclusion: 'success' };
  value.finalAnswer = 'Publication verified.';
  value.evidence.verifications.push({
    text: 'Build tests passed',
    status: 'validated',
    sourceRefs: [],
  });
  await openProof(value);
  expect(screen.getByText('No outcome check recorded.')).toBeTruthy();
  expect(screen.getByText('Build tests passed')).toBeTruthy();
  expect(screen.queryByText('Public release')).toBeNull();
  expect(screen.getByText('No timeline evidence recorded.')).toBeTruthy();
});
it('keeps historical Proof empty states without inventing workflow handling or a missing check', async () => {
  await openProof(run());
  expect(screen.getByText('No verification recorded.')).toBeTruthy();
  expect(
    screen.queryByText(/GitHub conclusion|Burrow handling|No outcome check recorded/),
  ).toBeNull();
});
