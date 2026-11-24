import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ConfirmProvider } from '../../app/ConfirmDialog';
import { Forge } from './ForgePage';
import type { VideoCapability } from './ForgeVideoOptions';
const api = vi.hoisted(() => vi.fn());
vi.mock('../../app/api', () => ({ api, fetchApi: vi.fn() }));
const standard = 'grok-imagine-video-1.5',
  lite = `${standard}-lite`,
  legacy = 'grok-imagine-video';
const text: VideoCapability['workflows'][number] = {
  id: 'text-to-video',
  minImages: 0,
  maxImages: 0,
  durationSeconds: { min: 1, max: 15, default: 8 },
  aspectRatios: ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '21:9', '5:2'],
  resolutions: ['480p', '720p', '1080p'],
  defaults: { aspectRatio: '16:9', resolution: '480p' },
};
const model = (modelId: string) => ({
  modelId,
  connectionId: modelId === 'google' ? 'g' : 'x',
  kind: 'video',
  available: true,
  label: modelId,
  agentReferenceImage: { available: true },
  referenceArtifacts: { available: true, maxImages: modelId === lite ? 1 : 6 },
  ...(modelId === 'google'
    ? {}
    : {
        videoOptions: {
          defaultWorkflow: 'text-to-video',
          defaultReferenceWorkflow: modelId === lite ? 'image-to-video' : 'reference-to-video',
          workflows: [
            { ...text, resolutions: modelId === legacy ? ['480p', '720p'] : text.resolutions },
            {
              ...text,
              id: 'image-to-video',
              resolutions: modelId === legacy ? ['480p', '720p'] : text.resolutions,
              minImages: 1,
              maxImages: 1,
              aspectRatios: [],
              defaults: { resolution: '480p' },
            },
            ...(modelId === lite
              ? []
              : [
                  {
                    ...text,
                    id: 'reference-to-video',
                    minImages: 1,
                    maxImages: 6,
                    resolutions: ['480p', '720p'],
                    durationSeconds: {
                      ...text.durationSeconds,
                      max: modelId === legacy ? 10 : 15,
                    },
                  },
                ]),
          ],
        },
      }),
});
const models = [standard, lite, legacy, 'google'].map(model);
const jobs = [
  {
    id: 'j',
    modelId: 'image',
    kind: 'image',
    prompt: 'A river',
    status: 'succeeded',
    createdAt: new Date().toISOString(),
    artifacts: [
      { id: 'a', kind: 'image', mimeType: 'image/png', name: 'river.png', sizeBytes: 40 },
    ],
  },
];
const tab = (name: string) => fireEvent.click(screen.getByRole('tab', { name: new RegExp(name) }));
const field = (name: string) => screen.getByRole('combobox', { name }) as HTMLSelectElement;
const choose = (name: string, value: string) =>
  fireEvent.change(field(name), { target: { value } });
const opt = (name: string, value: string) =>
  Array.from(field(name).options).find((o) => o.value === value);
const generate = () => screen.getByRole('button', { name: 'Generate Video' }) as HTMLButtonElement;
const photo = () => screen.getByLabelText('Use operator reference photo') as HTMLInputElement;
async function setup(id = standard) {
  let selections = { video: { connectionId: id === 'google' ? 'g' : 'x', modelId: id } };
  const state = {
    fail: false,
    posts: [] as Record<string, unknown>[],
    models: structuredClone(models),
  };
  api.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path.endsWith('/catalog'))
      return {
        models: state.models,
        operatorReferenceImage: { id: 'operator' },
        agentReferenceImages: [],
      };
    if (path.endsWith('/selections')) {
      if (init?.method === 'PUT') {
        const { mode, ...pair } = JSON.parse(String(init.body));
        selections = { ...selections, [mode]: pair };
      }
      return { selections };
    }
    if (path.endsWith('/jobs')) {
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body));
        state.posts.push(body);
        if (state.fail) throw Error('fixture rejection');
        return { job: { ...jobs[0], ...body, kind: 'video', id: 'v', artifacts: [] } };
      }
      return { jobs };
    }
    throw Error(path);
  });
  render(
    <ConfirmProvider>
      <Forge selectedAgentId="agent" sessionId="session" />
    </ConfirmProvider>,
  );
  tab('Video');
  await waitFor(() => expect(field('Forge model').disabled).toBe(false));
  fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'Moving water' } });
  return state;
}
const submit = async () => {
  fireEvent.click(generate());
  await screen.findByText('Forge job accepted.');
};
const photos = () =>
  fireEvent.click(screen.getByText(/^Reference photos/, { selector: 'summary' }));
const useImage = () =>
  screen.getByRole('button', { name: 'Use as video reference' }) as HTMLButtonElement;
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
it.each([standard, lite, 'google'])('keeps untouched %s payload unchanged', async (id) => {
  const state = await setup(id);
  expect(!!screen.queryByLabelText('Workflow')).toBe(id !== 'google');
  await submit();
  expect(state.posts[0]).toEqual({
    connectionId: id === 'google' ? 'g' : 'x',
    modelId: id,
    prompt: 'Moving water',
    idempotencyKey: expect.any(String),
  });
});
it.each([standard, lite])(
  'sends explicit text options for %s; omitted defaults and retries remain distinct',
  async (id) => {
    const state = await setup(id);
    state.fail = true;
    choose('Workflow', 'text-to-video');
    choose('Duration', '15');
    choose('Aspect ratio', '5:2');
    choose('Resolution', '1080p');
    photos();
    expect(photo().disabled).toBe(true);
    fireEvent.click(generate());
    await screen.findByText(/fixture rejection/);
    const first = state.posts[0];
    expect(first.videoOptions).toEqual({
      workflow: 'text-to-video',
      durationSeconds: 15,
      aspectRatio: '5:2',
      resolution: '1080p',
    });
    choose('Duration', '');
    choose('Duration', '15');
    fireEvent.click(generate());
    await waitFor(() => expect(generate().disabled).toBe(false));
    expect(state.posts[1].idempotencyKey).toBe(first.idempotencyKey);
    choose('Aspect ratio', '');
    state.fail = false;
    await submit();
    expect(state.posts[2].idempotencyKey).not.toBe(first.idempotencyKey);
    expect(state.posts[2].videoOptions).not.toHaveProperty('aspectRatio');
    expect(field('Duration').value).toBe('');
  },
);
it('gates subject references against the prospective workflow and keeps explicit choices intact', async () => {
  const state = await setup();
  photos();
  choose('Resolution', '1080p');
  expect(photo().disabled).toBe(true);
  expect(opt('Workflow', 'reference-to-video')?.disabled).toBe(true);
  expect(opt('Workflow', 'image-to-video')?.disabled).toBe(false);
  tab('Recents');
  expect(useImage().disabled).toBe(true);
  tab('Video');
  choose('Resolution', '720p');
  fireEvent.click(photo());
  expect(opt('Resolution', '1080p')).toBeUndefined();
  expect(opt('Workflow', 'text-to-video')?.disabled).toBe(true);
  choose('Duration', '12');
  choose('Aspect ratio', '9:16');
  await submit();
  expect(state.posts[0]).toMatchObject({
    useOperatorReferenceImage: true,
    videoOptions: { durationSeconds: 12, aspectRatio: '9:16', resolution: '720p' },
  });
  expect(state.posts[0].videoOptions).not.toHaveProperty('workflow');
});
it('requires exactly one starting frame, accepts a Forge artifact at 1080p and inherits its shape', async () => {
  const state = await setup();
  choose('Workflow', 'image-to-video');
  expect(generate().disabled).toBe(true);
  expect(screen.getByRole('alert').textContent).toMatch(/starting frame/);
  expect(field('Aspect ratio').disabled).toBe(true);
  choose('Resolution', '1080p');
  fireEvent.click(screen.getByRole('button', { name: 'Add Forge image' }));
  fireEvent.click(useImage());
  photos();
  expect(photo().disabled).toBe(true);
  await submit();
  expect(state.posts[0]).toMatchObject({
    videoOptions: { workflow: 'image-to-video', resolution: '1080p' },
    referenceArtifacts: [{ jobId: 'j', artifactId: 'a' }],
  });
});
it('offers no subject workflow on Lite; an explicit aspect blocks its inferred first frame until reset', async () => {
  const state = await setup(lite);
  expect(opt('Workflow', 'reference-to-video')).toBeUndefined();
  choose('Aspect ratio', '1:1');
  photos();
  expect(photo().disabled).toBe(true);
  choose('Aspect ratio', '');
  fireEvent.click(photo());
  expect(field('Aspect ratio').disabled).toBe(true);
  tab('Recents');
  expect(useImage().disabled).toBe(true);
  tab('Video');
  choose('Resolution', '1080p');
  await submit();
  expect(state.posts[0]).toMatchObject({
    videoOptions: { resolution: '1080p' },
    useOperatorReferenceImage: true,
  });
});
it('uses model-specific duration limits and does not leak choices across model changes', async () => {
  const state = await setup(legacy);
  expect(opt('Resolution', '1080p')).toBeUndefined();
  choose('Workflow', 'image-to-video');
  expect(opt('Resolution', '1080p')).toBeUndefined();
  choose('Workflow', '');
  photos();
  choose('Duration', '14');
  expect(photo().disabled).toBe(true);
  choose('Duration', '');
  fireEvent.click(photo());
  expect(opt('Duration', '11')).toBeUndefined();
  choose('Forge provider', 'g');
  await waitFor(() => expect(screen.queryByLabelText('Workflow')).toBeNull());
  choose('Forge provider', 'x');
  await screen.findByLabelText('Workflow');
  expect(field('Duration').value).toBe('');
  await submit();
  expect(state.posts[0]).not.toHaveProperty('videoOptions');
  expect(state.posts[0]).not.toHaveProperty('useOperatorReferenceImage');
});
it('blocks a retained explicit choice if a catalog refresh withdraws it', async () => {
  const state = await setup();
  choose('Resolution', '1080p');
  const cap = state.models[0].videoOptions!;
  cap.workflows[0].resolutions = ['480p'];
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  await waitFor(() => expect(generate().disabled).toBe(true));
  expect(field('Resolution').selectedOptions[0].textContent).toMatch(/1080p.*unavailable/);
  expect(state.posts).toEqual([]);
  choose('Resolution', '');
  await submit();
  expect(state.posts[0]).not.toHaveProperty('videoOptions');
});
