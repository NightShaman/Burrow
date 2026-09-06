import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { ArchiveRunDetail } from '../../app/api';
import { ArchiveRunsProof } from './ArchiveRunsProof';
import { archiveRepository } from './archiveRepository';

function run(agentId = 'smatchet'): ArchiveRunDetail {
  return { id: 'shared', runId: 'shared', agentId, sessionId: 'default', status: 'completed', objective: `${agentId} objective`, counts: { observations: 0, changes: 0, verifications: 0, unresolved: 0, failures: 0, toolActivities: 0, subagents: 0 }, evidence: { observations: [], changes: [], verifications: [], unresolved: [], failures: [] }, timeline: [], references: { trace: null, sourceRefs: [] }, subagents: [] };
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const statuses = [
  ['passed', 'verification passed'], ['failed', 'verification failed'],
  ['failed_expected', 'verification failed as expected'], ['not_run', 'verification not run'],
] as const;
for (const [status, label] of statuses) for (const expected of [false, true]) for (const actionRequired of [false, true]) {
  it(`${status}: expected=${expected}, actionRequired=${actionRequired}`, async () => {
    const value = run();
    value.subagents = [{ id: 'child', status: 'succeeded', phase: null, purpose: 'Child check', createdAt: null, completedAt: null, model: null, result: null, trace: {}, verification: { status, expected, actionRequired, check: 'test', observed: 'receipt outcome' } }];
    vi.spyOn(archiveRepository, 'listRuns').mockResolvedValue([value]);
    vi.spyOn(archiveRepository, 'loadRun').mockResolvedValue(value);
    render(<ArchiveRunsProof selectedAgent="" search="" />);
    fireEvent.click(await screen.findByRole('button', { name: /smatchet objective/ }));
    const outcome = await screen.findByText(`Child completed · ${label}`);
    expect(outcome.classList.contains('proof-status-failed')).toBe(status === 'failed');
    expect(screen.getByText(actionRequired ? 'Action required' : 'No action required')).toBeTruthy();
    expect(screen.queryByText(actionRequired ? 'No action required' : 'Action required')).toBeNull();
  });
}

it('keeps aggregate selection agent-qualified and ignores stale detail responses', async () => {
  const first = run('hatchet'), second = run('smatchet');
  let finishFirst!: (value: ArchiveRunDetail) => void;
  const pending = new Promise<ArchiveRunDetail>((resolve) => { finishFirst = resolve; });
  vi.spyOn(archiveRepository, 'listRuns').mockResolvedValue([first, second]);
  const load = vi.spyOn(archiveRepository, 'loadRun').mockImplementation((_id, agent) => agent === 'hatchet' ? pending : Promise.resolve(second));
  const view = render(<ArchiveRunsProof selectedAgent="" search="" />);
  const firstButton = await screen.findByRole('button', { name: /hatchet objective/ });
  const secondButton = screen.getByRole('button', { name: /smatchet objective/ });
  fireEvent.click(firstButton); fireEvent.click(secondButton);
  await screen.findByRole('heading', { level: 2, name: 'smatchet objective' });
  await act(async () => finishFirst(first));
  expect(firstButton.classList.contains('selected')).toBe(false);
  expect(secondButton.classList.contains('selected')).toBe(true);
  expect(screen.queryByRole('heading', { level: 2, name: 'hatchet objective' })).toBeNull();
  expect(load).toHaveBeenLastCalledWith('shared', 'smatchet', expect.any(AbortSignal));
  view.rerender(<ArchiveRunsProof selectedAgent="hatchet" search="" />);
  expect(screen.queryByRole('heading', { level: 2, name: 'smatchet objective' })).toBeNull();
});

it('does not restore pending detail after changing the agent filter', async () => {
  const value = run();
  let finish!: (value: ArchiveRunDetail) => void;
  vi.spyOn(archiveRepository, 'listRuns').mockResolvedValue([value]);
  vi.spyOn(archiveRepository, 'loadRun').mockReturnValue(new Promise((resolve) => { finish = resolve; }));
  const view = render(<ArchiveRunsProof selectedAgent="" search="" />);
  fireEvent.click(await screen.findByRole('button', { name: /smatchet objective/ }));
  view.rerender(<ArchiveRunsProof selectedAgent="hatchet" search="" />);
  await act(async () => finish(value));
  expect(screen.queryByRole('heading', { level: 2, name: 'smatchet objective' })).toBeNull();
});

it('renders linked child summaries as safe Markdown with chat line breaks', async () => {
  const value = run();
  value.subagents = [{ id: 'child', status: 'succeeded', phase: null, purpose: 'Markdown child', createdAt: null, completedAt: null, model: null, trace: {}, result: { summary: '## Child reply\n\n**Completed** with `code`\nNext line\n\n- First finding\n- Second finding\n\n```js\nconst done = true;\n```\n\n[Reference](https://example.com)\n\n<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n[Unsafe](javascript:alert(1))', evidence: 2, changedFiles: 0 } }];
  vi.spyOn(archiveRepository, 'listRuns').mockResolvedValue([value]);
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
  expect(screen.getByRole('link', { name: 'Reference' }).getAttribute('href')).toBe('https://example.com');
  expect(summary.querySelector('script, img, [onerror]')).toBeNull();
  expect(screen.getByText('Unsafe').getAttribute('href')).not.toContain('javascript:');
});
