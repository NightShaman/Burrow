import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AccountStatus } from './AccountStatus';
import { api } from '../../app/api';
import type { SavedProvider } from '../../app/types';
vi.mock('../../app/api', async original => ({ ...await original<typeof import('../../app/api')>(), api: vi.fn() }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
it.each([false, true])('FE010 rendered Anthropic API-key vs OAuth configured=%s', async oauth => {
 vi.mocked(api).mockResolvedValue({usage:{windows:[]}});
 const provider: SavedProvider = { id:'anthropic', provider:'Anthropic', apiType:'anthropic-messages',url:'https://example.invalid',apiKey:'',models:[],apiKeyConfigured:true,oauthConfigured:oauth };
 render(<AccountStatus providers={[provider]} />);
 if (oauth) {
  await waitFor(() => expect(screen.getByText('Connected')).toBeTruthy());
  expect(vi.mocked(api).mock.calls.map(([path])=>path)).toEqual(['/api/anthropic/oauth/usage?connectionId=anthropic']);
 } else {
  expect(screen.getByText('No Anthropic or OpenAI OAuth connections yet.')).toBeTruthy();
  expect(api).not.toHaveBeenCalled();
 }
});

it('keyboard move controls reorder and persist account cards', async () => {
 localStorage.clear(); vi.mocked(api).mockResolvedValue({usage:{windows:[]}});
 const providers: SavedProvider[] = ['First','Second'].map(name => ({id:name,provider:'Anthropic',name,apiType:'anthropic-messages',url:'https://example.invalid',apiKey:'',models:[],oauthConfigured:true}));
 const view = render(<AccountStatus providers={providers}/>);
 await waitFor(() => expect(screen.getAllByText('Connected')).toHaveLength(2));
 const moves = screen.getAllByRole('button', {name:/^Move .* down$/});
 fireEvent.click(moves[0]);
 expect(screen.getAllByRole('button', {name:/^Move .* down$/})[1].getAttribute('aria-label')).toBe(moves[0].getAttribute('aria-label'));
 view.unmount(); render(<AccountStatus providers={providers}/>);
 expect(screen.getAllByRole('button', {name:/^Move .* down$/})[1].getAttribute('aria-label')).toBe(moves[0].getAttribute('aria-label'));
 localStorage.clear();
});
