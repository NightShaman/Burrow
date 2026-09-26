import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '../../app/types';
import { composeMusicPrompt, Forge } from './ForgePage';

const apiMock = vi.hoisted(() => vi.fn());
const fetchApiMock = vi.hoisted(() => vi.fn());
vi.mock('../../app/api', () => ({ api: apiMock, fetchApi: fetchApiMock }));

const agent = { id: 'agent-a', name: 'Smatchet' } as Agent;
const catalog = { music: { available: false, reason: 'music_model_not_configured', models: [] }, models: [{ connectionId: 'c1', modelId: 'image-1', label: 'Image One', kind: 'image', available: true, controls: [] }, { connectionId: 'c2', modelId: 'video-1', label: 'Video One', kind: 'video', available: false, unavailableReason: 'video_disabled', controls: [] }], video: { available: false, reason: 'video_disabled' }, sourceAttachments: { available: false, reason: 'unsupported' } };

function renderForge(initialJobs: unknown[] = []) {
  apiMock.mockImplementation((path: string, init?: RequestInit) => {
    if (path === '/api/forge/catalog') return Promise.resolve(catalog);
    if (init?.method === 'POST') return Promise.resolve({ job: { id: 'job-1', connectionId: 'c1', modelId: 'image-1', kind: 'image', prompt: 'a castle', status: 'queued', createdAt: '2026-09-27T00:00:00Z', updatedAt: '2026-09-27T00:00:00Z', artifacts: [] } });
    if (path === '/api/forge/jobs') return Promise.resolve({ jobs: initialJobs });
    return Promise.resolve({});
  });
  return render(<Forge agents={[agent]} selectedAgentId="agent-a" sessionId="session-1" />);
}

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('Forge workspace', () => {
  it('switches modes and keeps unavailable video honest', async () => {
    renderForge();
    await screen.findByRole('option', { name: 'Image One' });
    fireEvent.click(screen.getByRole('tab', { name: /Video/ }));
    expect(screen.getByText('Video generation is unavailable')).toBeTruthy();
    expect(screen.getByText('video_disabled')).toBeTruthy();
    expect(screen.getByText(/Source attachments: unavailable/)).toBeTruthy();
  });

  it('keeps Music honest and never offers generation', async () => {
    renderForge();
    await screen.findByRole('option', { name: 'Image One' });
    fireEvent.click(screen.getByRole('tab', { name: /Music/ }));
    expect(screen.getByText('No music model configured')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Generate Music' })).toBeNull();
  });


  it('selects Lyria music models separately from Speech and submits music generation', async () => {
    const musicCatalog = { ...catalog, music: { available: true, reason: null, models: [{ connectionId: 'g1', modelId: 'lyria', label: 'Lyria', kind: 'audio', available: true, controls: [] }] }, models: [...catalog.models, { connectionId: 's1', modelId: 'speech', label: 'Speech', kind: 'audio', available: true, controls: [] }] };
    apiMock.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/forge/catalog') return Promise.resolve(musicCatalog);
      if (init?.method === 'POST') return Promise.resolve({ job: { id: 'music-1', connectionId: 'g1', modelId: 'lyria', kind: 'music', prompt: 'a bright synth line', status: 'queued', createdAt: '2026-09-27T00:00:00Z', updatedAt: '2026-09-27T00:00:00Z', artifacts: [] } });
      if (path === '/api/forge/jobs') return Promise.resolve({ jobs: [] });
      return Promise.resolve({});
    });
    render(<Forge selectedAgentId="agent-a" sessionId="session-1" />);
    await screen.findByRole('option', { name: 'Image One' });
    fireEvent.click(screen.getByRole('tab', { name: /Music/ }));
    expect(screen.getByRole('option', { name: 'Lyria' })).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox', { name: 'Musical direction' }), { target: { value: 'a bright synth line' } });
    fireEvent.click(screen.getByRole('button', { name: 'Generate Music' }));
    await waitFor(() => expect(screen.getByText('Forge job accepted.')).toBeTruthy());
    fireEvent.click(screen.getByRole('tab', { name: /Speech/ }));
    expect(screen.queryByRole('option', { name: 'Lyria' })).toBeNull();
    expect(screen.getByRole('option', { name: 'Speech' })).toBeTruthy();
  });

  it('composes optional music lyrics into the submitted prompt and keeps empty lyrics unchanged', async () => {
    expect(composeMusicPrompt(' bright synth line ', '')).toBe('bright synth line');
    expect(composeMusicPrompt('bright synth line', 'verse one')).toContain('--- Supplied lyrics');
    const musicCatalog = { ...catalog, music: { available: true, reason: null, models: [{ connectionId: 'g1', modelId: 'lyria', label: 'Lyria', kind: 'audio', available: true, controls: [] }] } };
    apiMock.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/forge/catalog') return Promise.resolve(musicCatalog);
      if (init?.method === 'POST') return Promise.resolve({ job: { id: 'music-lyrics', connectionId: 'g1', modelId: 'lyria', kind: 'music', prompt: 'dreamy synth pop', status: 'queued', createdAt: '2026-09-27T00:00:00Z', updatedAt: '2026-09-27T00:00:00Z', artifacts: [] } });
      if (path === '/api/forge/jobs') return Promise.resolve({ jobs: [] });
      return Promise.resolve({});
    });
    render(<Forge selectedAgentId="agent-a" sessionId="session-1" />);
    await screen.findByRole('option', { name: 'Image One' });
    fireEvent.click(screen.getByRole('tab', { name: /Music/ }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Musical direction' }), { target: { value: 'dreamy synth pop' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Lyrics' }), { target: { value: 'Shine through the night' } });
    fireEvent.click(screen.getByRole('button', { name: 'Generate Music' }));
    await waitFor(() => expect(screen.getByText('Forge job accepted.')).toBeTruthy());
    const request = apiMock.mock.calls.find(([path, init]) => path === '/api/forge/jobs' && init?.method === 'POST');
    expect(request).toBeTruthy();
    const body = JSON.parse(request![1].body as string);
    expect(body.prompt).toContain('Shine through the night');
    expect(body.idempotencyKey).toBeTruthy();
  });

  it('submits prompt-only generation and shows accepted job', async () => {
    renderForge();
    const prompt = await screen.findByRole('textbox', { name: 'Prompt' });
    fireEvent.change(prompt, { target: { value: 'a castle' } });
    fireEvent.click(screen.getByRole('button', { name: 'Generate Image' }));
    await waitFor(() => expect(screen.getByText('Forge job accepted.')).toBeTruthy());
    expect(apiMock).toHaveBeenCalledWith('/api/forge/jobs', expect.objectContaining({ method: 'POST' }));
    expect(screen.getAllByText('queued').length).toBeGreaterThan(0);
  });

  it('uses authenticated transport for artifact previews and downloads', async () => {
    const job = { id: 'job-2', connectionId: 'c1', modelId: 'image-1', kind: 'image', prompt: 'castle', status: 'succeeded', createdAt: '2026-09-27T00:00:00Z', updatedAt: '2026-09-27T00:00:00Z', artifacts: [{ id: 'artifact-1', kind: 'image', name: 'castle.png', mimeType: 'image/png', sizeBytes: 10, previewUrl: '/protected/preview', downloadUrl: '/protected/download' }] };
    fetchApiMock.mockResolvedValue(new Response(new Blob(['x'], { type: 'image/png' }), { status: 200 }));
    renderForge([job]);
    await screen.findByText('castle.png');
    await waitFor(() => expect(fetchApiMock).toHaveBeenCalled());
    expect(fetchApiMock.mock.calls.map(([path]) => path)).toEqual(expect.arrayContaining(['/protected/preview', '/protected/download']));
  });
});
