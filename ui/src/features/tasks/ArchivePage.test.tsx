import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Archive } from './ArchivePage';
import { archiveRepository } from './archiveRepository';
import type { ContinuityCard, ContinuityCardGroup } from './archiveTypes';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => { resolve = nextResolve; });
  return { promise, resolve };
}

function card(id: string, title: string): ContinuityCard {
  return { id, kind: 'continuity', agentId: 'smatchet', agentName: 'Smatchet', title, summary: `${title} summary`, firstSeen: '2026-08-20T00:00:00Z', lastSeen: '2026-08-21T00:00:00Z', recurrence: 2 };
}

function detail(value: ContinuityCard): ContinuityCardGroup {
  return { card: value, history: [] };
}

afterEach(() => vi.restoreAllMocks());

describe('Archive detail selection', () => {
  it('does not let a slower previous Tiddle request replace the current card', async () => {
    const firstCard = card('first', 'First card');
    const secondCard = card('second', 'Second card');
    const firstRequest = deferred<ContinuityCardGroup>();
    const secondRequest = deferred<ContinuityCardGroup>();

    vi.spyOn(archiveRepository, 'listContinuityCards').mockResolvedValue([firstCard, secondCard]);
    vi.spyOn(archiveRepository, 'listDreams').mockResolvedValue([]);
    vi.spyOn(archiveRepository, 'listSessions').mockResolvedValue([]);
    vi.spyOn(archiveRepository, 'loadContinuityCard').mockImplementation((selected) => selected.id === 'first' ? firstRequest.promise : secondRequest.promise);

    render(<Archive agents={[]} />);
    fireEvent.click(screen.getByRole('button', { name: /Tiddle/ }));
    await screen.findByRole('button', { name: /First card/ });

    fireEvent.click(screen.getByRole('button', { name: /First card/ }));
    fireEvent.click(screen.getByRole('button', { name: /Second card/ }));
    await act(async () => secondRequest.resolve(detail(secondCard)));
    await screen.findByRole('heading', { level: 2, name: 'Second card' });
    await act(async () => firstRequest.resolve(detail(firstCard)));

    await waitFor(() => expect(screen.queryByRole('heading', { level: 2, name: 'First card' })).toBeNull());
    expect(screen.getByRole('heading', { level: 2, name: 'Second card' })).toBeTruthy();
  });
});
