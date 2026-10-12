import { StrictMode, useRef } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useForgeMotion } from './useForgeMotion';
import type { MotionJob } from './forgeMotion';
let frames: Map<number, FrameRequestCallback>; let index=0, now=0;
let media: {matches:boolean;addEventListener:ReturnType<typeof vi.fn>;removeEventListener:ReturnType<typeof vi.fn>};
let visibility: boolean;
function Harness({job,ready=true}:{job:MotionJob;ready?:boolean}) {
 const root=useRef<HTMLElement>(null); const motion=useForgeMotion(root,job,'live',()=>ready);
 return <main ref={root} className="forge-machine"><div className="forge-grid"><canvas className="forge-seam-sparks"/><section className="forge-studio"><div className="forge-pressure"><strong data-forge-meter-state/></div></section><section className="forge-preview"><div className="forge-viewer-body"><div className="forge-output-content"><button>Output action</button></div><canvas className="forge-blast"/></div></section><section className="forge-history"/></div><label><input type="checkbox" checked={motion.enabled} onChange={e=>motion.setEnabled(e.target.checked)}/>Effects</label></main>;
}
const job=(status:string,id='live')=>({id,status,artifacts:[{}]});
function advance(ms:number){act(()=>{for(let i=0;i<ms;i+=40){now+=40;const current=[...frames.values()];frames.clear();current.forEach(cb=>cb(now));}});}
beforeEach(()=>{
 frames=new Map();index=0;now=0;visibility=false;
 media={matches:false,addEventListener:vi.fn(),removeEventListener:vi.fn()};
 vi.stubGlobal('matchMedia',()=>media);
 vi.stubGlobal('requestAnimationFrame',(cb:FrameRequestCallback)=>{frames.set(++index,cb);return index;});
 vi.stubGlobal('cancelAnimationFrame',(id:number)=>frames.delete(id));
 vi.spyOn(HTMLCanvasElement.prototype,'getContext').mockReturnValue(null);
 vi.spyOn(document,'hidden','get').mockImplementation(()=>visibility);
});
afterEach(()=>{cleanup();vi.unstubAllGlobals();vi.restoreAllMocks();});
it('owns one clock and damage set in StrictMode and releases all output masks on unmount',()=>{
 const view=render(<StrictMode><Harness job={job('running')}/></StrictMode>);
 expect(frames.size).toBe(1);expect(document.querySelectorAll('.forge-fracture')).toHaveLength(14);
 advance(6000);expect(document.querySelector('main')?.getAttribute('data-forge-phase')).toBe('critical');
 view.rerender(<StrictMode><Harness job={job('succeeded')}/></StrictMode>);
 const content=document.querySelector<HTMLElement>('.forge-output-content')!;
 expect(content.inert).toBe(true);expect(content.getAttribute('aria-hidden')).toBe('true');
 advance(4000);expect(content.inert).toBe(false);expect(content.hasAttribute('aria-hidden')).toBe(false);
 view.unmount();expect(frames.size).toBe(0);expect(media.removeEventListener).toHaveBeenCalled();
});
it('disabling effects during the blast immediately releases output without changing jobs',()=>{
 const view=render(<Harness job={job('running')}/>);view.rerender(<Harness job={job('succeeded')}/>);advance(1000);
 expect(document.querySelector<HTMLElement>('.forge-output-content')!.inert).toBe(true);
 fireEvent.click(screen.getByRole('checkbox',{name:'Effects'}));
 expect(document.querySelector<HTMLElement>('.forge-output-content')!.inert).toBe(false);
 advance(100);expect(frames.size).toBe(0);expect(screen.getByRole('button',{name:'Output action'})).toBeTruthy();
});
it('hidden tabs pause presentation and visibility resumes with one clock',()=>{
 render(<Harness job={job('running')}/>);advance(1000);
 visibility=true;act(()=>document.dispatchEvent(new Event('visibilitychange')));
 expect(frames.size).toBe(0);
 visibility=false;act(()=>document.dispatchEvent(new Event('visibilitychange')));
 expect(frames.size).toBe(1);advance(80);
 expect(document.querySelector('main')?.getAttribute('data-forge-phase')).toBe('working');
});
it('OS reduced motion disables RAF and never obscures a terminal artifact',()=>{
 media.matches=true;
 const view=render(<Harness job={job('running')}/>);expect(frames.size).toBe(0);
 view.rerender(<Harness job={job('succeeded')}/>);
 expect(document.querySelector<HTMLElement>('.forge-output-content')!.inert).toBe(false);
 expect(frames.size).toBe(0);
});
it('switching selected job mid-reveal drops masks without replaying completed history',()=>{
 const view=render(<Harness job={job('succeeded')}/>);
 expect(document.querySelector<HTMLElement>('.forge-output-content')!.inert).toBe(true);
 view.rerender(<Harness job={job('succeeded','old')}/>);
 expect(document.querySelector<HTMLElement>('.forge-output-content')!.inert).toBe(false);
 view.rerender(<Harness job={job('succeeded')}/>);
 expect(document.querySelector<HTMLElement>('.forge-output-content')!.inert).toBe(false);
});
