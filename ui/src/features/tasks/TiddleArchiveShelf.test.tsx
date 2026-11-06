import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { TiddleArchiveShelf } from './TiddleArchiveShelf';
import type { ArchiveRepository } from './archiveRepository';
import type { ContinuityCard, ContinuityCardGroup } from './archiveTypes';

const card = (id: string): ContinuityCard => ({
  id,
  kind: 'continuity',
  agentId: 'agent',
  agentName: 'Agent',
  title: `Card ${id}`,
  summary: `Summary ${id}`,
  firstSeen: '2026-01-01',
  lastSeen: '2026-01-02',
  recurrence: 2,
});
const detail = (
  value: ContinuityCard,
  cursor: string | null = `${value.id}-older`,
): ContinuityCardGroup => ({
  card: value,
  history: [],
  nextCursor: cursor,
  hasMore: Boolean(cursor),
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it.each(['success', 'failure'])(
  'allows B history pagination after switching away from pending A history (%s)',
  async (outcome) => {
    let resolveA!: (value: ContinuityCardGroup) => void;
    let rejectA!: (reason: Error) => void;
    const pendingA = new Promise<ContinuityCardGroup>((resolve, reject) => {
      resolveA = resolve;
      rejectA = reject;
    });
    const a = card('a'),
      b = card('b');
    const loadContinuityCard = vi.fn(
      async (selected: ContinuityCard, _signal?: AbortSignal, cursor?: string | null) => {
        if (selected.id === 'a' && cursor) return pendingA;
        return detail(selected, cursor ? null : undefined);
      },
    );
    const repository = {
      listContinuityCards: vi.fn(async () => ({ items: [a, b], nextCursor: null, hasMore: false })),
      loadContinuityCard,
    } as unknown as ArchiveRepository;
    render(
      <TiddleArchiveShelf
        archiveRepository={repository}
        selectedAgent="agent"
        search=""
        queryKey="scope"
        onCount={() => {}}
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: /Card a/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Load more history' }));
    expect(screen.getByRole('button', { name: 'Loading more history…' })).toHaveProperty(
      'disabled',
      true,
    );
    fireEvent.click(screen.getByRole('button', { name: /Card b/ }));
    await screen.findByRole('button', { name: 'Load more history' });
    await act(async () => {
      if (outcome === 'success') resolveA(detail(a, null));
      else rejectA(new Error('old failed'));
      try {
        await pendingA;
      } catch {
        /* expected */
      }
    });
    expect(screen.getByRole('button', { name: 'Load more history' })).toHaveProperty(
      'disabled',
      false,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Load more history' }));
    await vi.waitFor(() =>
      expect(loadContinuityCard).toHaveBeenCalledWith(b, expect.any(AbortSignal), 'b-older'),
    );
  },
);
