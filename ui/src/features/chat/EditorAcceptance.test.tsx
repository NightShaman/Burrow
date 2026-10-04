import { useState } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { Editor } from './ChatPage';
import type { Tab } from '../../app/types';
afterEach(cleanup);
const tab: Tab = {id:'file',label:'notes',kind:'file',path:'notes.txt',content:'original',fileLoaded:true};
it.each([{fileLoading:true,fileLoaded:false},{fileError:'offline',fileLoaded:false}])('FE031 blocks editing and saving an unavailable file %j', state => {
 const save=vi.fn(); render(<Editor tab={{...tab,...state}} setTabs={vi.fn()} onSave={save}/>);
 expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(true);
 expect((screen.getByRole('textbox') as HTMLTextAreaElement).readOnly).toBe(true);
 fireEvent.click(screen.getByRole('button')); expect(save).not.toHaveBeenCalled();
});
it('FE030/031 saves the visible edited draft and preserves it on a save failure',async()=>{
 const save=vi.fn().mockRejectedValueOnce(new Error('save offline')).mockResolvedValue(undefined);
 function Fixture(){const [tabs,setTabs]=useState([tab]);return <Editor tab={tabs[0]} setTabs={setTabs} onSave={save}/>;}
 render(<Fixture/>); fireEvent.click(screen.getByRole('button',{name:'Edit'}));
 fireEvent.change(screen.getByRole('textbox'),{target:{value:'my draft'}});
 fireEvent.click(screen.getByRole('button',{name:'Save'}));
 expect((await screen.findByRole('alert')).textContent).toContain('save offline');
 expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('my draft');
 fireEvent.click(screen.getByRole('button',{name:'Save'}));
 await waitFor(()=>expect(save).toHaveBeenCalledTimes(2));
 expect(save.mock.calls[1][1]).toBe('my draft');
});
