import { beforeEach, vi } from 'vitest';
const deny = () => { throw new Error('UI test isolation: real network denied'); };
beforeEach(() => {
  // Vitest uses its own config, so Vite's build-time identity define is absent.
  // Keep this overridable by provenance tests and reset it for every test.
  vi.stubGlobal('__BURROW_UI_BUILD_IDENTITY__', 'development');
  vi.stubGlobal('fetch', deny);
  vi.stubGlobal('WebSocket', deny);
  vi.stubGlobal('EventSource', deny);
  XMLHttpRequest.prototype.open = deny;
});
