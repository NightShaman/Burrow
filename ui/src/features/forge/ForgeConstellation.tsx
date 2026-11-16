import { useEffect, useRef, useState } from 'react';

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
    const ctx = el.getContext('2d');
    if (!ctx) return;
    const host = el.parentElement!.parentElement!;
    let width = 0,
      height = 0,
      frame = 0;
    let pointer: { x: number; y: number } | null = null;
    let ripples: { x: number; y: number; born: number }[] = [];
    let lastRipple = 0;
    const draw = (time: number) => {
      frame = 0;
      ctx.clearRect(0, 0, width, height);
      if (pointer) {
        const light = ctx.createRadialGradient(pointer.x, pointer.y, 0, pointer.x, pointer.y, 160);
        light.addColorStop(0, '#f6b7ff38');
        light.addColorStop(1, '#c785ff00');
        ctx.fillStyle = light;
        ctx.fillRect(0, 0, width, height);
      }
      ripples = ripples.filter((r) => time - r.born < 1100);
      for (const r of ripples) {
        const age = (time - r.born) / 1100;
        ctx.strokeStyle = `rgba(225,185,255,${(1 - age) * 0.7})`;
        ctx.lineWidth = 1.8;
        ctx.beginPath();
        ctx.arc(r.x, r.y, 8 + age * 105, 0, Math.PI * 2);
        ctx.stroke();
      }
      if (!document.hidden && ripples.length) frame = requestAnimationFrame(draw);
    };
    const requestDraw = () => {
      if (!frame && !document.hidden) frame = requestAnimationFrame(draw);
    };
    const resize = () => {
      const rect = host.getBoundingClientRect();
      width = rect.width;
      height = rect.height;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      el.width = Math.round(width * dpr);
      el.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      requestDraw();
    };
    const move = (event: PointerEvent) => {
      const rect = host.getBoundingClientRect();
      pointer = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      const now = performance.now();
      if (now - lastRipple > 140) {
        ripples.push({ ...pointer, born: now });
        ripples = ripples.slice(-8);
        lastRipple = now;
      }
      requestDraw();
    };
    const leave = () => {
      pointer = null;
      requestDraw();
    };
    const visibility = () => {
      cancelAnimationFrame(frame);
      frame = 0;
      pointer = null;
      ripples = [];
      ctx.clearRect(0, 0, width, height);
    };
    resize();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(resize);
    observer?.observe(host);
    window.addEventListener('resize', resize);
    host.addEventListener('pointermove', move);
    host.addEventListener('pointerleave', leave);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener('resize', resize);
      host.removeEventListener('pointermove', move);
      host.removeEventListener('pointerleave', leave);
      document.removeEventListener('visibilitychange', visibility);
      ctx.clearRect(0, 0, width, height);
      el.width = 0;
      el.height = 0;
    };
  }, [enabled, reduced]);
  return (
    <div className="forge-home-constellation" aria-hidden="true">
      <canvas ref={canvas} />
    </div>
  );
}
