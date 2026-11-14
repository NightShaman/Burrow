import React from 'react';
import { createRoot } from 'react-dom/client';
import '../../src/app.css';
import { ConfirmProvider } from '../../src/app/ConfirmDialog';
import { Forge } from '../../src/features/forge/ForgePage';
import { gallerySamples, gallerySampleFolders, gallerySamplePlacements } from './samples';
// Isolated API simulator. No generation, real images or backend changes.
const seed = {
  folders: gallerySampleFolders.map((f) => ({ id: f.id, name: f.name, parentId: f.parent })),
  images: gallerySamples.map((p) => ({
    jobId: p.id,
    artifactId: p.id,
    folderId: gallerySamplePlacements[p.id] ?? null,
    artifact: {
      id: p.id,
      kind: 'image',
      name: p.name,
      mimeType: 'image/svg+xml',
      sizeBytes: 200,
      previewUrl: `/fixture/${p.id}`,
      downloadUrl: `/fixture/${p.id}`,
    },
  })),
};
let catalog = JSON.parse(sessionStorage.getItem('gallery-fixture') || 'null') || seed;
const json = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), { status, headers: { 'Content-Type': 'application/json' } });
const requests: unknown[] = [];
Object.assign(window, { galleryRequests: requests });
const nativeFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  if (new URLSearchParams(location.search).has('integrated')) return nativeFetch(input, init);
  const path = new URL(String(input), location.origin).pathname;
  const method = init?.method || 'GET';
  requests.push({ path, method, body: init?.body });
  if (path.startsWith('/fixture/')) {
    const p = gallerySamples.find((p) => path.endsWith(p.id))!;
    return new Response(decodeURIComponent(p.src.split(',')[1]), {
      headers: { 'Content-Type': 'image/svg+xml' },
    });
  }
  if (path === '/api/forge/gallery') {
    if (new URLSearchParams(location.search).has('error')) return json({ error: 'offline' }, 503);
    return json(catalog);
  }
  if (path === '/api/forge/gallery/folders') {
    const body = JSON.parse(String(init?.body));
    const folder = { id: crypto.randomUUID(), ...body };
    catalog.folders.push(folder);
    sessionStorage.setItem('gallery-fixture', JSON.stringify(catalog));
    return json({ folder }, 201);
  }
  if (path.startsWith('/api/forge/gallery/images/')) {
    const id = path.split('/').pop();
    const body = JSON.parse(String(init?.body));
    catalog.images.find((p: { artifactId: string }) => p.artifactId === id).folderId =
      body.folderId;
    sessionStorage.setItem('gallery-fixture', JSON.stringify(catalog));
    return json({ ok: true });
  }
  if (path === '/api/forge/catalog') return json({ models: [], music: { models: [] } });
  if (path === '/api/forge/jobs') return json({ jobs: [] });
  if (path === '/api/forge/selections') return json({ selections: {} });
  return json({});
};
createRoot(document.getElementById('root')!).render(
  <ConfirmProvider>
    <div style={{ height: '100dvh', padding: 16, boxSizing: 'border-box', display: 'block' }}>
      <Forge agents={[]} selectedAgentId="smatchet" sessionId="gallery-test" />
    </div>
  </ConfirmProvider>,
);
