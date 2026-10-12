import { describe, expect, it } from 'vitest';
import { ForgeMotion } from './forgeMotion';
const job = (status: string, id = 'live', artifacts: unknown[] = [{}]) => ({ id, status, artifacts });
const advance = (motion: ForgeMotion, seconds: number) => { for (let t = 0; t < seconds; t += .04) motion.tick(.04); };

describe('Forge presentation truth', () => {
  it('builds pressure and sparks indefinitely without inventing success', () => {
    const motion = new ForgeMotion(); motion.observe(job('running'), '', false, false);
    advance(motion, 600);
    expect(motion.phase).toBe('critical'); expect(motion.revealing).toBe(false);
  });
  it('only reveals a real successful artifact and waits for preview readiness', () => {
    const motion = new ForgeMotion(); motion.observe(job('queued'), '', false, false);
    motion.observe(job('succeeded'), '', false, false); advance(motion, 2);
    expect(motion.phase).toBe('arming');
    motion.observe(job('succeeded'), '', true, false); advance(motion, .08);
    expect(motion.phase).toBe('bolt-off'); advance(motion, .6);
    expect(motion.phase).toBe('delivering'); advance(motion, 3.2);
    expect(motion.phase).toBe('success'); expect(motion.animating).toBe(false);
  });
  it.each(['failed', 'interrupted'])('never celebrates %s and leaves diagnostics accessible', status => {
    const motion = new ForgeMotion(); motion.observe(job('running'), '', false, false);
    motion.observe(job(status), '', true, false); advance(motion, 20);
    expect(motion.phase).toBe('failed'); expect(motion.revealing).toBe(false);
  });
  it('does not celebrate old history, empty success, or replay a completed reveal', () => {
    const motion = new ForgeMotion(); motion.observe(job('succeeded', 'old'), '', true, false);
    expect(motion.phase).toBe('idle');
    motion.observe(job('running'), '', false, false);
    motion.observe(job('succeeded', 'live', []), '', true, false); expect(motion.phase).toBe('idle');
    motion.observe(job('running', 'new'), 'new', false, false);
    motion.observe(job('succeeded', 'new'), 'new', true, false); advance(motion, 4);
    motion.observe(job('succeeded', 'old'), 'new', true, false);
    motion.observe(job('succeeded', 'new'), 'new', true, false);
    expect(motion.phase).toBe('idle');
  });
  it('supports an immediately completed submitted job without celebrating unrelated history', () => {
    const motion = new ForgeMotion(); motion.observe(job('succeeded'), 'live', true, false);
    expect(motion.phase).toBe('arming');
  });
  it('releases output when motion is disabled mid-reveal and does not replay', () => {
    const motion = new ForgeMotion(); motion.observe(job('succeeded'), 'live', true, false);
    advance(motion, 1); motion.observe(job('succeeded'), 'live', true, true);
    expect(motion.phase).toBe('success'); expect(motion.revealing).toBe(false);
    motion.observe(job('succeeded'), 'live', true, false); expect(motion.phase).toBe('success');
  });
  it('times out stalled previews instead of leaving controls hidden forever', () => {
    const motion = new ForgeMotion(); motion.observe(job('succeeded'), 'live', false, false);
    advance(motion, 14); expect(motion.phase).toBe('success');
  });
  it('cancels presentation when switching to another job or empty mode', () => {
    const motion = new ForgeMotion(); motion.observe(job('succeeded'), 'live', true, false);
    motion.observe(undefined, 'live', false, false);
    expect(motion.phase).toBe('idle'); expect(motion.revealing).toBe(false);
  });
});
