import { ConfirmProvider } from '../../app/ConfirmDialog';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { Forge } from './ForgePage';
const api = vi.hoisted(() => vi.fn());
const fetchApi = vi.hoisted(() => vi.fn());
vi.mock('../../app/api', () => ({ api, fetchApi }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
function home() {
  api.mockImplementation((path: string) =>
    Promise.resolve(
      path.endsWith('/catalog')
        ? { models: [] }
        : path.endsWith('/jobs')
          ? {
              jobs: [
                {
                  id: 'private',
                  kind: 'image',
                  prompt: 'private prompt',
                  status: 'succeeded',
                  createdAt: new Date().toISOString(),
                  artifacts: [
                    {
                      id: 'secret',
                      kind: 'image',
                      name: 'private.png',
                      previewUrl: '/private-media',
                      mimeType: 'image/png',
                    },
                  ],
                },
              ],
            }
          : { selections: {} },
    ),
  );
  return render(
    <ConfirmProvider>
      <Forge selectedAgentId="a" sessionId="s" />
    </ConfirmProvider>,
  );
}
it('defaults to Home without mounting private job previews or history', async () => {
  home();
  await waitFor(() =>
    expect(api.mock.calls.some(([path]) => path === '/api/forge/jobs')).toBe(true),
  );
  expect(screen.getByRole('tab', { name: /Home/ }).getAttribute('aria-selected')).toBe('true');
  expect(screen.queryByText('private prompt')).toBeNull();
  expect(screen.queryByText('private.png')).toBeNull();
  expect(screen.queryByRole('region', { name: 'Recent creations list' })).toBeNull();
  expect(screen.queryByLabelText('Creation viewer')).toBeNull();
  expect(fetchApi).not.toHaveBeenCalled();
  const crest = screen.getByRole('img', { name: /Arcane forge hammer/ });
  expect(document.querySelector('.forge-home-atmosphere')?.getAttribute('aria-hidden')).toBe(
    'true',
  );
  expect(document.querySelector('.forge-home-constellation')).not.toBeNull();
  expect(document.querySelectorAll('.forge-home-ember')).toHaveLength(0);
  expect(crest.getAttribute('src')).toBe('/forge.png');
  expect(crest.getAttribute('width')).toBe('1254');
  expect(crest.getAttribute('height')).toBe('1254');
  expect(document.querySelector('.forge-home svg')).toBeNull();
  expect(screen.queryByLabelText('Creation shortcuts')).toBeNull();
  expect(screen.queryByText(/Choose a medium/)).toBeNull();
  expect(screen.queryByRole('heading', { name: 'The Phantasm Forge' })).toBeNull();
  expect(screen.getByText('The Phantasm Forge').parentElement?.style.visibility).toBe('hidden');
  expect(
    screen
      .getByText('Manufacture sights, sounds, and moving lies.')
      .parentElement?.getAttribute('aria-hidden'),
  ).toBe('true');
  expect(screen.getByRole('heading', { name: 'The Forge Awaits', level: 1 })).toBeTruthy();
  expect(screen.queryByText('Give an idea its form.')).toBeNull();
  expect(screen.queryByText('Make something extraordinary.')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Image' })).toBeNull();
  fireEvent.click(screen.getByRole('checkbox', { name: 'Forge effects' }));
  expect(document.querySelector('.forge-motion-reduced')).not.toBeNull();
});
it.each(['Image', 'Video', 'Speech', 'Music'])(
  'opens the existing %s creation flow from Home',
  async (label) => {
    home();
    fireEvent.click(screen.getByRole('tab', { name: new RegExp(label) }));
    expect(screen.getByRole('heading', { name: `${label} generation` })).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: /Home/ }));
    expect(screen.queryByLabelText('Creation viewer')).toBeNull();
    await waitFor(() => expect(api).toHaveBeenCalled());
  },
);
