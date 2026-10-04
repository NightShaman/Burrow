import { cleanup, fireEvent, render, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { DeclarativeSection } from './ModSettingsHost';
import { validateSettingsContribution } from './SettingsContribution';
afterEach(cleanup);
it.each(['list-detail','form','form-inventory'])('honors controls and boolean payloads in %s', async layout => {
 const contribution = validateSettingsContribution({ sections: [{id:'types',label:'Types',layout:layout as 'list-detail',items:[{id:'item',label:'Item',fields:[{id:'secret',label:'Secret',control:'password',value:'hidden'},{id:'enabled',label:'Enabled',control:'boolean',value:'true'},{id:'count',label:'Count',control:'number',value:'2'},{id:'text',label:'Text',control:'text',value:'plain'},{id:'choice',label:'Choice',control:'select',value:'a',options:[{value:'a',label:'A'}]}],actions:[{id:'save',label:'Save'}]}]}] })!;
 if (layout !== 'list-detail') { const section=contribution.sections[0]; section.fields=section.items![0].fields; section.actions=section.items![0].actions; section.items=[]; }
 const overflow = document.createElement('div'); const handler=vi.fn();
 const view=render(<DeclarativeSection contribution={contribution} section={contribution.sections[0]} module={{handleSettingsAction:handler}} overflowTarget={overflow}/>);
 const ui=within(layout === 'list-detail' ? overflow : view.container);
 expect((ui.getByLabelText('Secret') as HTMLInputElement).type).toBe('password');
 expect((ui.getByLabelText('Enabled') as HTMLInputElement).type).toBe('checkbox');
 expect((ui.getByLabelText('Enabled') as HTMLInputElement).checked).toBe(true);
 expect((ui.getByLabelText('Count') as HTMLInputElement).type).toBe('number');
 expect((ui.getByLabelText('Text') as HTMLInputElement).type).toBe('text');
 expect(ui.getByLabelText('Choice').tagName).toBe('SELECT');
 fireEvent.click(ui.getByLabelText('Enabled')); fireEvent.click(ui.getByText('Save'));
 expect(handler).toHaveBeenCalledWith('save',{secret:'hidden',enabled:false,count:'2',text:'plain',choice:'a'});
});
