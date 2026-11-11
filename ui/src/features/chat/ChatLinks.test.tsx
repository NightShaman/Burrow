import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { ChatMessage } from './ChatMessage';

afterEach(cleanup);

it.each(['agent', 'operator'] as const)('opens %s chat links in a new tab', (side) => {
  render(
    <ChatMessage
      side={side}
      name="Smatchet"
      avatar="S"
      time="Now"
      text={
        '[CODEX](https://example.com/codex "Goblin CODEX")\n\nhttps://example.com/plain\n\n[Local](/local)\n\n`https://example.com/code`'
      }
    />,
  );
  const links = screen.getAllByRole('link');
  expect(links).toHaveLength(3);
  for (const link of links) {
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
  }
  expect(links.map((link) => link.getAttribute('href'))).toEqual([
    'https://example.com/codex',
    'https://example.com/plain',
    '/local',
  ]);
  expect(screen.getByRole('link', { name: 'CODEX' }).getAttribute('title')).toBe('Goblin CODEX');
  expect(screen.getByText('https://example.com/code').tagName).toBe('CODE');
});
