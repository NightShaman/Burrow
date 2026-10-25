import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { api, type OpenAiResetCredits } from '../../app/api';
import { ConfirmProvider } from '../../app/ConfirmDialog';
import { OpenAiResets, soonestReset, resetRequestId } from './OpenAiResets';
import { accountUsageStatus, type AccountUsageCard } from './AccountStatus';
vi.mock('../../app/api', async original => ({ ...await original<typeof import('../../app/api')>(), api: vi.fn() }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.clearAllMocks(); });
const future = (offset = 3_600_000) => new Date(Date.now() + offset).toISOString();
const credits = (): OpenAiResetCredits => ({ok:true, fetchedAt:new Date().toISOString(), credits:{availableCount:2,nearestExpiresAt:future(),available:[{id:'late',expiresAt:future(7_200_000)},{id:'first',expiresAt:future()}]}});
let id = 0;
function setup() {
 const refresh = vi.fn(); const connectionId = `reset-test-${++id}`;
 const view = render(<ConfirmProvider><OpenAiResets connectionId={connectionId} name="OpenAI Personal" onUsageRefresh={refresh}/></ConfirmProvider>);
 return { ...view, refresh, connectionId };
}
const posts = () => vi.mocked(api).mock.calls.filter(([,init]) => init?.method === 'POST');
async function openConfirm() { await screen.findByText('2 banked'); fireEvent.click(screen.getByRole('button', {name:'Use reset'})); await screen.findByRole('alertdialog'); }
it('keeps banked count and soonest expiry inside its control, cancels without mutation', async () => {
 vi.mocked(api).mockResolvedValue(credits());
 setup(); await openConfirm();
 expect(screen.getByText(/Consume one banked reset expiring/)).toBeTruthy();
 expect(screen.getByRole('button',{name:'Use reset'}).hasAttribute('disabled')).toBe(true);
 fireEvent.click(screen.getByRole('button',{name:'Cancel'}));
 await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
 expect(posts()).toHaveLength(0);
});
it('rechecks availability, picks soonest expiry, sends one UUID POST, blocks duplicates and refreshes', async () => {
 let complete!: (value: unknown) => void;
 vi.mocked(api).mockImplementation((_path,init) => init?.method === 'POST' ? new Promise(resolve => {complete=resolve;}) as ReturnType<typeof api> : Promise.resolve(credits()) as ReturnType<typeof api>);
 const {refresh,connectionId} = setup(); await openConfirm();
 fireEvent.click(screen.getByRole('button',{name:'Consume one reset'}));
 await screen.findByRole('button',{name:'Using'});
 fireEvent.click(screen.getByRole('button',{name:'Using'}));
 expect(posts()).toHaveLength(1);
 const payload = JSON.parse(posts()[0][1]!.body as string);
 expect(payload).toMatchObject({connectionId,creditId:'first'});
 expect(payload.requestId).toMatch(/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i);
 const after = credits(); after.credits.availableCount = 1;
 await act(async () => complete({ok:true,code:'reset',usageRefresh:{ok:true},creditsRefresh:after}));
 await screen.findByText('Reset used.'); expect(screen.getByText('1 banked')).toBeTruthy(); expect(refresh).toHaveBeenCalledOnce();
 await openAgain();
 expect(posts()).toHaveLength(2);
 expect(JSON.parse(posts()[1][1]!.body as string).requestId).not.toBe(payload.requestId);
 async function openAgain() { fireEvent.click(screen.getByRole('button',{name:'Use reset'})); await screen.findByRole('alertdialog'); fireEvent.click(screen.getByRole('button',{name:'Consume one reset'})); }
});
it('reports successful redemption separately from failed refreshes', async () => {
 vi.mocked(api).mockImplementation((_path,init) => Promise.resolve(init?.method === 'POST' ? {ok:true,code:'nothing_to_reset',usageRefresh:{ok:false},creditsRefresh:{ok:false}} : credits()) as ReturnType<typeof api>);
 const {refresh} = setup(); await openConfirm(); fireEvent.click(screen.getByRole('button',{name:'Consume one reset'}));
 await screen.findByText('Nothing to reset. Usage refresh failed. Reset availability refresh failed.');
 expect(screen.getByText('Resets unavailable')).toBeTruthy(); expect(refresh).toHaveBeenCalledOnce(); expect(posts()).toHaveLength(1);
});
it('unknown is not zero; a GET failure never sends a POST', async () => {
 vi.mocked(api).mockRejectedValue(new Error('offline'));
 setup(); await screen.findByText('Resets unavailable');
 expect(screen.queryByText('0 banked')).toBeNull(); fireEvent.click(screen.getByRole('button',{name:'Use reset'}));
 await screen.findByText('Could not check reset availability. No reset sent.'); expect(posts()).toHaveLength(0);
});
it('locks ambiguous operations across remount and never automatically retries', async () => {
 vi.mocked(api).mockImplementation((_path,init) => init?.method === 'POST' ? Promise.reject(new Error('network timeout')) : Promise.resolve(credits()) as ReturnType<typeof api>);
 const {connectionId,unmount} = setup(); await openConfirm(); fireEvent.click(screen.getByRole('button',{name:'Consume one reset'}));
 await screen.findByText(/Reset outcome unknown/);
 expect(screen.getByRole('button',{name:'Use reset'}).hasAttribute('disabled')).toBe(true); expect(posts()).toHaveLength(1);
 unmount(); render(<ConfirmProvider><OpenAiResets connectionId={connectionId} name="OpenAI" onUsageRefresh={vi.fn()}/></ConfirmProvider>);
 await screen.findByText('2 banked'); expect(screen.getByRole('button',{name:'Use reset'}).hasAttribute('disabled')).toBe(true); expect(posts()).toHaveLength(1);
});
it('handles explicit rejection without pretending success', async () => {
 vi.mocked(api).mockImplementation((_path,init) => init?.method === 'POST' ? Promise.reject(Object.assign(new Error('reset_credit_unavailable'),{status:409,details:'{"ambiguous":false}'})) : Promise.resolve(credits()) as ReturnType<typeof api>);
 setup(); await openConfirm(); fireEvent.click(screen.getByRole('button',{name:'Consume one reset'}));
 await screen.findByText('Reset no longer available. Availability will refresh.'); expect(posts()).toHaveLength(1);
 expect(screen.getByRole('button',{name:'Use reset'}).hasAttribute('disabled')).toBe(false);
});
it('uses refreshed availability rather than stale displayed credits', async () => {
 vi.mocked(api).mockResolvedValueOnce(credits()).mockResolvedValue({...credits(),credits:{availableCount:0,available:[],nearestExpiresAt:null}});
 setup(); await screen.findByText('2 banked'); fireEvent.click(screen.getByRole('button',{name:'Use reset'}));
 await screen.findByText('No available reset. Availability refreshed.'); expect(screen.getByText('0 banked')).toBeTruthy(); expect(posts()).toHaveLength(0);
});
it('does not consume a credit that expires while confirming', async () => {
 const clock = vi.spyOn(Date,'now'); const now = Date.now(); clock.mockReturnValue(now);
 vi.mocked(api).mockResolvedValue(credits()); setup(); await openConfirm();
 clock.mockReturnValue(now + 3_600_001); fireEvent.click(screen.getByRole('button',{name:'Consume one reset'}));
 await screen.findByText('That reset expired. Check availability again.'); expect(posts()).toHaveLength(0);
});
it('sorts unknown expiry last, filters expired credits, and distinguishes stale status', () => {
 const snapshot = credits(); snapshot.credits.available.unshift({id:'expired',expiresAt:future(-1)}, {id:'undated',expiresAt:null});
 expect(soonestReset(snapshot)?.id).toBe('first');
 const base: AccountUsageCard = {id:'x',name:'OpenAI',vendor:'OpenAI',plan:null,state:'ready',bars:[]};
 expect(accountUsageStatus(base).label).toBe('Unknown');
 for (const [status,label] of [['rate_limited','Rate Limited'],['limit_exceeded','Limit Exceeded'],['available','Available']]) {
  const card = {...base,accountStatus:{status,label,reason:'test',scope:'account',resetAt:future(),checkedAt:new Date().toISOString()}};
  expect(accountUsageStatus(card).label).toBe(label);
  expect(accountUsageStatus(card,Date.now()+3_600_001).label).toBe('Stale');
 }
});

it('creates fresh RFC4122 UUIDs on operator LAN HTTP without randomUUID', () => {
 vi.spyOn(crypto, 'randomUUID').mockImplementation(undefined as never);
 expect(resetRequestId()).toMatch(/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i);
 expect(resetRequestId()).not.toBe(resetRequestId());
});
