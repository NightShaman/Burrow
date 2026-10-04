import { StrictMode } from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ModSettingsHost } from './ModSettingsHost';
const { mountSettings } = vi.hoisted(() => ({mountSettings:vi.fn()}));
vi.mock('./ModSettingsHostFixture',()=>({settingsSections:[{id:'one',label:'One'}],mountSettings,settingsContribution:undefined,createSettingsContribution:undefined}));
afterEach(()=>{cleanup();mountSettings.mockReset();});
const props={modId:'fixture',settingsUrl:'./ModSettingsHostFixture',agents:[],onAgentsChanged:async()=>{},navigationTarget:null,overflowTarget:null};
it('contains synchronous mount throws in local error UI',async()=>{
 mountSettings.mockImplementation(()=>{throw new Error('sync failure');});
 render(<ModSettingsHost {...props}/>);
 expect((await screen.findByRole('alert')).textContent).toContain('sync failure');
});
it('detaches a disposed surface before late completion and guards throwing cleanup',async()=>{
 let finish!:(value:()=>void)=>void;
 mountSettings.mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
 const view=render(<ModSettingsHost {...props}/>);
 await waitFor(()=>expect(mountSettings).toHaveBeenCalled());
 const context=mountSettings.mock.calls[0][0];
 view.unmount();
 const node=document.createElement('span');node.textContent='obsolete';context.primary.replace(node);
 const dispose=vi.fn(()=>{throw new Error('cleanup failure');});
 await act(async()=>{finish(dispose);});
 expect(dispose).toHaveBeenCalledTimes(1);
 expect(node.isConnected).toBe(false);
});
it('guards successful mount cleanup that throws',async()=>{
 mountSettings.mockReturnValue(()=>{throw new Error('cleanup failure');});
 const view=render(<ModSettingsHost {...props}/>);
 await waitFor(()=>expect(mountSettings).toHaveBeenCalled());
 await act(async()=>{});
 expect(()=>view.unmount()).not.toThrow();
});

it('FE038 mounts and removes the real dynamically imported surface under StrictMode',async()=>{
 vi.doUnmock('./ModSettingsHostFixture');
 const view=render(<StrictMode><ModSettingsHost {...props}/></StrictMode>);
 expect(await screen.findByText('Fixture mounted')).toBeTruthy();
 view.unmount();
 expect(screen.queryByText('Fixture mounted')).toBeNull();
});
it('FE038 contains real settings factory synchronous errors',async()=>{
 render(<ModSettingsHost {...props} settingsUrl="./ModFactoryFixture"/>);
 expect((await screen.findByRole('alert')).textContent).toContain('factory failure');
});
