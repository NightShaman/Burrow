import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { DeclarativeSection } from './ModSettingsHost';
import { validateSettingsContribution } from './SettingsContribution';
afterEach(cleanup);
const make=(value:string)=>validateSettingsContribution({sections:[{id:'settings',label:'Settings',layout:'list-detail',items:[{id:'one',label:'One',fields:[{id:'name',label:'Name',value}],actions:[{id:'save',label:'Save'}]}]}]})!;
it('refreshes defaults, preserves dirty edits and renders detail without a portal',()=>{
 const first=make('old'); const view=render(<DeclarativeSection contribution={first} section={first.sections[0]} module={{}} overflowTarget={null}/>);
 expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('old');
 fireEvent.change(screen.getByLabelText('Name'),{target:{value:'draft'}});
 const next=make('fresh'); view.rerender(<DeclarativeSection contribution={next} section={next.sections[0]} module={{}} overflowTarget={null}/>);
 expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('draft');
});
it('does not claim success without a handler',async()=>{
 const c=make('old'); render(<DeclarativeSection contribution={c} section={c.sections[0]} module={{}} overflowTarget={null}/>);
 fireEvent.click(screen.getByText('Save')); expect((await screen.findByRole('alert')).textContent).toContain('handler'); expect(screen.queryByText('Saved.')).toBeNull();
});
it('submits successful actions',async()=>{
 const c=make('old'), handler=vi.fn(); render(<DeclarativeSection contribution={c} section={c.sections[0]} module={{handleSettingsAction:handler}} overflowTarget={null}/>);
 fireEvent.click(screen.getByText('Save')); await screen.findByText('Saved.'); expect(handler).toHaveBeenCalledWith('save',{name:'old'});
});

it('refreshes untouched defaults',()=>{const first=make('old');const view=render(<DeclarativeSection contribution={first} section={first.sections[0]} module={{}} overflowTarget={null}/>);const next=make('fresh');view.rerender(<DeclarativeSection contribution={next} section={next.sections[0]} module={{}} overflowTarget={null}/>);expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('fresh');});
