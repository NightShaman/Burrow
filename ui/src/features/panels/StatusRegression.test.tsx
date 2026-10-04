import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { asCodexAccount } from '../../app/useRuntimeDashboard';
import { AccountStatus } from './AccountStatus';
import { SystemPanel } from '../workspace/WorkspaceRail';
import { api, apiForTarget } from '../../app/api';
vi.mock('../../app/api', () => ({ api: vi.fn(), apiForTarget: vi.fn() }));
afterEach(cleanup);
it('preserves unknown quota and numeric zero', () => {
 expect(asCodexAccount({usagePercent:null,quotaWindows:{primary:{percent:null}}},0)).toMatchObject({used:null,meters:[{remainingPercent:null}]});
 expect(asCodexAccount({usagePercent:0},0).used).toBe(100);
 expect(asCodexAccount({usagePercent:75},0).used).toBe(25);
});
it('does not call pending account checks connected; distinguishes success and failure', async () => {
 vi.mocked(api).mockImplementation(() => new Promise(() => {}));
 const providers = [{id:'a',provider:'OpenAI',apiType:'openai-responses',oauthConfigured:true,models:[],apiKey:'',url:''}];
 const view = render(<AccountStatus providers={providers}/>);
 expect(screen.queryByText('Connected')).toBeNull();
 expect(screen.getByText('Checking')).toBeTruthy();
 view.unmount();
 vi.mocked(api).mockResolvedValue({usage:null});
 const ready = render(<AccountStatus providers={providers}/>);
 await screen.findByText('Connected'); ready.unmount();
 vi.mocked(api).mockRejectedValue(new Error('offline'));
 render(<AccountStatus providers={providers}/>); await screen.findByText('Disconnected');
});
it('runtime dot is not green while pending or failed and is green only on success', async () => {
 const target = {id:'fixture',name:'Fixture',baseUrl:'',enabled:true};
 vi.mocked(apiForTarget).mockImplementation(() => new Promise(() => {}));
 const view = render(<SystemPanel target={target} provider="p" providerConnectionStatus="connected"/>);
 expect(view.container.querySelector('.system-status.checking')).toBeTruthy(); view.unmount();
 vi.mocked(apiForTarget).mockResolvedValue({ok:true});
 const ready = render(<SystemPanel target={target} provider="p" providerConnectionStatus="connected"/>);
 await waitFor(() => expect(ready.container.querySelector('.system-status.connected')).toBeTruthy()); ready.unmount();
 vi.mocked(apiForTarget).mockRejectedValue(new Error('offline'));
 const failed = render(<SystemPanel target={target} provider="p" providerConnectionStatus="connected"/>);
 await waitFor(() => expect(failed.container.querySelector('.system-status.disconnected')).toBeTruthy());
});
