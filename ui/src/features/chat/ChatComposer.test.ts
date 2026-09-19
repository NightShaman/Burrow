import { describe, expect, it } from 'vitest';
import type { SessionTurn } from '../../app/api';
import { formatConversationCopy } from './ChatComposer';

const turn = (role: string, content: string, metadata?: SessionTurn['metadata']): SessionTurn => ({ role, content, metadata, ts: '2026-09-19T12:00:00.000Z' });

describe('conversation copy attribution', () => {
  it('uses each group turn speaker instead of labeling every response Assistant', () => {
    const value = formatConversationCopy([
      turn('user', 'Hello everyone'),
      turn('assistant', 'Hatchet answer', { fromAgentId: 'hatchet' }),
      turn('assistant', 'Smatchet answer', { fromAgentName: 'Smatchet', fromAgentId: 'smatchet' }),
      turn('assistant', 'Unknown answer', { fromAgentId: 'new-goblin' }),
    ], {
      operatorName: 'Goblin King',
      agentNames: new Map([['hatchet', 'Hatchet']]),
    });

    expect(value).toContain('Goblin King —');
    expect(value).toContain('Hatchet —');
    expect(value).toContain('Smatchet —');
    expect(value).toContain('new-goblin —');
    expect(value).not.toContain('Assistant —');
  });

  it('uses the selected agent for ordinary chat and preserves fenced code', () => {
    const value = formatConversationCopy([
      turn('user', 'Show me'),
      turn('assistant', '```ts\nconst answer = 42;\n```'),
    ], { assistantName: 'Smatchet', operatorName: 'Rob' });

    expect(value).toContain('Rob —');
    expect(value).toContain('Smatchet —');
    expect(value).toContain('```ts\nconst answer = 42;\n```');
  });

  it('attributes delegated user-role turns to their parent agent', () => {
    const value = formatConversationCopy([
      turn('user', 'Delegated request', { parentAgentId: 'hatchet' }),
    ], { operatorName: 'Rob', agentNames: new Map([['hatchet', 'Hatchet']]) });

    expect(value).toContain('Hatchet —');
    expect(value).not.toContain('Rob —');
  });
});
