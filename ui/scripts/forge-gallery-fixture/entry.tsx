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
const references = new URLSearchParams(location.search).has('references');
const referenceImages = [
  { id: 'eligible', name: 'Neon skyline.png', mimeType: 'image/png', sizeBytes: 2048 },
  { id: 'gif', name: 'Animated skyline.gif', mimeType: 'image/gif', sizeBytes: 2048 },
  {
    id: 'large',
    name: 'Oversized skyline.png',
    mimeType: 'image/png',
    sizeBytes: 21 * 1024 * 1024,
  },
  { id: 'video', name: 'Skyline video.webm', mimeType: 'video/webm', sizeBytes: 2048 },
].map((item) => ({
  jobId: `job-${item.id}`,
  artifactId: item.id,
  folderId: null,
  artifact: {
    ...item,
    kind: item.id === 'video' ? 'video' : 'image',
    previewUrl: `/reference-fixture/${item.id}`,
    downloadUrl: `/reference-fixture/${item.id}`,
  },
}));
const referenceJobs = referenceImages.map((image) => ({
  id: image.jobId,
  kind: image.artifact.kind,
  status: 'succeeded',
  connectionId: 'fixture',
  modelId: 'fixture',
  prompt: image.artifact.name,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  artifacts: [image.artifact],
}));
if (references) seed.images = referenceImages;
let catalog =
  JSON.parse(
    sessionStorage.getItem(references ? 'gallery-reference-fixture' : 'gallery-fixture') || 'null',
  ) || seed;
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
  if (path.startsWith('/reference-fixture/')) {
    const canvas = document.createElement('canvas');
    canvas.width = 700;
    canvas.height = 460;
    const context = canvas.getContext('2d')!;
    const image = new Image();
    image.src = gallerySamples[0].src;
    await image.decode();
    context.drawImage(image, 0, 0);
    if (path.endsWith('video')) {
      const stream = canvas.captureStream(5);
      const recorder = new MediaRecorder(stream, { mimeType: 'video/webm' });
      const chunks: Blob[] = [];
      const recorded = new Promise<Blob>((resolve) => {
        recorder.ondataavailable = (event) => chunks.push(event.data);
        recorder.onstop = () => resolve(new Blob(chunks, { type: 'video/webm' }));
      });
      recorder.start();
      await new Promise((resolve) => setTimeout(resolve, 300));
      recorder.stop();
      const video = await recorded;
      stream.getTracks().forEach((track) => track.stop());
      return new Response(video, { headers: { 'Content-Type': 'video/webm' } });
    }
    const blob = await new Promise<Blob>((resolve) => canvas.toBlob((blob) => resolve(blob!)));
    return new Response(blob, { headers: { 'Content-Type': 'image/png' } });
  }
  if (references && path.endsWith('/attach')) {
    if (new URLSearchParams(location.search).has('attachError'))
      return json({ error: 'fixture attach failed' }, 503);
    return json({ ok: true });
  }
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
    sessionStorage.setItem(
      references ? 'gallery-reference-fixture' : 'gallery-fixture',
      JSON.stringify(catalog),
    );
    return json({ folder }, 201);
  }
  if (path.startsWith('/api/forge/gallery/images/')) {
    const id = path.split('/').pop();
    if (method === 'DELETE') {
      catalog.images = catalog.images.filter((p: { artifactId: string }) => p.artifactId !== id);
      sessionStorage.setItem(
        references ? 'gallery-reference-fixture' : 'gallery-fixture',
        JSON.stringify(catalog),
      );
      return json({ ok: true });
    }
    const body = JSON.parse(String(init?.body));
    catalog.images.find((p: { artifactId: string }) => p.artifactId === id).folderId =
      body.folderId;
    sessionStorage.setItem(
      references ? 'gallery-reference-fixture' : 'gallery-fixture',
      JSON.stringify(catalog),
    );
    return json({ ok: true });
  }
  if (path === '/api/forge/catalog')
    return json({
      models: references
        ? [
            {
              connectionId: 'fixture',
              modelId: 'image',
              label: 'Fixture Image',
              kind: 'image',
              available: true,
              controls: [],
            },
            {
              connectionId: 'fixture',
              modelId: 'video',
              label: 'Fixture Video',
              kind: 'video',
              available: true,
              controls: [],
              referenceArtifacts: { available: true, maxImages: 6 },
            },
          ]
        : [],
      music: { models: [] },
    });
  if (path === '/api/forge/jobs') return json({ jobs: references ? referenceJobs : [] });
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
