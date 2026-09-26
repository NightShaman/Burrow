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
  it('restores per-mode selections, saves only explicit changes, and retains work across agents and remounts', async () => {
    const second = { ...catalog.models[0], modelId: 'image-2', label: 'Image Two' };
    const speech = { ...second, modelId: 'voice', kind: 'audio', label: 'Voice' };
    let selections = { image: { connectionId: 'c1', modelId: 'image-2' }, speech: { connectionId: 'c1', modelId: 'voice' } };
    let finishSave: (() => void) | undefined;
    apiMock.mockImplementation((path: string, init?: RequestInit) => {
      if (path.endsWith('/catalog')) return Promise.resolve({ ...catalog, models: [...catalog.models, second, speech] });
      if (path.endsWith('/selections')) {
        if (init?.method === 'PUT') return new Promise((resolve) => { finishSave = () => {
          const { mode, ...selection } = JSON.parse(init.body as string);
          selections = { ...selections, [mode]: selection };
          resolve({ selections });
        }; });
        return Promise.resolve({ selections });
      }
      return Promise.resolve({ jobs: [] });
    });
    const view = render(<Forge selectedAgentId="a" sessionId="s" />);
    const select = await screen.findByRole('combobox', { name: 'Forge model' }) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe(JSON.stringify(['c1', 'image-2'])));
    expect(apiMock.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(0);
    fireEvent.change(screen.getByRole('textbox', { name: 'Prompt' }), { target: { value: 'keep my draft' } });
    fireEvent.change(select, { target: { value: JSON.stringify(['c1', 'image-1']) } });
    expect(select.disabled).toBe(true);
    fireEvent.click(screen.getByRole('tab', { name: /Speech/ }));
    expect(select.value).toBe(JSON.stringify(['c1', 'voice']));
    finishSave!();
    await waitFor(() => expect(select.disabled).toBe(false));
    view.rerender(<Forge selectedAgentId="b" sessionId="s2" />);
    fireEvent.click(screen.getByRole('tab', { name: /Image/ }));
    expect(select.value).toBe(JSON.stringify(['c1', 'image-1']));
    expect((screen.getByRole('textbox', { name: 'Prompt' }) as HTMLTextAreaElement).value).toBe('keep my draft');
    view.unmount();
    render(<Forge selectedAgentId="b" sessionId="s2" />);
    await waitFor(() => expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe(JSON.stringify(['c1', 'image-1'])));
  });

  it('does not fall back from an unavailable saved model and reports failed saves', async () => {
    apiMock.mockImplementation((path: string, init?: RequestInit) => {
      if (path.endsWith('/catalog')) return Promise.resolve(catalog);
      if (path.endsWith('/selections')) return init?.method === 'PUT'
        ? Promise.reject(new Error('offline'))
        : Promise.resolve({ selections: { image: { connectionId: 'gone', modelId: 'missing' } } });
      return Promise.resolve({ jobs: [] });
    });
    render(<Forge selectedAgentId="a" sessionId="s" />);
    await screen.findByText(/Saved model unavailable/);
    fireEvent.change(screen.getByRole('textbox', { name: 'Prompt' }), { target: { value: 'castle' } });
    expect((screen.getByRole('button', { name: 'Generate Image' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: JSON.stringify(['c1', 'image-1']) } });
    await screen.findByText(/Could not save model selection: offline/);
    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe(JSON.stringify(['gone', 'missing']));
  });

  it('keeps modes in the header and long history alongside the studio', async () => {
    const jobs = Array.from({ length: 30 }, (_, i) => ({ id: `layout-${i}`, kind: 'music', prompt: 'Long music direction '.repeat(20), status: 'succeeded', createdAt: '2026-09-26T12:00:00Z', artifacts: [] }));
    renderForge(jobs);
    await screen.findByRole('option', { name: 'Image One' });
    fireEvent.click(screen.getByRole('tab', { name: /Music/ }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Lyrics' }), { target: { value: 'Long lyrics\n'.repeat(100) } });
    expect(screen.getByRole('tablist').closest('header')).toBeTruthy();
    expect(screen.queryByText('FORGE')).toBeNull();
    expect(screen.getByRole('heading', { name: 'Recent creations' }).closest('.forge-history')?.parentElement?.className).toBe('forge-grid');
  });

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
    fetchApiMock.mockResolvedValue(new Response(new Uint8Array([120]), { status: 200, headers: { 'content-type': 'image/png' } }));
    renderForge([job]);
    await screen.findByText('castle.png');
    await waitFor(() => expect(fetchApiMock).toHaveBeenCalled());
    expect(fetchApiMock.mock.calls.map(([path]) => path)).toEqual(expect.arrayContaining(['/protected/preview', '/protected/download']));
  });
});
