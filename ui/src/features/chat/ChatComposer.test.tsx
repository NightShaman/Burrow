import { describe, expect, it } from 'vitest';
import { isProjectContextDraft, projectContextQuery } from './ChatComposer';

describe('project conversation context syntax', () => {
  it.each([
    ['$project', ''],
    ['$project design', 'design'],
    ['$PROJECT   Design notes  ', 'Design notes'],
    ['$project clear', 'clear'],
  ])('recognizes %s without treating it as a chat message', (value, query) => {
    expect(isProjectContextDraft(value)).toBe(true);
    expect(projectContextQuery(value)).toBe(query);
  });

  it.each(['project', '/project design', 'hello $project', '$project-design'])('does not recognize %s as project context', (value) => {
    expect(isProjectContextDraft(value)).toBe(false);
    expect(projectContextQuery(value)).toBeNull();
  });
});
