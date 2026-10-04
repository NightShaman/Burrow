import { beforeEach, vi } from 'vitest';
const deny = () => { throw new Error('UI test isolation: real network denied'); };
beforeEach(() => {
  vi.stubGlobal('fetch', deny);
  vi.stubGlobal('WebSocket', deny);
  vi.stubGlobal('EventSource', deny);
  XMLHttpRequest.prototype.open = deny;
});
