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

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll } from 'vitest';
import { useState } from 'react';
import { ChatComposer } from './ChatComposer';

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return 320; } });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return 300; } });
  globalThis.IntersectionObserver = class implements IntersectionObserver {
    constructor(private callback: IntersectionObserverCallback) {}
    readonly root = null;
    readonly rootMargin = '0px';
    readonly thresholds = [0];
    observe(target: Element) {
      this.callback([{ target, intersectionRatio: 1, isIntersecting: true } as IntersectionObserverEntry], this);
    }
    unobserve() {}
    disconnect() {}
    takeRecords() { return []; }
  };
});
afterEach(cleanup);
function ComposerFixture({ initial = '' }: { initial?: string }) {
  const [draft, setDraft] = useState(initial);
  return <ChatComposer draft={draft} setDraft={setDraft} attached={[]} onAttach={() => {}} onRemoveAttachment={() => {}} onSend={() => {}} placeholder="Message…" />;
}

describe('composer emoji picker', () => {
  it('inserts at cursor, replaces a selection and restores focus without sending', async () => {
    render(<ComposerFixture initial="Hello world" />);
    const message = screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement;
    message.focus();
    message.setSelectionRange(6, 11);
    fireEvent.select(message);
    fireEvent.click(screen.getByRole('button', { name: 'Insert emoji' }));
    expect(screen.getByRole('button', { name: 'Insert emoji' }).getAttribute('aria-expanded')).toBe('true');
    const search = await screen.findByRole('textbox', { name: 'Type to search for an emoji' });
    fireEvent.change(search, { target: { value: 'grinning face' } });
    fireEvent.click(await screen.findByRole('button', { name: 'grinning face' }));
    expect(message.value).toBe('Hello 😀');
    expect(document.activeElement).toBe(message);
    expect(message.selectionStart).toBe('Hello 😀'.length);
    expect(screen.queryByRole('textbox', { name: 'Type to search for an emoji' })).toBeNull();
  });
  it('can insert another emoji and close without changing the draft', async () => {
    render(<ComposerFixture initial="Hi" />);
    const message = screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement;
    message.focus(); message.setSelectionRange(2, 2); fireEvent.select(message);
    fireEvent.click(screen.getByRole('button', { name: 'Insert emoji' }));
    const purpleSearch = await screen.findByRole('textbox', { name: 'Type to search for an emoji' });
    fireEvent.change(purpleSearch, { target: { value: 'purple heart' } });
    fireEvent.click(await screen.findByRole('button', { name: 'purple heart' }));
    fireEvent.click(screen.getByRole('button', { name: 'Insert emoji' }));
    const middleSearch = await screen.findByRole('textbox', { name: 'Type to search for an emoji' });
    fireEvent.change(middleSearch, { target: { value: 'middle finger' } });
    fireEvent.click(await screen.findByRole('button', { name: 'middle finger' }));
    expect(message.value).toBe('Hi💜🖕');
    fireEvent.click(screen.getByRole('button', { name: 'Insert emoji' }));
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Type to search for an emoji' }), { key: 'Escape' });
    expect(screen.queryByRole('textbox', { name: 'Type to search for an emoji' })).toBeNull();
    expect(document.activeElement).toBe(message);
    expect(message.value).toBe('Hi💜🖕');
  });
  it('closes when clicking outside without clearing the draft', async () => {
    render(<ComposerFixture initial="Still here" />);
    fireEvent.click(screen.getByRole('button', { name: 'Insert emoji' }));
    await screen.findByRole('textbox', { name: 'Type to search for an emoji' });
    fireEvent.pointerDown(document.body);
    await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Type to search for an emoji' })).toBeNull());
    expect((screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement).value).toBe('Still here');
  });
});
