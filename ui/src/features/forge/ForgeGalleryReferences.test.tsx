import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfirmProvider } from '../../app/ConfirmDialog';
import { Forge } from './ForgePage';

const { api, fetchApi } = vi.hoisted(() => ({ api: vi.fn(), fetchApi: vi.fn() }));
vi.mock('../../app/api', () => ({ api, fetchApi }));
const artifact = {
  id: 'gallery-artifact',
  kind: 'image',
  name: 'Old portrait.png',
  mimeType: 'image/png',
  sizeBytes: 1024,
  previewUrl: '/preview',
  downloadUrl: '/download',
};
const job = {
  id: 'gallery-job',
  connectionId: 'c',
  modelId: 'image',
  kind: 'image',
  status: 'succeeded',
  prompt: 'An old portrait',
  createdAt: '2020-01-01T00:00:00Z',
  updatedAt: '2020-01-01T00:00:00Z',
  artifacts: [artifact],
};
let attachFails: boolean;
let posts: { path: string; body: any }[];
let copy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  attachFails = false;
  posts = [];
  vi.stubGlobal(
    'URL',
    Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:fixture'), revokeObjectURL: vi.fn() }),
  );
  fetchApi.mockImplementation(async () => ({ ok: true, blob: async () => new Blob(['image']) }));
  copy = vi.fn(() => true);
  Object.defineProperty(document, 'execCommand', { value: copy, configurable: true });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});
async function setup({
  media = {},
  source = {},
  capability = true,
  available = true,
  sessionId = 'conversation',
  count = 1,
} = {}) {
  const image = { ...artifact, ...media };
  const sourceJob = { ...job, ...source, artifacts: [image] };
  const sources = Array.from({ length: count }, (_, i) => ({
    ...sourceJob,
    id: i ? `gallery-job-${i}` : job.id,
    artifacts: [
      {
        ...image,
        id: i ? `gallery-artifact-${i}` : image.id,
        name: i ? `Portrait ${i}.png` : image.name,
      },
    ],
  }));
  api.mockImplementation(async (path: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      posts.push({ path, body: JSON.parse(String(init.body)) });
      if (path.endsWith('/attach')) {
        if (attachFails) throw Error('attach unavailable');
        return { ok: true };
      }
      return { job: { ...sourceJob, id: 'generated', artifacts: [] } };
    }
    if (path.endsWith('/catalog'))
      return {
        models: [
          {
            connectionId: 'c',
            modelId: 'image',
            kind: 'image',
            label: 'Image',
            available: true,
            controls: [],
          },
          {
            connectionId: 'c',
            modelId: 'video',
            kind: 'video',
            label: 'Video',
            available,
            controls: [],
            referenceArtifacts: { available: capability, maxImages: 6 },
          },
        ],
      };
    if (path.endsWith('/selections')) return { selections: {} };
    if (path.endsWith('/gallery'))
      return {
        folders: [],
        images: sources.map((item) => ({
          jobId: item.id,
          artifactId: item.artifacts[0].id,
          artifact: item.artifacts[0],
          folderId: null,
        })),
      };
    // An unrelated current output must never supply the Gallery action identity.
    return {
      jobs: [
        {
          ...job,
          id: 'unrelated',
          prompt: 'Unrelated current output',
          createdAt: new Date().toISOString(),
          artifacts: [],
        },
        ...sources,
      ],
    };
  });
  render(
    <ConfirmProvider>
      <Forge selectedAgentId="smatchet" sessionId={sessionId} />
    </ConfirmProvider>,
  );
  await waitFor(() =>
    expect(screen.getByLabelText('Forge model').hasAttribute('disabled')).toBe(false),
  );
  fireEvent.click(screen.getByRole('tab', { name: /Recents/i }));
  expect(screen.queryByRole('button', { name: 'Image succeeded: An old portrait' })).toBeNull();
  fireEvent.click(screen.getByRole('tab', { name: /Gallery/i }));
  fireEvent.click(await screen.findByRole('button', { name: `Enlarge ${image.name}` }));
  return within(screen.getByRole('dialog'));
}

describe('Gallery full-size media actions', () => {
  it('copies the selected Gallery identity inside the focus-trapped viewer and reports failure/retry', async () => {
    const viewer = await setup();
    copy.mockImplementation(() => {
      const text = screen.getByRole('dialog').querySelector('textarea');
      expect(text?.value).toBe('[forge:gallery-job:gallery-artifact]');
      return true;
    });
    fireEvent.click(viewer.getByRole('button', { name: 'Copy reference' }));
    await viewer.findByText('Reference copied.');
    copy.mockReturnValue(false);
    fireEvent.click(viewer.getByRole('button', { name: 'Copy reference' }));
    await viewer.findByRole('alert');
    copy.mockReturnValue(true);
    fireEvent.click(viewer.getByRole('button', { name: 'Copy reference' }));
    await waitFor(() => expect(viewer.queryByRole('alert')).toBeNull());
  });
  it('attaches exact Gallery artifact to current conversation, retaining viewer and showing failures', async () => {
    const viewer = await setup();
    attachFails = true;
    fireEvent.click(viewer.getByRole('button', { name: 'Attach to conversation' }));
    await viewer.findByText('Could not attach artifact: attach unavailable');
    attachFails = false;
    fireEvent.click(viewer.getByRole('button', { name: 'Attach to conversation' }));
    await viewer.findByText('Attached to the current conversation.');
    expect(posts[1]).toEqual({
      path: '/api/forge/jobs/gallery-job/attach',
      body: { agentId: 'smatchet', sessionId: 'conversation', artifactId: 'gallery-artifact' },
    });
    expect(viewer.queryByRole('alert')).toBeNull();
  });
  it('opens Video with old Gallery source selected, deduplicates and submits through existing handler', async () => {
    const viewer = await setup();
    fireEvent.click(viewer.getByRole('button', { name: 'Use as video reference' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('tab', { name: /Video/i }).getAttribute('aria-selected')).toBe('true');
    await screen.findByRole('button', { name: 'Remove Old portrait.png reference' });
    fireEvent.click(screen.getByRole('tab', { name: /Gallery/i }));
    fireEvent.click(await screen.findByRole('button', { name: 'Enlarge Old portrait.png' }));
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Use as video reference' }),
    );
    expect(
      screen.getAllByRole('button', { name: 'Remove Old portrait.png reference' }),
    ).toHaveLength(1);
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'Animate' } });
    fireEvent.click(screen.getByRole('button', { name: 'Generate Video' }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0].body.referenceArtifacts).toEqual([
      { jobId: 'gallery-job', artifactId: 'gallery-artifact' },
    ]);
  });
  it.each([
    { media: { mimeType: 'image/gif' }, copy: true },
    { media: { mimeType: 'image/svg+xml' }, copy: false },
    { media: { sizeBytes: 20 * 1024 * 1024 + 1 }, copy: false },
    { media: { sizeBytes: 0 }, copy: true },
    { source: { status: 'failed' }, copy: true },
    { source: { kind: 'video' }, copy: true },
    { capability: false, copy: true },
    { available: false, copy: true },
  ])('keeps established eligibility for %j', async ({ copy: canCopy, ...options }) => {
    const viewer = await setup(options);
    expect(viewer.queryByRole('button', { name: 'Use as video reference' })).toBeNull();
    expect(!!viewer.queryByRole('button', { name: 'Copy reference' })).toBe(canCopy);
    expect(viewer.getByRole('button', { name: 'Attach to conversation' })).toBeTruthy();
  });
  it('keeps the seventh source viewer open on limit rejection and allows an existing source', async () => {
    let viewer = await setup({ count: 7 });
    fireEvent.click(viewer.getByRole('button', { name: 'Use as video reference' }));
    for (let i = 1; i < 7; i++) {
      fireEvent.click(screen.getByRole('tab', { name: /Gallery/i }));
      fireEvent.click(await screen.findByRole('button', { name: `Enlarge Portrait ${i}.png` }));
      viewer = within(screen.getByRole('dialog'));
      fireEvent.click(viewer.getByRole('button', { name: 'Use as video reference' }));
    }
    await viewer.findByText(
      'Video supports up to 6 reference images. Remove a reference to continue.',
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'Enlarge Old portrait.png' }));
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Use as video reference' }),
    );
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getAllByRole('button', { name: /Remove .* reference/ })).toHaveLength(6);
  });
  it.each(['image/png', 'image/jpeg', 'image/webp'])(
    'allows eligible %s at the size boundary',
    async (mimeType) => {
      const viewer = await setup({ media: { mimeType, sizeBytes: 20 * 1024 * 1024 } });
      expect(viewer.getByRole('button', { name: 'Use as video reference' })).toBeTruthy();
      expect(viewer.getByRole('button', { name: 'Copy reference' })).toBeTruthy();
    },
  );
  it('disables attach without a conversation and preserves actual-size, Escape and focus restoration', async () => {
    const viewer = await setup({ sessionId: '' });
    expect(
      viewer.getByRole('button', { name: 'Attach to conversation' }).hasAttribute('disabled'),
    ).toBe(true);
    fireEvent.click(viewer.getByRole('button', { name: 'Actual size' }));
    expect(viewer.getByRole('button', { name: 'Fit to screen' })).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Enlarge Old portrait.png' }),
    );
    expect(screen.getByRole('button', { name: 'Move Old portrait.png' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Delete Old portrait.png' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Download' })).toBeTruthy();
  });
});
