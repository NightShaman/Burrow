type ForgeEffects = {
  drawWorking(seconds: number, reduced: boolean): void;
  drawBlast(seconds: number, reduced: boolean): void;
  clear(): void;
  dispose(): void;
};

type Point = [number, number];
type DamageSite = [string, string, number, number, number, number];
type Emitter = { x: number; y: number; angle: number };
const SVG_NS = 'http://www.w3.org/2000/svg';
const REVEAL_CLASS = 'forge-reveal-ready';

function randomSequence(initial: number) {
  let seed = initial;
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}

/** Local, caller-clocked decoration only: no job timers, network, or semantic state. */
export function createForgeEffects(root: HTMLElement): ForgeEffects {
  const doc = root.ownerDocument;
  const view = doc.defaultView;
  const grid = root.querySelector<HTMLElement>('.forge-grid');
  const viewer = root.querySelector<HTMLElement>('.forge-viewer-body');
  const sparkCanvas = grid?.querySelector<HTMLCanvasElement>('.forge-seam-sparks');
  const blastCanvas = viewer?.querySelector<HTMLCanvasElement>('.forge-blast');
  const context = (canvas: HTMLCanvasElement | null | undefined) => {
    try { return canvas?.getContext('2d') ?? null; } catch { return null; }
  };
  const sparkCtx = context(sparkCanvas);
  const blastCtx = context(blastCanvas);
  const damageLayers: HTMLElement[] = [];
  const observers: ResizeObserver[] = [];
  let disposed = false;
  let sparkW = 0, sparkH = 0, width = 0, height = 0;
  let emitters: Emitter[] = [];
  const crackRand = randomSequence(942);

  function svgNode<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string>) {
    const node = doc.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
    return node;
  }

  // Exact seeded, unequal, tapered openings from the approved pressure study.
  function fracture(svg: SVGSVGElement, x: number, y: number, angle: number, length: number, opening: number, depth: number) {
    const points: Point[] = [[x, y]];
    const steps = 7;
    for (let i = 1; i <= steps; i++) {
      const heading = angle + (crackRand() - .5) * .9;
      const step = length / steps * (.75 + crackRand() * .5);
      x += Math.sin(heading) * step;
      y += Math.cos(heading) * step;
      points.push([x, y]);
    }
    const sides: [Point[], Point[]] = [[], []];
    points.forEach(([px, py], i) => {
      const w = opening * Math.pow(1 - i / steps, 1.3) + .08;
      const prev = points[Math.max(0, i - 1)], next = points[Math.min(steps, i + 1)];
      const dx = next[0] - prev[0], dy = next[1] - prev[1];
      const len = Math.hypot(dx, dy) || 1;
      const nx = dy / len, ny = -dx / len;
      sides[0].push([px + nx * w, py + ny * w]);
      sides[1].push([px - nx * w * .65, py - ny * w * .65]);
    });
    svg.append(svgNode('path', {
      class: 'forge-fracture-void',
      d: 'M' + [...sides[0], ...sides[1].reverse()].map(p => p.join(',')).join('L') + 'Z',
    }));
    for (let i = 0; i < steps; i++) {
      if (crackRand() > .23) svg.append(svgNode('path', {
        class: 'forge-fracture-lip', d: 'M' + sides[0][i].join(',') + 'L' + sides[0][i + 1].join(','),
      }));
    }
    if (depth) for (const index of [2, 4, 5]) {
      const [bx, by] = points[index];
      fracture(svg, bx, by, angle + (index % 2 ? 1 : -1) * (.6 + crackRand() * .55),
        length * (.21 + crackRand() * .18), opening * .36, depth - 1);
    }
    if (opening > 2) for (const i of [1, 3]) {
      const [px, py] = points[i];
      svg.append(svgNode('path', { class: 'forge-fracture-chip', d: `M${px + 4},${py - 3}l3,2 -2,4 -2,-2Z` }));
    }
  }

  function addDamage(selector: string, sites: DamageSite[]) {
    const panel = root.querySelector<HTMLElement>(selector);
    if (!panel) return;
    const layer = doc.createElement('div');
    layer.className = 'forge-damage-layer';
    layer.setAttribute('aria-hidden', 'true');
    for (const [left, top, turn, tier, cw, ch] of sites) {
      const svg = svgNode('svg', { class: 'forge-fracture', viewBox: '0 0 180 125', 'data-tier': String(tier) });
      svg.style.cssText = `left:${left};top:${top};--forge-turn:${turn}deg;--forge-crack-width:${cw}px;--forge-crack-height:${ch}px;--forge-crack-delay:${(layer.children.length % 3) * .12}s`;
      fracture(svg, 90, -3, (crackRand() - .5) * .4, 86 + crackRand() * 24, 2.3 + crackRand() * 1.7, 2);
      layer.append(svg);
    }
    panel.append(layer);
    damageLayers.push(layer);
  }
  addDamage('.forge-studio', [
    ['-65px', '16%', -90, 1, 175, 115], ['calc(100% - 110px)', '-45px', 30, 2, 190, 125],
    ['calc(100% - 100px)', '55%', 90, 1, 180, 120], ['12%', 'calc(100% - 65px)', 180, 2, 190, 125],
    ['-54px', 'calc(100% - 105px)', -130, 2, 150, 100],
  ]);
  addDamage('.forge-preview', [
    ['calc(100% - 125px)', '-45px', 45, 1, 185, 125], ['-70px', '35%', -90, 2, 185, 120],
    ['calc(100% - 98px)', '65%', 90, 2, 180, 120], ['38%', 'calc(100% - 65px)', 180, 2, 210, 125],
    ['-48px', 'calc(100% - 95px)', -135, 2, 155, 105],
  ]);
  addDamage('.forge-history', [
    ['-54px', '-40px', -40, 2, 180, 115], ['calc(100% - 125px)', 'calc(100% - 70px)', 145, 2, 180, 115],
  ]);
  addDamage('.forge-pressure', [
    ['-70px', '-50px', -45, 1, 150, 100], ['calc(100% - 85px)', 'calc(100% - 60px)', 135, 2, 150, 100],
  ]);

  const emitterSites: [string, [number, number, number][]][] = [
    ['.forge-studio', [[.015, .22, -2.5], [.985, .64, -.5]]],
    ['.forge-preview', [[.97, .05, 2.3], [.015, .48, -1.1], [.75, .985, -1.8]]],
    ['.forge-pressure', [[.02, .06, .5], [.98, .94, -2.3]]],
    ['.forge-history', [[.015, .25, -.8]]],
  ];
  function resizeSparks() {
    if (disposed || !grid || !sparkCanvas) return;
    const rect = grid.getBoundingClientRect();
    sparkW = rect.width; sparkH = rect.height;
    const dpr = Math.min(view?.devicePixelRatio || 1, 1.5);
    sparkCanvas.width = Math.round(sparkW * dpr);
    sparkCanvas.height = Math.round(sparkH * dpr);
    sparkCtx?.setTransform(dpr, 0, 0, dpr, 0, 0);
    emitters = [];
    for (const [selector, sites] of emitterSites) {
      const panel = root.querySelector<HTMLElement>(selector);
      // Keep emitter indices stable even when a panel is missing or hidden.
      const r = panel?.getBoundingClientRect();
      for (const [x, y, angle] of sites) emitters.push({
        x: r && r.width ? r.left - rect.left + r.width * x : -10000,
        y: r && r.height ? r.top - rect.top + r.height * y : -10000,
        angle,
      });
    }
  }
  function resizeBlast() {
    if (disposed || !viewer || !blastCanvas) return;
    const rect = viewer.getBoundingClientRect();
    width = rect.width; height = rect.height;
    const dpr = Math.min(view?.devicePixelRatio || 1, 2);
    blastCanvas.width = Math.round(width * dpr);
    blastCanvas.height = Math.round(height * dpr);
    blastCtx?.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  function observe(target: HTMLElement | null, resize: () => void) {
    if (!target || !view?.ResizeObserver) return;
    const observer = new view.ResizeObserver(resize);
    observer.observe(target);
    observers.push(observer);
  }
  resizeSparks(); resizeBlast();
  observe(grid, resizeSparks); observe(viewer, resizeBlast);

  const rand = randomSequence(48);
  const clouds = Array.from({ length: 52 }, () => ({
    a: rand() * Math.PI * 2, d: .18 + rand() * .9, r: .08 + rand() * .16, s: rand(), w: rand() * 6.28,
  }));
  const fragments = Array.from({ length: 34 }, () => ({
    a: rand() * Math.PI * 2, d: .5 + rand(), s: 1 + rand() * 3, delay: rand() * .12,
  }));
  const lowMotion = (reduced: boolean) => reduced || root.classList.contains('forge-motion-reduced')
    || !!view?.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const paused = () => root.classList.contains('forge-motion-paused');
  const time = (seconds: number) => Number.isFinite(seconds) ? Math.max(0, seconds) : 0;

  function drawWorking(seconds: number, reduced: boolean) {
    if (disposed || paused()) return;
    const s = time(seconds), quiet = lowMotion(reduced);
    root.classList.remove(REVEAL_CLASS);
    const growth = Math.min(1, s / 5.5);
    const jitter = quiet ? 0 : (Math.sin(s * 18) * 7 + Math.sin(s * 39) * 4 + Math.sin(s * 7) * 8) * growth;
    root.style.setProperty('--forge-pressure', `${Math.max(3, Math.min(98, 5 + growth * 81 + jitter))}%`);
    sparkCtx?.clearRect(0, 0, sparkW, sparkH);
    if (!sparkCtx || quiet || s < 2.8 || sparkW <= 0 || sparkH <= 0) return;
    const critical = s > 4.7;
    sparkCtx.save();
    sparkCtx.globalCompositeOperation = 'lighter';
    emitters.forEach((e, k) => {
      if (!critical && k !== 0 && k !== 5) return;
      const cadence = .66 + (k % 3) * .13, offset = 2.85 + (k % 4) * .18;
      // Evaluate only the live bursts: bounded work, indefinitely repeating critical physics.
      const cycle = Math.floor((s - offset) / cadence);
      for (let c = Math.max(0, cycle - 1); c <= cycle; c++) {
        const burst = offset + c * cadence;
        for (let i = 0; i < (critical ? 11 : 5); i++) {
          const age = s - burst - i * .019;
          if (age < 0 || age > .64) continue;
          const hash = Math.sin((i + 1) * 127.1 + (k + 1) * 311.7 + c * 74.7) * 43758.5453;
          const n = hash - Math.floor(hash), angle = e.angle + (n - .5) * 1.8, speed = 85 + n * 175;
          const vx = Math.cos(angle) * speed, vy = Math.sin(angle) * speed;
          const px = (t: number) => e.x + vx * t;
          const py = (t: number) => e.y + vy * t + 190 * t * t;
          const tail = Math.max(0, age - .028 - n * .018);
          sparkCtx.globalAlpha = Math.pow(1 - age / .64, 1.1);
          sparkCtx.lineCap = 'round'; sparkCtx.strokeStyle = '#f57a21'; sparkCtx.lineWidth = 2.8;
          sparkCtx.beginPath(); sparkCtx.moveTo(px(tail), py(tail)); sparkCtx.lineTo(px(age), py(age)); sparkCtx.stroke();
          sparkCtx.strokeStyle = age < .2 ? '#fff1c7' : '#ffc064'; sparkCtx.lineWidth = .95; sparkCtx.stroke();
        }
      }
    });
    sparkCtx.restore();
  }

  function drawBlast(seconds: number, reduced: boolean) {
    if (disposed || paused()) return;
    const t = time(seconds);
    // Mask timing is independent of canvas availability and late-cloud fade-out.
    root.classList.toggle(REVEAL_CLASS, t >= .24);
    sparkCtx?.clearRect(0, 0, sparkW, sparkH);
    blastCtx?.clearRect(0, 0, width, height);
    if (!blastCtx || lowMotion(reduced) || width <= 0 || height <= 0) return;
    const ctx = blastCtx, cx = width * .55, cy = height * .46, radiusBase = Math.hypot(width, height) * .65;
    const expand = 1 - Math.exp(-t * 7), fade = Math.max(0, 1 - Math.max(0, t - 1.05) / 1.85);
    if (fade <= 0) return;
    const cover = t < .2 ? t / .2 : t < 1.1 ? 1 : Math.max(0, 1 - (t - 1.1) / 1.25);
    ctx.fillStyle = `rgba(28,26,24,${cover})`; ctx.fillRect(0, 0, width, height);
    for (const p of clouds) {
      const x = cx + Math.cos(p.a) * radiusBase * p.d * expand + Math.sin(t * 2 + p.w) * 18;
      const y = cy + Math.sin(p.a) * radiusBase * .8 * p.d * expand - t * 22;
      const radius = radiusBase * p.r * (.3 + expand * 1.9);
      const hot = Math.max(0, 1 - t / (.55 + p.s * .6)), a = fade * (.78 + p.s * .2);
      const g = ctx.createRadialGradient(x - radius * .15, y - radius * .18, 0, x, y, radius);
      if (hot > .05) {
        g.addColorStop(0, `rgba(255,${Math.round(134 + hot * 81)},${Math.round(37 + hot * 105)},${a})`);
        g.addColorStop(.33, `rgba(218,${Math.round(65 + hot * 44)},17,${a})`);
        g.addColorStop(.7, `rgba(72,43,28,${a})`);
      } else {
        g.addColorStop(0, `rgba(${Math.round(66 + p.s * 28)},${Math.round(63 + p.s * 24)},${Math.round(59 + p.s * 21)},${a})`);
        g.addColorStop(.5, `rgba(42,40,38,${a})`); g.addColorStop(.8, `rgba(28,27,26,${a * .85})`);
      }
      g.addColorStop(1, 'rgba(26,25,24,0)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, radius, 0, Math.PI * 2); ctx.fill();
    }
    if (t < .65) {
      const radius = radiusBase * .26 * expand;
      const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(1, radius));
      core.addColorStop(0, `rgba(255,226,157,${1 - t / .65})`);
      core.addColorStop(.35, `rgba(255,135,29,${1 - t / .65})`);
      core.addColorStop(1, 'rgba(192,49,9,0)');
      ctx.fillStyle = core; ctx.fillRect(cx - radius, cy - radius, radius * 2, radius * 2);
    }
    for (const p of fragments) {
      const age = Math.max(0, t - p.delay);
      if (age > 1.2 || age === 0) continue;
      const dist = radiusBase * p.d * (1 - Math.exp(-age * 3));
      const x = cx + Math.cos(p.a) * dist, y = cy + Math.sin(p.a) * dist + age * age * 70;
      ctx.save(); ctx.translate(x, y); ctx.rotate(p.a + age * 5);
      ctx.globalAlpha = Math.max(0, 1 - age / 1.2); ctx.fillStyle = age < .35 ? '#f4bc73' : '#77716a';
      ctx.fillRect(-p.s / 2, -p.s / 2, p.s * 3, p.s); ctx.restore();
    }
  }

  function clear() {
    sparkCtx?.clearRect(0, 0, sparkW, sparkH);
    blastCtx?.clearRect(0, 0, width, height);
    root.style.removeProperty('--forge-pressure');
    root.classList.remove(REVEAL_CLASS);
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    observers.forEach(observer => observer.disconnect());
    damageLayers.forEach(layer => layer.remove());
    clear();
    // Release backing stores without removing caller-owned canvas elements.
    if (sparkCanvas) { sparkCanvas.width = 0; sparkCanvas.height = 0; }
    if (blastCanvas) { blastCanvas.width = 0; blastCanvas.height = 0; }
    emitters = [];
  }
  return { drawWorking, drawBlast, clear, dispose };
}
