import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { ArchiveRunDetail, ArchiveRunSummary } from '../../app/api';
import producer from './fixtures/archive-status-producer.json';
import { ArchiveRunsProof } from './ArchiveRunsProof';
import { createArchiveRepository } from './archiveRepository';

// Exact JSON emitted by Backend's real-PG producer test, 2026-11-25.
// Source SHA256: 5a6e5120b245584a22911354f153b484b787181dbdbcdc4319708ca108a8aef2
// These are test records, not retained live tasks or outcome verification.
afterEach(cleanup);
for (const item of producer) {
  it(`consumes actual producer ${item.summary.execution.status} with independent tool history`, async () => {
    const request = vi.fn(async (path: string) =>
      path.startsWith('/api/archive/runs?')
        ? { ok: true, runs: producer.map((p) => p.summary), hasMore: false, nextCursor: null }
        : { ok: true, run: item.detail },
    );
    const repository = createArchiveRepository(request as never);
    render(<ArchiveRunsProof selectedAgent="" search="" repository={repository} />);
    const row = await screen.findByRole('button', { name: new RegExp(item.summary.objective) });
    const label =
      item.summary.execution.status === 'not_recorded'
        ? 'Not recorded'
        : item.summary.execution.status[0].toUpperCase() + item.summary.execution.status.slice(1);
    expect(within(row).getByText(label)).toBeTruthy();
    expect(row.textContent).toContain('Tools: 1 failed attempt');
    fireEvent.click(row);
    await screen.findByRole('heading', { level: 2, name: item.detail.objective });
    const summary = within(document.querySelector('.proof-run-summary')! as HTMLElement);
    expect(summary.getByText(label)).toBeTruthy();
    expect(summary.getByText(item.detail.execution.reason)).toBeTruthy();
    expect(summary.getByText('1 failed attempt')).toBeTruthy();
    expect(summary.getByText('No verification recorded')).toBeTruthy();
    expect(
      screen.getByText('Command failed · exit: 128 · fatal: actual sanitized error reason'),
    ).toBeTruthy();
    expect(screen.queryByText('Warning', { exact: true })).toBeNull();
    expect(request.mock.calls[1][0]).toBe(
      `/api/archive/runs/${item.detail.runId}?agentId=a&sessionId=default`,
    );
    expect(item.summary.execution).toEqual(item.detail.execution);
    expect(item.summary.toolHistory).toEqual(item.detail.toolHistory);
    // Compile-time contracts, not runtime coercion of missing list evidence.
    const detail: ArchiveRunDetail = item.detail as ArchiveRunDetail;
    const summaryRecord: ArchiveRunSummary = item.summary as ArchiveRunSummary;
    expect(detail.runId).toBe(summaryRecord.runId);
  });
}
