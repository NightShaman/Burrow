import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '../../app/types';
import { Forge } from './ForgePage';

const apiMock = vi.hoisted(() => vi.fn());
const fetchApiMock = vi.hoisted(() => vi.fn());
vi.mock('../../app/api', () => ({ api: apiMock, fetchApi: fetchApiMock }));

const agent = { id: 'agent-a', name: 'Smatchet' } as Agent;
const catalog = { music: { available: false, reason: 'music_model_not_configured' }, models: [{ connectionId: 'c1', modelId: 'image-1', label: 'Image One', kind: 'image', available: true, controls: [] }, { connectionId: 'c2', modelId: 'video-1', label: 'Video One', kind: 'video', available: false, unavailableReason: 'video_disabled', controls: [] }], video: { available: false, reason: 'video_disabled' }, sourceAttachments: { available: false, reason: 'unsupported' } };

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
