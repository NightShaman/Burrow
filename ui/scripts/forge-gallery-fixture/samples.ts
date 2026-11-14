// Vite-only layout samples: no generated artifacts or persistent placements are modified.
export const gallerySampleFolders = [
  { id: 'sample-portraits', name: 'Portraits', parent: null },
  { id: 'sample-worlds', name: 'Worlds & places', parent: null },
  { id: 'sample-neon', name: 'Neon nights', parent: 'sample-worlds' },
];
const palettes = [
  ['#160c30', '#d946ef', '#22d3ee'],
  ['#081e2e', '#38bdf8', '#a78bfa'],
  ['#27130e', '#fb923c', '#fde68a'],
  ['#0b2721', '#34d399', '#a3e635'],
  ['#23102b', '#fb7185', '#c084fc'],
  ['#181c35', '#818cf8', '#f0abfc'],
];
const subjects = [
  'Neon skyline',
  'Moonlit peaks',
  'Crystal horizon',
  'Golden dunes',
  'Quiet orbit',
  'Emerald valley',
];
export const gallerySamples = Array.from({ length: 54 }, (_, i) => {
  const [bg, color, accent] = palettes[i % palettes.length];
  const w = i % 3 === 0 ? 700 : i % 3 === 1 ? 480 : 600;
  const h = i % 3 === 0 ? 460 : i % 3 === 1 ? 700 : 600;
  const city = i % 2 === 0;
  const shapes = city
    ? Array.from({ length: 11 }, (_, j) => {
        const height = 80 + ((j * 47 + i * 31) % 230);
        return `<rect x="${j * 66 - 15}" y="${h - height}" width="49" height="${height}" fill="${j % 2 ? bg : color}" opacity=".8"/><path d="M${j * 66 + 7} ${h - height + 14}v${height - 20}" stroke="${accent}" stroke-width="3" opacity=".6"/>`;
      }).join('')
    : `<path d="M0 ${h * 0.85} L${w * 0.25} ${h * 0.37} L${w * 0.52} ${h * 0.8} L${w * 0.78} ${h * 0.43} L${w} ${h * 0.8}V${h}H0Z" fill="${color}" opacity=".5"/><path d="M0 ${h} L${w * 0.45} ${h * 0.55} L${w} ${h}Z" fill="${bg}"/>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><defs><linearGradient id="sky" x2=".8" y2="1"><stop stop-color="${bg}"/><stop offset="1" stop-color="${color}"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#sky)"/><circle cx="${w * (0.25 + (i % 4) * 0.15)}" cy="${h * 0.28}" r="${w * 0.12}" fill="${accent}" opacity=".85"/>${shapes}<path d="M0 ${h * 0.89}Q${w / 2} ${h * 0.72} ${w} ${h * 0.94}" fill="none" stroke="${accent}" stroke-width="3" opacity=".65"/></svg>`;
  return {
    id: `sample-${i}`,
    name: `${subjects[i % subjects.length]} · ${String(i + 1).padStart(2, '0')}`,
    src: `data:image/svg+xml,${encodeURIComponent(svg)}`,
  };
});
export const gallerySamplePlacements: Record<string, string | null> = Object.fromEntries(
  gallerySamples.map((picture, i) => [
    picture.id,
    i < 30 ? null : i < 40 ? 'sample-portraits' : i < 50 ? 'sample-worlds' : 'sample-neon',
  ]),
);
