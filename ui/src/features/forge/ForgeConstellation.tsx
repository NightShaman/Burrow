import { useEffect, useRef, useState } from 'react';

/** Decorative Home-only animation. Disabled for reduced motion and while hidden. */
export function ForgeConstellation({ enabled }: { enabled: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [reduced, setReduced] = useState(
    () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false,
  );
  useEffect(() => {
    const media = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    const change = () => setReduced(media?.matches ?? false);
    media?.addEventListener('change', change);
    return () => media?.removeEventListener('change', change);
  }, []);
  useEffect(() => {
    const el = canvas.current;
    if (!el || !enabled || reduced) return;
    let ctx: CanvasRenderingContext2D | null;
    try {
      ctx = el.getContext('2d');
    } catch {
      return;
    }
    if (!ctx) return;
    const context = ctx;
    const host = el.parentElement!;
    let width = 0,
      height = 0,
      frame = 0;
    let pointer: { x: number; y: number } | null = null;
    let points: { x: number; y: number; phase: number }[] = [];
    const resize = () => {
      const rect = host.getBoundingClientRect();
      width = rect.width;
      height = rect.height;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      el.width = Math.round(width * dpr);
      el.height = Math.round(height * dpr);
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      const count = Math.min(75, Math.max(18, Math.round((width * height) / 16000)));
      points = Array.from({ length: count }, (_, i) => ({
        x: ((i * 0.61803398875 + 0.08) % 1) * width,
        y: ((i * 0.754877666 + 0.12) % 1) * height,
        phase: i * 2.4,
      }));
    };
    const move = (event: PointerEvent) => {
      const rect = host.getBoundingClientRect();
      pointer = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    };
    const leave = () => {
      pointer = null;
    };
    const draw = (time: number) => {
      frame = 0;
      context.clearRect(0, 0, width, height);
      const color = getComputedStyle(el).color;
      const positions = points.map((p) => {
        let x = p.x + Math.sin(time / 4000 + p.phase) * 5;
        let y = p.y + Math.cos(time / 5000 + p.phase) * 5;
        const distance = pointer ? Math.hypot(pointer.x - x, pointer.y - y) : Infinity;
        const influence = Math.max(0, 1 - distance / 180);
        if (pointer) {
          x += (pointer.x - x) * influence * 0.12;
          y += (pointer.y - y) * influence * 0.12;
        }
        return { x, y, influence };
      });
      context.strokeStyle = color;
      context.fillStyle = color;
      context.lineWidth = 0.8;
      positions.forEach((p, i) => {
        for (let j = i + 1; j < positions.length; j++) {
          const q = positions[j],
            distance = Math.hypot(p.x - q.x, p.y - q.y);
          if (distance < 230) {
            context.globalAlpha =
              (1 - distance / 230) * (0.18 + Math.max(p.influence, q.influence) * 0.38);
            context.beginPath();
            context.moveTo(p.x, p.y);
            context.lineTo(q.x, q.y);
            context.stroke();
          }
        }
        context.globalAlpha = 0.35 + p.influence * 0.5;
        context.beginPath();
        context.arc(p.x, p.y, 1.3 + p.influence * 0.6, 0, Math.PI * 2);
        context.fill();
      });
      context.globalAlpha = 1;
      if (!document.hidden) frame = requestAnimationFrame(draw);
    };
    const visibility = () => {
      cancelAnimationFrame(frame);
      frame = 0;
      pointer = null;
      if (!document.hidden) frame = requestAnimationFrame(draw);
    };
    resize();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(resize);
    observer?.observe(host);
    window.addEventListener('resize', resize);
    host.addEventListener('pointermove', move);
    host.addEventListener('pointerleave', leave);
    document.addEventListener('visibilitychange', visibility);
    if (!document.hidden) frame = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener('resize', resize);
      host.removeEventListener('pointermove', move);
      host.removeEventListener('pointerleave', leave);
      document.removeEventListener('visibilitychange', visibility);
      el.width = 0;
      el.height = 0;
    };
  }, [enabled, reduced]);
  return <canvas ref={canvas} className="forge-home-constellation" aria-hidden="true" />;
}
