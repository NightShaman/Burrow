import { useEffect, useRef, useState } from 'react';

// Coordinates are deliberately authored, rather than inferred from nearby stars.
export const forgeFigures = [
  {
    name: 'Goblin',
    color: '#9cf6ba',
    className: 'forge-stars-goblin',
    paths: [
      '30,65 8,18 57,39 79,24 101,39 150,18 128,65 126,103 105,133 79,145 53,133 32,103 30,65',
      '30,65 53,54 69,70 48,77 30,65',
      '128,65 105,54 89,70 110,77 128,65',
      '79,72 68,97 89,97',
      '53,111 65,119 79,115 94,119 105,111',
      '57,39 79,49 101,39',
    ],
  },
  {
    name: 'Gerald the octopus',
    color: '#8fe6ff',
    className: 'forge-stars-gerald',
    paths: [
      '53,82 46,58 49,31 64,13 86,7 108,16 121,38 120,62 111,82',
      '64,49 68,53',
      '98,49 102,53',
      '72,68 83,75 94,68',
      '53,82 35,91 14,87 5,73 10,62 20,65 20,74',
      '58,86 36,111 14,116 5,105 11,97 18,101',
      '65,91 49,133 29,146 18,138 23,128 31,130',
      '76,94 71,143 58,162 47,157 49,147',
      '87,94 96,144 108,161 120,155 116,144',
      '98,91 116,130 138,142 149,133 143,123 135,127',
      '106,86 132,109 157,111 165,99 156,92 150,100',
      '111,82 138,87 159,78 165,63 155,55 146,63 151,70',
    ],
  },
  {
    name: 'Kerning the magenta dragon',
    color: '#ff88e7',
    className: 'forge-stars-kerning',
    paths: [
      '89,61 80,36 86,12 100,26 113,22 128,36 151,43 140,56 119,57 112,77 120,101 108,126 84,136 65,124 58,102 70,79 89,61',
      '80,66 56,27 8,5 19,46 6,73 33,63 43,84 63,81',
      '113,72 143,18 187,4 175,44 188,72 161,62 149,86 120,91',
      '56,27 43,84',
      '143,18 149,86',
      '65,124 48,144 21,149 5,137 12,124 24,129 21,137',
      '84,136 76,154 91,154',
      '108,126 121,145 137,145',
      '112,37 116,38',
      '128,46 140,47',
    ],
  },
];

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
        light.addColorStop(0, '#f6b7ff55');
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
      {forgeFigures.map((figure) => (
        <svg
          key={figure.name}
          data-figure={figure.name}
          className={figure.className}
          viewBox="-8 -8 205 180"
          style={{ color: figure.color }}
        >
          {figure.paths.map((path, i) => (
            <polyline key={i} points={path} />
          ))}
          {[...new Set(figure.paths.flatMap((path) => path.split(' ')))].map((point) => {
            const [cx, cy] = point.split(',');
            return <circle key={point} cx={cx} cy={cy} r="2" />;
          })}
        </svg>
      ))}
      <canvas ref={canvas} />
    </div>
  );
}
