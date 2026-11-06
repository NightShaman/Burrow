import React from 'react';
import { createRoot } from 'react-dom/client';
import { TiddleArchiveShelf } from '../../src/features/tasks/TiddleArchiveShelf';
import type { ArchiveRepository } from '../../src/features/tasks/archiveRepository';
import '../../src/app.css';
const at = '2026-11-06T04:00:00Z';
const cards = ['A', 'B'].map((id) => ({
  id,
  kind: 'continuity' as const,
  agentId: 'hatchet',
  agentName: 'Hatchet',
  title: `Fixture card ${id}`,
  summary: 'Synthetic continuity evidence.',
  firstSeen: at,
  lastSeen: at,
  recurrence: 2,
}));
const requests: unknown[] = [],
  errors: string[] = [];
let release: (() => void) | null = null;
window.addEventListener('error', (e) => errors.push(e.message));
window.addEventListener('unhandledrejection', (e) => errors.push(String(e.reason)));
Object.assign(window, {
  fixtureEvidence: { requests, errors },
  fixtureReleaseHistory: () => {
    if (!release) throw new Error('No pending A pagination');
    const done = release;
    release = null;
    done();
  },
});
// The repository methods are injected into the real shelf; no HTTP or provider connection.
const archiveRepository = {
  listContinuityCards: async () => ({ items: cards, hasMore: false, nextCursor: null }),
  loadContinuityCard: async (
    card: (typeof cards)[number],
    signal: AbortSignal,
    cursor?: string,
  ) => {
    requests.push({ card: card.id, cursor: cursor ?? null });
    if (card.id === 'A' && cursor)
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    return {
      card,
      history: [
        {
          id: `entry-${card.id}`,
          at,
          agentId: 'hatchet',
          scope: null,
          disposition: 'updated',
          reason: 'Synthetic evidence',
        },
      ],
      nextCursor: cursor ? null : `older-${card.id}`,
      hasMore: !cursor,
    };
  },
} as unknown as ArchiveRepository;
createRoot(document.getElementById('root')!).render(
  <main className="cockpit" data-theme="smatchet">
    <header className="app-header">Actual Tiddle archive shelf — pending A older history</header>
    <section className="workspace">
      <TiddleArchiveShelf
        archiveRepository={archiveRepository}
        selectedAgent="hatchet"
        search=""
        queryKey="fixed-local-fixture"
        onCount={() => {}}
      />
    </section>
  </main>,
);
