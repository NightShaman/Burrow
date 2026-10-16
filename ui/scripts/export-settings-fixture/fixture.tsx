import React from 'react';
import { createRoot } from 'react-dom/client';
import { ConfirmProvider } from '../../src/app/ConfirmDialog';
import { ExportSettings } from '../../src/features/settings/ExportSettings';
import catalog from './catalog.json';
import '../../src/app.css';
// Fixture responses only. CSP blocks real API/network calls.
const requests: { path: string; body: Record<string, unknown> }[] = [];
(window as any).fixtureRequests = requests;
window.fetch = (async (url: string | URL | Request, options?: RequestInit) => {
  const path = String(url), body = options?.body ? JSON.parse(String(options.body)) : {};
  requests.push({ path, body });
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
  if (path === '/api/export/catalog') return json(catalog);
  if (path === '/api/export') return new Response('fixture bundle, not actual encrypted content', { headers: { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="fixture.bin"' } });
  if (path === '/api/export/import/preview') {
    if (body.password !== 'fixture-only-password') return json({ error: 'import_password_required' }, 400);
    return json({ encrypted: true, supported: ['settings', 'agents', 'skills', 'scheduled-jobs'], unsupported: [] });
  }
  if (path === '/api/export/import') return json({ ok: true });
  throw new Error(`Unexpected fixture request ${path}`);
}) as typeof fetch;
createRoot(document.getElementById('root')!).render(<ConfirmProvider>
  <main className="settings-blank-slate" aria-label="Settings layout prototype">
    <nav className="settings-blank-column settings-prototype-menu"><button aria-current="page">General</button></nav>
    <section className="settings-blank-column settings-prototype-sections"><button aria-current="page">Export</button></section>
    <section className="settings-blank-column settings-prototype-configuration"><ExportSettings /></section>
    <section className="settings-blank-column settings-prototype-overflow" aria-label="Additional settings" />
  </main>
</ConfirmProvider>);
