import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { useState } from 'react';
import { DocumentTabs } from './AppChrome';
import { RightRail, CodexAccounts } from '../features/panels/RightRail';
afterEach(cleanup);
it('arrows and Home/End select and focus document tabs', () => {
 function Harness() { const [active, setActive] = useState('a'); return <DocumentTabs tabs={[{id:'a',label:'A',kind:'file'},{id:'b',label:'B',kind:'file'}]} activeTabId={active} onSelect={setActive} onClose={() => {}} />; }
 render(<Harness />); screen.getByRole('tab', {name:'A'}).focus(); fireEvent.keyDown(document.activeElement!, {key:'ArrowRight'});
 expect(document.activeElement).toBe(screen.getByRole('tab', {name:'B'})); expect(document.activeElement?.getAttribute('aria-selected')).toBe('true');
 fireEvent.keyDown(document.activeElement!, {key:'Home'}); expect(document.activeElement).toBe(screen.getByRole('tab', {name:'A'}));
});
it('separator adjusts bounded panel split by keyboard', () => {
 let value = 0;
 render(<RightRail collapsed={false} topPanel="agents" bottomPanel="agents" layout="divided" renderPanel={() => null} onExpand={() => {}} onCollapse={() => {}} onResizeSplit={() => {}} split={50} onSplitChange={next => { value = next; }} />);
 const separator = screen.getByRole('separator'); fireEvent.keyDown(separator, {key:'ArrowDown'}); expect(value).toBe(55); fireEvent.keyDown(separator, {key:'End'}); expect(value).toBe(75);
});
it('account ordering has a button equivalent to drag', () => {
 const moves: string[] = [];
 render(<CodexAccounts accounts={[{id:'a',name:'A',plan:'',status:'Active',used:0,reset:''},{id:'b',name:'B',plan:'',status:'Active',used:0,reset:''}]} onReorder={(source,target) => moves.push(source+target)} />);
 fireEvent.click(screen.getByRole('button', {name:'Move A down'})); expect(moves).toEqual(['ab']);
});
