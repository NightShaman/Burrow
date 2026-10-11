import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { api } from '../../app/api';
import { SkillRepositoryImport, type SkillPreview } from './SkillRepositoryImport';
vi.mock('../../app/api', async original => ({ ...(await original<typeof import('../../app/api')>()), api: vi.fn() }));
const mocked = vi.mocked(api);
const preview: SkillPreview = { name: 'Review', description: 'Review code', content: '# Review\nComplete instructions', suggestedId: 'review', storage: 'filesystem', revision: 'abc123', contentHash: 'sha256:abc', files: [{path:'SKILL.md',bytes:35,executable:false},{path:'scripts/check.sh',bytes:99,executable:true}], source:{repository:'/repo',path:'skills/review',ref:'HEAD',enabled:false,cron:null,timezone:'UTC',fetchTimeoutMs:120000} };
afterEach(() => { cleanup(); mocked.mockReset(); });
const enterSource = () => {
 fireEvent.change(screen.getByRole('textbox',{name:'Repository'}),{target:{value:'/repo'}});
 fireEvent.change(screen.getByRole('textbox',{name:'Skill path'}),{target:{value:'skills/review'}});
 fireEvent.click(screen.getByRole('button',{name:'Preview skill'}));
};
it('previews without creating a placeholder, derives metadata and installs the exact preview revision', async () => {
 const onInstalled=vi.fn(); const skill={id:'review'};
 mocked.mockImplementation(async path => (path.endsWith('/preview') ? {preview} : {skill}) as never);
 render(<SkillRepositoryImport onInstalled={onInstalled}/>);
 expect(screen.getByRole('button',{name:'Preview skill'})).toHaveProperty('disabled',true);
 expect(screen.queryByRole('textbox',{name:'Install ID'})).toBeNull();
 enterSource();
 await screen.findByRole('button',{name:'Install skill'});
 expect(mocked).toHaveBeenCalledTimes(1);
 expect(JSON.parse(String(mocked.mock.calls[0][1]?.body))).toMatchObject({repository:'/repo',path:'skills/review',ref:'HEAD',cron:null,enabled:false});
 expect(screen.getByText(preview.content, { normalizer: value => value })).toBeTruthy();
 expect(screen.getByText('scripts/check.sh')).toBeTruthy();
 expect(screen.getByText('99 bytes · executable')).toBeTruthy();
 fireEvent.click(screen.getByText('Install ID & availability'));
 fireEvent.change(screen.getByRole('textbox',{name:'Install ID'}),{target:{value:'custom-review'}});
 fireEvent.click(screen.getByRole('checkbox',{name:'Assign globally'}));
 fireEvent.click(screen.getByRole('button',{name:'Install skill'}));
 await waitFor(()=>expect(onInstalled).toHaveBeenCalledWith(skill));
 expect(JSON.parse(String(mocked.mock.calls[1][1]?.body))).toEqual({...preview.source,id:'custom-review',global:true,lifecycle:'available',expectedRevision:'abc123'});
});
it('invalidates preview when the source changes, including advanced options', async () => {
 mocked.mockResolvedValue({preview} as never);
 render(<SkillRepositoryImport onInstalled={vi.fn()}/>); enterSource();
 await screen.findByRole('button',{name:'Install skill'});
 fireEvent.click(screen.getByText('Ref & automatic updates'));
 fireEvent.change(screen.getByRole('textbox',{name:'Ref'}),{target:{value:'v2'}});
 expect(screen.queryByRole('button',{name:'Install skill'})).toBeNull();
 fireEvent.click(screen.getByRole('checkbox',{name:'Automatic sync'}));
 fireEvent.change(screen.getByRole('textbox',{name:'Sync schedule'}),{target:{value:'0 * * * *'}});
 fireEvent.click(screen.getByRole('button',{name:'Preview skill'}));
 await waitFor(()=>expect(mocked).toHaveBeenCalledTimes(2));
 expect(JSON.parse(String(mocked.mock.calls[1][1]?.body))).toMatchObject({ref:'v2',enabled:true,cron:'0 * * * *'});
});
it.each(['skill_revision_changed','skill_already_exists'])('handles %s without overwriting or pretending it installed',async code=>{
 const onInstalled=vi.fn(); mocked.mockResolvedValueOnce({preview} as never).mockRejectedValueOnce(new Error(code));
 render(<SkillRepositoryImport onInstalled={onInstalled}/>); enterSource();
 fireEvent.click(await screen.findByRole('button',{name:'Install skill'}));
 const alert=await screen.findByRole('alert');
 expect(onInstalled).not.toHaveBeenCalled();
 if(code==='skill_revision_changed') { expect(alert.textContent).toContain('Preview again');expect(screen.queryByRole('button',{name:'Install skill'})).toBeNull(); }
 else { expect(alert.textContent).toContain('not been overwritten');expect(screen.getByRole('button',{name:'Install skill'})).toBeTruthy(); }
 expect(mocked).toHaveBeenCalledTimes(2);
});
it('blocks duplicate requests and ignores preview completion after unmount', async()=>{
 let resolve!: (value:never)=>void;
 mocked.mockImplementation(()=>new Promise(r=>{resolve=r;}));
 const view=render(<SkillRepositoryImport onInstalled={vi.fn()}/>); enterSource();
 expect(screen.getByRole('textbox',{name:'Repository'}).matches(':disabled')).toBe(true);
 fireEvent.click(screen.getByRole('button',{name:'Fetching preview…'}));
 expect(mocked).toHaveBeenCalledTimes(1);
 const signal=mocked.mock.calls[0][1]?.signal;
 view.unmount(); expect(signal?.aborted).toBe(true);
 resolve({preview} as never);
});
it('does not offer blind retries after an uncertain install timeout', async()=>{
 mocked.mockResolvedValueOnce({preview} as never).mockRejectedValueOnce(new DOMException('Request deadline exceeded','TimeoutError'));
 render(<SkillRepositoryImport onInstalled={vi.fn()}/>); enterSource();
 fireEvent.click(await screen.findByRole('button',{name:'Install skill'}));
 expect((await screen.findByRole('alert')).textContent).toContain('Reload the library');
 expect(screen.queryByRole('button',{name:'Install skill'})).toBeNull();
});
