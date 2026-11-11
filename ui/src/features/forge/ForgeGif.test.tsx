import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfirmProvider } from '../../app/ConfirmDialog';
import { Forge } from './ForgePage';
const apiMock = vi.hoisted(() => vi.fn());
vi.mock('../../app/api', () => ({ api: apiMock, fetchApi: vi.fn() }));
const capability = { outputFormats: ['png', 'jpeg', 'webp', 'gif'], sizes: ['auto', '1024x1024'] };
const base = { connectionId: 'c', kind: 'image', available: true, controls: [] };
const models = [
  { ...base, modelId: 'animated', label: 'Animated model', imageOptions: capability },
  { ...base, modelId: 'still', label: 'Still-only' },
  {
    ...base,
    modelId: 'limited',
    label: 'Limited',
    imageOptions: { outputFormats: ['png', 'jpeg'], sizes: ['auto'] },
  },
  { ...base, kind: 'audio', modelId: 'voice', label: 'Voice' },
];
let posts: Record<string, unknown>[];
let fail: boolean;
function setup() {
  posts = [];
  fail = false;
  let selections = {};
  apiMock.mockImplementation((path: string, init?: RequestInit) => {
    if (path.endsWith('/catalog')) return Promise.resolve({ models });
    if (path.endsWith('/selections')) {
      if (init?.method === 'PUT') {
        const { mode, ...pair } = JSON.parse(String(init.body));
        selections = { ...selections, [mode]: pair };
      }
      return Promise.resolve({ selections });
    }
    if (path.endsWith('/jobs') && init?.method === 'POST') {
      posts.push(JSON.parse(String(init.body)));
      if (fail) return Promise.reject(new Error('unsupported GIF'));
      return Promise.resolve({
        job: {
          id: `job${posts.length}`,
          connectionId: 'c',
          modelId: 'animated',
          kind: 'image',
          status: 'succeeded',
          prompt: 'Dragon',
          createdAt: '2026-11-11T13:00:00Z',
          updatedAt: '2026-11-11T13:00:00Z',
          artifacts: [],
        },
      });
    }
    return Promise.resolve({ jobs: [] });
  });
  render(
    <ConfirmProvider>
      <Forge selectedAgentId="a" sessionId="s" />
    </ConfirmProvider>,
  );
}
const choose = (value: string) =>
  fireEvent.change(screen.getByLabelText('Output format'), { target: { value } });
const prompt = () =>
  fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'Dragon' } });
const submit = () => fireEvent.click(screen.getByRole('button', { name: 'Generate Image' }));
async function ready() {
  await screen.findByLabelText('Output format');
}
async function model(id: string) {
  fireEvent.change(screen.getByLabelText('Forge model'), {
    target: { value: JSON.stringify(['c', id]) },
  });
  await waitFor(() =>
    expect((screen.getByLabelText('Forge model') as HTMLSelectElement).value).toBe(
      JSON.stringify(['c', id]),
    ),
  );
}
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
describe('capability-driven animated GIF jobs', () => {
  it('leaves untouched still defaults out of the request', async () => {
    setup();
    await ready();
    prompt();
    submit();
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).not.toHaveProperty('imageOptions');
  });
  it('sends only GIF controls, rounds delay and clears GIF after accepted jobs', async () => {
    setup();
    await ready();
    choose('gif');
    prompt();
    fireEvent.change(screen.getByLabelText('Frame delay (ms)'), { target: { value: '207' } });
    fireEvent.change(screen.getByLabelText('GIF size'), { target: { value: '1024x1024' } });
    submit();
    await screen.findByText('Forge job accepted.');
    expect(posts[0].imageOptions).toEqual({
      outputFormat: 'gif',
      frameCount: 9,
      frameDurationMs: 210,
      size: '1024x1024',
    });
    expect((screen.getByLabelText('Output format') as HTMLSelectElement).value).toBe('png');
    expect(screen.queryByLabelText('Frames')).toBeNull();
    prompt();
    submit();
    await waitFor(() => expect(posts).toHaveLength(2));
    expect(posts[1]).not.toHaveProperty('imageOptions');
  });
  it('drops frames when switching to still formats including explicit PNG', async () => {
    setup();
    await ready();
    choose('gif');
    choose('webp');
    prompt();
    submit();
    await screen.findByText('Forge job accepted.');
    expect(posts[0].imageOptions).toEqual({ outputFormat: 'webp' });
    choose('gif');
    choose('png');
    prompt();
    submit();
    await waitFor(() => expect(posts).toHaveLength(2));
    expect(posts[1].imageOptions).toEqual({ outputFormat: 'png' });
  });
  it('never infers support, and resets on model changes including return', async () => {
    setup();
    await ready();
    choose('gif');
    await model('still');
    expect(screen.queryByLabelText('Output format')).toBeNull();
    prompt();
    submit();
    await screen.findByText('Forge job accepted.');
    expect(posts[0]).not.toHaveProperty('imageOptions');
    await model('animated');
    expect((screen.getByLabelText('Output format') as HTMLSelectElement).value).toBe('png');
    choose('gif');
    await model('limited');
    expect(screen.queryByRole('option', { name: 'Animated GIF' })).toBeNull();
    expect(screen.queryByLabelText('Frames')).toBeNull();
  });
  it('clears GIF across mode changes', async () => {
    setup();
    await ready();
    choose('gif');
    fireEvent.click(screen.getByRole('tab', { name: /Speech/i }));
    expect(screen.queryByLabelText('Output format')).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: /Image/i }));
    expect((screen.getByLabelText('Output format') as HTMLSelectElement).value).toBe('png');
  });
  it('blocks invalid frames/delay without losing prompt', async () => {
    setup();
    await ready();
    choose('gif');
    prompt();
    for (const [label, value] of [
      ['Frames', '17'],
      ['Frames', ''],
      ['Frames', '2.5'],
    ]) {
      fireEvent.change(screen.getByLabelText(label), { target: { value } });
      submit();
      expect(
        (screen.getByRole('button', { name: 'Generate Image' }) as HTMLButtonElement).disabled,
      ).toBe(true);
      expect(posts).toHaveLength(0);
    }
    fireEvent.change(screen.getByLabelText('Frames'), { target: { value: '9' } });
    fireEvent.change(screen.getByLabelText('Frame delay (ms)'), { target: { value: '2001' } });
    expect(screen.getByRole('alert').textContent).toContain('frame delay');
    expect((screen.getByLabelText('Prompt') as HTMLTextAreaElement).value).toBe('Dragon');
  });
  it('retains draft on failure; changed options change idempotency keys while identical retry reuses one', async () => {
    setup();
    await ready();
    fail = true;
    choose('gif');
    prompt();
    submit();
    await screen.findByText(/Could not start generation: unsupported GIF/);
    expect(screen.getByText('Duration: 1.8 s')).toBeTruthy();
    submit();
    await waitFor(() => expect(posts).toHaveLength(2));
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: 'Generate Image' }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    expect(posts[0].idempotencyKey).toBe(posts[1].idempotencyKey);
    fireEvent.change(screen.getByLabelText('Frames'), { target: { value: '10' } });
    submit();
    await waitFor(() => expect(posts).toHaveLength(3));
    expect(posts[2].idempotencyKey).not.toBe(posts[0].idempotencyKey);
  });
});
