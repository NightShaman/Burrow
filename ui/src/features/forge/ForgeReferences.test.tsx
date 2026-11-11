import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfirmProvider } from '../../app/ConfirmDialog';
import { Forge } from './ForgePage';
const apiMock = vi.hoisted(() => vi.fn());
vi.mock('../../app/api', () => ({ api: apiMock, fetchApi: vi.fn() }));
const base = { connectionId: 'google', available: true, controls: [] };
const models = [
  {
    ...base,
    kind: 'image',
    modelId: 'image',
    label: 'Image',
    agentReferenceImage: { available: true },
  },
  {
    ...base,
    kind: 'video',
    modelId: 'veo',
    label: 'Veo',
    referenceArtifacts: { available: true, maxImages: 6 },
    agentReferenceImage: { available: true },
  },
  {
    ...base,
    kind: 'video',
    modelId: 'text',
    label: 'Text video',
    agentReferenceImage: { available: false },
  },
  {
    ...base,
    kind: 'audio',
    modelId: 'speech',
    label: 'Speech',
    agentReferenceImage: { available: true },
  },
];
const portraits = [
  { agentId: 'smatchet', agentName: 'Smatchet', id: 's' },
  { agentId: 'kerning', agentName: 'Kerning', id: 'k' },
];
let posts: Record<string, unknown>[];
let writes: Record<string, unknown>[];
let fail: boolean | string;
function setup({
  empty = false,
  saved = {},
  available = true,
  jobs = [] as any[],
  savedPortraits = portraits,
  artifactCapability = true,
} = {}) {
  posts = [];
  writes = [];
  fail = false;
  let selections = saved;
  let catalog = {
    models: models.map((m) =>
      m.kind === 'video'
        ? {
            ...m,
            available,
            referenceArtifacts: {
              available: artifactCapability && m.modelId === 'veo',
              maxImages: 6,
            },
          }
        : m,
    ),
    video: { available },
    agentReferenceImages: empty ? [] : savedPortraits,
    operatorReferenceImage: empty ? null : { id: 'o' },
  };
  apiMock.mockImplementation((path: string, init?: RequestInit) => {
    if (path.endsWith('/catalog')) return Promise.resolve(catalog);
    if (path.endsWith('/selections')) {
      if (init?.method === 'PUT') {
        const body = JSON.parse(String(init.body));
        writes.push(body);
        const { mode, ...pair } = body;
        selections = { ...selections, [mode]: pair };
      }
      return Promise.resolve({ selections });
    }
    if (path.endsWith('/jobs') && init?.method === 'POST') {
      const body = JSON.parse(String(init.body));
      posts.push(body);
      if (fail)
        return Promise.reject(
          new Error(typeof fail === 'string' ? fail : 'Saved reference photo unavailable'),
        );
      return Promise.resolve({
        job: {
          ...body,
          id: `job${posts.length}`,
          kind: models.find((m) => m.modelId === body.modelId)?.kind,
          status: 'succeeded',
          createdAt: '2026-11-11T19:00:00Z',
          updatedAt: '2026-11-11T19:00:00Z',
          artifacts: [],
        },
      });
    }
    return Promise.resolve({ jobs });
  });
  render(
    <ConfirmProvider>
      <Forge selectedAgentId="smatchet" sessionId="s" />
    </ConfirmProvider>,
  );
  return () => {
    catalog = { ...catalog, agentReferenceImages: [], operatorReferenceImage: null as any };
  };
}
const ref = (name = 'Smatchet') =>
  screen.getByRole('checkbox', { name: `Use ${name} reference photo` });
const tab = (name: string) =>
  fireEvent.click(screen.getByRole('tab', { name: new RegExp(name, 'i') }));
async function ready() {
  await screen.findByRole('checkbox', { name: 'Use Smatchet reference photo' });
}
function submit(mode = 'Video') {
  fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'A dragon in flight' } });
  fireEvent.click(screen.getByRole('button', { name: `Generate ${mode}` }));
}
async function choose(id: string) {
  fireEvent.change(screen.getByLabelText('Forge model'), {
    target: { value: JSON.stringify(['google', id]) },
  });
  await waitFor(() =>
    expect((screen.getByLabelText('Forge model') as HTMLSelectElement).value).toBe(
      JSON.stringify(['google', id]),
    ),
  );
}
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
describe('saved reference photos in Forge video and image', () => {
  it('sends ordered saved agent ids and operator flag for video; clears accepted refs', async () => {
    setup();
    await ready();
    tab('video');
    fireEvent.click(ref('Kerning'));
    fireEvent.click(ref());
    fireEvent.click(ref('operator'));
    submit();
    await screen.findByText('Forge job accepted.');
    expect(posts[0]).toMatchObject({
      connectionId: 'google',
      modelId: 'veo',
      referenceAgentIds: ['kerning', 'smatchet'],
      useOperatorReferenceImage: true,
    });
    expect(posts[0]).not.toHaveProperty('imageOptions');
    expect((ref() as HTMLInputElement).checked).toBe(false);
    expect((ref('operator') as HTMLInputElement).checked).toBe(false);
  });
  it('supports the same saved portrait controls for images', async () => {
    setup();
    await ready();
    fireEvent.click(ref());
    submit('Image');
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0].referenceAgentIds).toEqual(['smatchet']);
  });
  it('omits references entirely for text-only jobs', async () => {
    setup();
    await ready();
    tab('video');
    submit();
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).not.toHaveProperty('referenceAgentIds');
    expect(posts[0]).not.toHaveProperty('useOperatorReferenceImage');
  });
  it('clears refs across mode and model changes, including switch back', async () => {
    setup();
    await ready();
    fireEvent.click(ref());
    tab('video');
    expect((ref() as HTMLInputElement).checked).toBe(false);
    fireEvent.click(ref());
    await choose('text');
    expect(screen.queryByRole('group', { name: 'Reference photos' })).toBeNull();
    await choose('veo');
    expect((ref() as HTMLInputElement).checked).toBe(false);
    tab('image');
    expect((ref() as HTMLInputElement).checked).toBe(false);
    tab('speech');
    expect(screen.queryByRole('group', { name: 'Reference photos' })).toBeNull();
  });
  it('retains failed refs and prompt; retries use same key, changed refs use new key', async () => {
    setup();
    await ready();
    tab('video');
    fireEvent.click(ref());
    fail = true;
    submit();
    await screen.findByText(/Could not start generation/);
    expect((ref() as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText('Prompt') as HTMLTextAreaElement).value).toBe(
      'A dragon in flight',
    );
    submit();
    await waitFor(() => expect(posts).toHaveLength(2));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Generate Video' }).hasAttribute('disabled')).toBe(
        false,
      ),
    );
    expect(posts[1].idempotencyKey).toBe(posts[0].idempotencyKey);
    fireEvent.click(ref('operator'));
    submit();
    await waitFor(() => expect(posts).toHaveLength(3));
    expect(posts[2].idempotencyKey).not.toBe(posts[1].idempotencyKey);
  });
  it('does not display unsaved portraits or upload controls', async () => {
    setup({ empty: true });
    await waitFor(() =>
      expect(screen.getByLabelText('Forge model').hasAttribute('disabled')).toBe(false),
    );
    tab('video');
    expect(screen.queryByRole('group', { name: 'Reference photos' })).toBeNull();
    expect(document.querySelector('input[type=file]')).toBeNull();
    submit();
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).not.toHaveProperty('referenceAgentIds');
  });
  it('saves video defaults through the existing selection endpoint and restores them across tabs', async () => {
    setup({ saved: { video: { connectionId: 'google', modelId: 'text' } } });
    await ready();
    tab('video');
    expect((screen.getByLabelText('Forge model') as HTMLSelectElement).value).toBe(
      '["google","text"]',
    );
    await choose('veo');
    expect(writes).toEqual([{ mode: 'video', connectionId: 'google', modelId: 'veo' }]);
    tab('image');
    tab('video');
    expect((screen.getByLabelText('Forge model') as HTMLSelectElement).value).toBe(
      '["google","veo"]',
    );
  });
  it('keeps unavailable video generation disabled', async () => {
    setup({ available: false });
    await ready();
    tab('video');
    expect(screen.getByRole('button', { name: 'Generate Video' }).hasAttribute('disabled')).toBe(
      true,
    );
    expect(screen.queryByRole('group', { name: 'Reference photos' })).toBeNull();
  });
  it('filters removed portraits on catalog refresh', async () => {
    const remove = setup();
    await ready();
    tab('video');
    fireEvent.click(ref());
    fireEvent.click(ref('operator'));
    remove();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() =>
      expect(screen.queryByRole('group', { name: 'Reference photos' })).toBeNull(),
    );
    submit();
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).not.toHaveProperty('referenceAgentIds');
    expect(posts[0]).not.toHaveProperty('useOperatorReferenceImage');
  });
});

const imageJob = (id = 'source', extra = {}) => ({
  id,
  connectionId: 'google',
  modelId: 'image',
  kind: 'image',
  status: 'succeeded',
  prompt: `Dragon study ${id}`,
  createdAt: '2026-11-11T19:00:00Z',
  updatedAt: '2026-11-11T19:00:00Z',
  artifacts: [
    {
      id: `artifact-${id}`,
      kind: 'image',
      name: `${id}.png`,
      mimeType: 'image/png',
      sizeBytes: 1024,
    },
  ],
  ...extra,
});
async function addImage(id = 'source', fromVideo = false) {
  if (fromVideo) fireEvent.click(screen.getByRole('button', { name: 'Add Forge image' }));
  const jobButton = screen.queryByRole('button', { name: `Image succeeded: Dragon study ${id}` });
  if (jobButton) fireEvent.click(jobButton);
  fireEvent.click(await screen.findByRole('button', { name: 'Use as video reference' }));
  await screen.findByRole('button', { name: `Remove ${id}.png reference` });
}
describe('existing Forge image references for video', () => {
  it('selects through image detail and Recents, deduplicates, combines portraits, and clears accepted refs', async () => {
    setup({ jobs: [imageJob()] });
    await ready();
    await addImage();
    expect(screen.getByRole('tab', { name: /Video/ }).getAttribute('aria-selected')).toBe('true');
    fireEvent.click(ref());
    fireEvent.click(ref('operator'));
    await addImage('source', true);
    expect(screen.getAllByRole('button', { name: 'Remove source.png reference' })).toHaveLength(1);
    expect((ref() as HTMLInputElement).checked).toBe(true);
    submit();
    await screen.findByText('Forge job accepted.');
    expect(posts[0]).toMatchObject({
      referenceArtifacts: [{ jobId: 'source', artifactId: 'artifact-source' }],
      referenceAgentIds: ['smatchet'],
      useOperatorReferenceImage: true,
    });
    expect(screen.queryByRole('button', { name: 'Remove source.png reference' })).toBeNull();
    expect(document.querySelector('input[type=file]')).toBeNull();
  });
  it('preserves failed reference requests and idempotency; removal changes the key and payload', async () => {
    setup({ jobs: [imageJob()] });
    await ready();
    await addImage();
    fail = 'forge_reference_artifact_invalid';
    submit();
    await screen.findByText('Could not start generation: forge_reference_artifact_invalid');
    expect(screen.getByRole('button', { name: 'Remove source.png reference' })).toBeTruthy();
    submit();
    await waitFor(() => expect(posts).toHaveLength(2));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Generate Video' }).hasAttribute('disabled')).toBe(
        false,
      ),
    );
    expect(posts[1].idempotencyKey).toBe(posts[0].idempotencyKey);
    fireEvent.click(screen.getByRole('button', { name: 'Remove source.png reference' }));
    submit();
    await waitFor(() => expect(posts).toHaveLength(3));
    expect(posts[2]).not.toHaveProperty('referenceArtifacts');
    expect(posts[2].idempotencyKey).not.toBe(posts[1].idempotencyKey);
  });
  it.each([
    'forge_reference_artifact_invalid',
    'forge_reference_artifacts_video_only',
    'forge_reference_artifacts_unsupported',
  ])('retains the mixed video draft after backend rejection %s', async (error) => {
    setup({ jobs: [imageJob()] });
    await ready();
    await addImage();
    fireEvent.click(ref());
    fail = error;
    submit();
    await screen.findByText(`Could not start generation: ${error}`);
    expect(screen.getByRole('button', { name: 'Remove source.png reference' })).toBeTruthy();
    expect((ref() as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText('Prompt') as HTMLTextAreaElement).value).toBe(
      'A dragon in flight',
    );
    expect(screen.getByRole('button', { name: 'Generate Video' }).hasAttribute('disabled')).toBe(
      false,
    );
    fail = false;
    submit();
    await screen.findByText('Forge job accepted.');
    expect(posts[1]).toEqual(posts[0]);
  });
  it('never leaks artifact refs into image, speech, or unsupported video; changing video model clears draft', async () => {
    setup({ jobs: [imageJob()] });
    await ready();
    await addImage();
    tab('image');
    submit('Image');
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).not.toHaveProperty('referenceArtifacts');
    await addImage();
    await choose('text');
    expect(screen.queryByRole('button', { name: 'Add Forge image' })).toBeNull();
    submit();
    await waitFor(() => expect(posts).toHaveLength(2));
    expect(posts[1]).not.toHaveProperty('referenceArtifacts');
    await choose('veo');
    expect(screen.queryByRole('button', { name: 'Remove source.png reference' })).toBeNull();
    tab('speech');
    expect(screen.queryByRole('group', { name: 'Forge image references' })).toBeNull();
  });
  it('requires explicit artifact capability and a configured available video model', async () => {
    setup({ jobs: [imageJob()], artifactCapability: false });
    await ready();
    expect(screen.queryByRole('button', { name: 'Use as video reference' })).toBeNull();
    tab('video');
    expect(screen.queryByRole('button', { name: 'Add Forge image' })).toBeNull();
  });
  it.each([
    { status: 'failed' },
    { kind: 'video' },
    {
      artifacts: [
        { id: 'bad', kind: 'image', name: 'bad.gif', mimeType: 'image/gif', sizeBytes: 1024 },
      ],
    },
    {
      artifacts: [
        {
          id: 'bad',
          kind: 'image',
          name: 'bad.png',
          mimeType: 'image/png',
          sizeBytes: 20 * 1024 * 1024 + 1,
        },
      ],
    },
    {
      artifacts: [
        { id: 'bad', kind: 'image', name: 'empty.png', mimeType: 'image/png', sizeBytes: 0 },
      ],
    },
  ])('does not offer invalid source %j', async (extra) => {
    setup({ jobs: [imageJob('source', extra)] });
    await ready();
    tab('Recents');
    expect(screen.queryByRole('button', { name: 'Use as video reference' })).toBeNull();
  });
  it('enforces combined six-image limit while allowing deselection and gallery navigation', async () => {
    setup({
      jobs: [imageJob()],
      savedPortraits: Array.from({ length: 6 }, (_, i) => ({
        agentId: `p${i}`,
        agentName: `Person ${i}`,
        id: `p${i}`,
      })),
    });
    await screen.findByRole('button', { name: 'Use as video reference' });
    await addImage();
    for (let i = 0; i < 5; i++) fireEvent.click(ref(`Person ${i}`));
    expect(ref('Person 5').hasAttribute('disabled')).toBe(true);
    expect(ref('operator').hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: 'Add Forge image' }).hasAttribute('disabled')).toBe(
      true,
    );
    fireEvent.click(ref('Person 0'));
    expect(ref('Person 5').hasAttribute('disabled')).toBe(false);
    fireEvent.click(ref('operator'));
    submit();
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0].referenceAgentIds).toEqual(['p1', 'p2', 'p3', 'p4']);
    expect(posts[0].referenceArtifacts).toEqual([
      { jobId: 'source', artifactId: 'artifact-source' },
    ]);
    expect(posts[0].useOperatorReferenceImage).toBe(true);
  });
  it('filters deleted sources on refresh before request construction', async () => {
    const jobs = [imageJob()];
    setup({ jobs });
    await ready();
    await addImage();
    jobs.splice(0);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Remove source.png reference' })).toBeNull(),
    );
    submit();
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).not.toHaveProperty('referenceArtifacts');
  });
});
