import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { createForgeEffects } from './forgeEffects';
import { ForgeMotion } from './forgeMotion';
import type { MotionJob } from './forgeMotion';

export function useForgeMotion(root: RefObject<HTMLElement | null>, job: MotionJob | undefined, submittedId: string, ready: () => boolean) {
  const [enabled, setEnabled] = useState(true);
  const [systemReduced, setSystemReduced] = useState(() => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false);
  const controller = useRef(new ForgeMotion());
  const effects = useRef<ReturnType<typeof createForgeEffects> | null>(null);
  const clock = useRef({ frame: 0, last: 0 });
  const current = useRef({ job, submittedId, ready, reduced: !enabled || systemReduced });
  const paintRef = useRef<() => void>(() => {});
  const reduced = !enabled || systemReduced;

  const paint = () => {
    const element = root.current;
    if (!element) return;
    const motion = controller.current;
    element.dataset.forgePhase = motion.phase;
    element.classList.toggle('forge-motion-reduced', current.current.reduced);
    element.classList.toggle('forge-motion-paused', document.hidden);
    if (['working', 'stressed', 'critical'].includes(motion.phase)) effects.current?.drawWorking(motion.workingSeconds, current.current.reduced);
    else if (motion.phase === 'delivering') effects.current?.drawBlast(motion.blastSeconds, current.current.reduced);
    else effects.current?.clear();
    const content = element.querySelector<HTMLElement>('.forge-output-content');
    // Do not expose obscured controls to keyboard or assistive technology.
    if (content) {
      content.inert = motion.revealing;
      if (motion.revealing) content.setAttribute('aria-hidden', 'true'); else content.removeAttribute('aria-hidden');
    }
    const meter = element.querySelector<HTMLElement>('[data-forge-meter-state]');
    if (meter) meter.textContent = ({ idle: 'OFFLINE', working: 'WITHIN SPEC', stressed: 'OUTSIDE SPEC', critical: 'PROBABLY FINE', arming: 'ARTIFACT READY', 'bolt-off': 'CONTAINMENT LOST', delivering: 'VENTING', success: 'OFFLINE', failed: 'NO PRESSURE' })[motion.phase];
    if (!['working', 'stressed', 'critical'].includes(motion.phase)) element.style.setProperty('--forge-pressure', motion.phase === 'failed' || motion.phase === 'idle' ? '3%' : '8%');
  };
  const schedule = () => {
    if (clock.current.frame || document.hidden || !controller.current.animating || (current.current.reduced && !controller.current.revealing)) return;
    clock.current.frame = requestAnimationFrame(tick);
  };
  const tick = (now: number) => {
    clock.current.frame = 0;
    const state = current.current;
    controller.current.observe(state.job, state.submittedId, state.job?.status === 'succeeded' && state.ready(), state.reduced);
    const dt = clock.current.last ? (now - clock.current.last) / 1000 : 0;
    clock.current.last = now;
    if (!document.hidden) controller.current.tick(dt);
    paintRef.current();
    schedule();
  };

  useLayoutEffect(() => {
    current.current = { job, submittedId, ready, reduced };
    paintRef.current = paint;
    controller.current.observe(job, submittedId, job?.status === 'succeeded' && ready(), reduced);
    paint();
    schedule();
  });

  useEffect(() => {
    if (!root.current) return;
    effects.current = createForgeEffects(root.current);
    paintRef.current();
    const media = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    const change = () => setSystemReduced(media?.matches ?? false);
    const visibility = () => {
      cancelAnimationFrame(clock.current.frame);
      clock.current.frame = 0; clock.current.last = 0;
      paintRef.current();
      schedule();
    };
    media?.addEventListener('change', change);
    document.addEventListener('visibilitychange', visibility);
    schedule();
    return () => {
      cancelAnimationFrame(clock.current.frame);
      clock.current.frame = 0; clock.current.last = 0;
      media?.removeEventListener('change', change);
      document.removeEventListener('visibilitychange', visibility);
      effects.current?.dispose(); effects.current = null;
      const content = root.current?.querySelector<HTMLElement>('.forge-output-content');
      if (content) { content.inert = false; content.removeAttribute('aria-hidden'); }
    };
  }, []);

  return { enabled: !reduced, setEnabled };
}
