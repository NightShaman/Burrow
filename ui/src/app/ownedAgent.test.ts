import { describe, expect, it } from 'vitest';
import { ownedAgentResource } from './ownedAgent';
import type { Agent } from './types';
const targets = ['a', 'local', 'b'].map(id => ({ id, name: id, baseUrl: id === 'local' ? '' : `https://${id}.invalid`, enabled: true }));
const agents = targets.map(target => ({ id: target.id === 'local' ? 'same' : `${target.id}::same`, targetId: target.id, resourceId: 'same' } as Agent));
describe('captured agent ownership', () => {
  it.each(targets)('resolves same raw ID only for owner $id', target => {
    const agent = agents.find(a => a.targetId === target.id)!;
    expect(ownedAgentResource(agents, agent.id, target)).toBe('same');
    for (const other of agents.filter(a => a !== agent)) expect(() => ownedAgentResource(agents, other.id, target)).toThrow();
  });
  it('fails closed for unknown, missing resource, and unavailable owner', () => {
    expect(() => ownedAgentResource(agents, 'unknown', targets[0])).toThrow();
    expect(() => ownedAgentResource([{ id: 'a::same', targetId: 'a' } as Agent], 'a::same', targets[0])).toThrow();
    expect(() => ownedAgentResource(agents, 'a::same', null)).toThrow();
  });
});
