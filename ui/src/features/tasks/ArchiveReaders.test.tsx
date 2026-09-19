import { describe, expect, it } from 'vitest';
import { archiveTurnText } from './ArchiveReaders';

const names = new Map([
  ['hatchet', 'Hatchet'],
  ['smatchet', 'Smatchet'],
  ['guido', 'Guido'],
]);

describe('archive transcript attribution', () => {
  it('uses each message sender in group and peer conversations', () => {
    expect(archiveTurnText({ role: 'agent', content: 'Backend report', metadata: { fromAgentId: 'hatchet' } }, 'Smatchet', names, 'Rob')).toContain('## Hatchet');
    expect(archiveTurnText({ role: 'agent', content: 'Frontend report', metadata: { fromAgentId: 'smatchet', fromAgentName: 'Smatchet' } }, 'Hatchet', names, 'Rob')).toContain('## Smatchet');
    expect(archiveTurnText({ role: 'agent', content: 'Newspaper report', metadata: { fromAgentId: 'guido' } }, 'Hatchet', names, 'Rob')).toContain('## Guido');
  });

  it('uses the configured operator name and preserves markdown content', () => {
    const copied = archiveTurnText({ role: 'user', content: 'Run:\n```sh\nnpm test\n```' }, 'Smatchet', names, 'Goblin King');
    expect(copied).toBe('## Goblin King\n\nRun:\n```sh\nnpm test\n```');
  });

  it('falls back honestly for single-agent and unknown senders', () => {
    expect(archiveTurnText({ role: 'assistant', content: 'Hello' }, 'Smatchet', names, 'Rob')).toBe('## Smatchet\n\nHello');
    expect(archiveTurnText({ role: 'agent', content: 'Unknown', metadata: { fromAgentId: 'new-goblin' } }, 'Smatchet', names, 'Rob')).toBe('## new-goblin\n\nUnknown');
    expect(archiveTurnText({ role: 'assistant', content: 'Anonymous' }, '', new Map(), '')).toBe('## Agent\n\nAnonymous');
  });

  it('attributes delegated user turns to their parent agent when identified', () => {
    expect(archiveTurnText({ role: 'user', content: 'Task', metadata: { parentAgentId: 'hatchet' } }, 'Minion', names, 'Rob')).toBe('## Hatchet\n\nTask');
  });
});
