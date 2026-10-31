/**
 * Decorative SVG pattern library. Every pattern is generated from a fixed template;
 * user input only ever supplies validated hex colors and numeric opacity, so no
 * user-controlled markup can reach a data URI.
 */

const svg = (w: number, h: number, body: string) =>
  `url("data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns='http://www.w3.org/2000/svg' width='${w}' height='${h}' viewBox='0 0 ${w} ${h}'>${body}</svg>`,
  )}")`;

export interface PatternDef {
  id: string;
  label: string;
  size: number; // tile size in px at scale 1
  render: (color: string, opacity: number) => string;
}

const HEX_RE = /^#[0-9a-fA-F]{6}$/;
const safe = (c: string) => (HEX_RE.test(c) ? c : "#888888");

export const PATTERNS: Record<string, PatternDef> = {
  stars: {
    id: "stars", label: "Star map", size: 220,
    render: (c, o) => svg(220, 220, `<g fill='${safe(c)}' fill-opacity='${o}'><circle cx='20' cy='30' r='1.2'/><circle cx='70' cy='12' r='0.8'/><circle cx='130' cy='48' r='1.6'/><circle cx='190' cy='22' r='1'/><circle cx='45' cy='110' r='0.9'/><circle cx='160' cy='130' r='1.3'/><circle cx='100' cy='170' r='1'/><circle cx='205' cy='190' r='0.7'/><circle cx='15' cy='200' r='1.4'/><circle cx='120' cy='95' r='0.6'/></g><path d='M130 48 L160 130 L100 170 M20 30 L70 12' stroke='${safe(c)}' stroke-opacity='${o * 0.5}' stroke-width='0.5' fill='none'/>`),
  },
  mountains: {
    id: "mountains", label: "Ridgelines", size: 320,
    render: (c, o) => svg(320, 160, `<path d='M0 160 L40 90 L70 120 L120 40 L170 110 L210 70 L260 130 L290 95 L320 140 L320 160Z' fill='${safe(c)}' fill-opacity='${o}'/><path d='M0 160 L60 120 L110 140 L180 95 L240 140 L320 115 L320 160Z' fill='${safe(c)}' fill-opacity='${o * 1.4}'/>`),
  },
  dunes: {
    id: "dunes", label: "Dunes", size: 300,
    render: (c, o) => svg(300, 120, `<path d='M0 80 Q75 40 150 80 T300 80 V120 H0Z' fill='${safe(c)}' fill-opacity='${o}'/><path d='M0 100 Q75 70 150 100 T300 100 V120 H0Z' fill='${safe(c)}' fill-opacity='${o * 1.3}'/>`),
  },
  waves: {
    id: "waves", label: "Waves", size: 120,
    render: (c, o) => svg(120, 40, `<path d='M0 20 Q15 5 30 20 T60 20 T90 20 T120 20' stroke='${safe(c)}' stroke-opacity='${o}' stroke-width='1.5' fill='none'/><path d='M0 35 Q15 22 30 35 T60 35 T90 35 T120 35' stroke='${safe(c)}' stroke-opacity='${o * 0.6}' stroke-width='1' fill='none'/>`),
  },
  leaves: {
    id: "leaves", label: "Leaves", size: 140,
    render: (c, o) => svg(140, 140, `<g fill='${safe(c)}' fill-opacity='${o}'><path d='M30 70 C30 40 60 25 70 20 C70 45 55 65 30 70Z'/><path d='M100 120 C95 95 115 80 130 78 C127 100 118 115 100 120Z'/><path d='M95 35 C110 30 125 40 128 50 C112 55 100 48 95 35Z'/></g><g stroke='${safe(c)}' stroke-opacity='${o}' fill='none' stroke-width='0.8'><path d='M30 70 L70 20'/><path d='M100 120 L130 78'/></g>`),
  },
  deco: {
    id: "deco", label: "Deco fans", size: 80,
    render: (c, o) => svg(80, 40, `<g stroke='${safe(c)}' stroke-opacity='${o}' fill='none' stroke-width='1'><path d='M0 40 A40 40 0 0 1 80 40'/><path d='M10 40 A30 30 0 0 1 70 40'/><path d='M20 40 A20 20 0 0 1 60 40'/><path d='M40 40 L40 0 M40 40 L12 12 M40 40 L68 12'/></g>`),
  },
  grid: {
    id: "grid", label: "Neon grid", size: 48,
    render: (c, o) => svg(48, 48, `<path d='M48 0 H0 V48' stroke='${safe(c)}' stroke-opacity='${o}' stroke-width='1' fill='none'/>`),
  },
  paper: {
    id: "paper", label: "Paper grain", size: 160,
    render: (c, o) => svg(160, 160, `<filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='3' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 1 0'/></filter><rect width='160' height='160' fill='${safe(c)}' filter='url(#n)' opacity='${o}'/>`),
  },
  circuit: {
    id: "circuit", label: "Circuit", size: 120,
    render: (c, o) => svg(120, 120, `<g stroke='${safe(c)}' stroke-opacity='${o}' fill='none' stroke-width='1'><path d='M0 30 H40 L55 45 H120'/><path d='M30 0 V20 L45 35'/><path d='M80 120 V85 L95 70 H120'/><path d='M0 90 H25 L40 75 V60'/></g><g fill='${safe(c)}' fill-opacity='${o * 1.5}'><circle cx='40' cy='30' r='2.5'/><circle cx='45' cy='35' r='2'/><circle cx='95' cy='70' r='2.5'/><circle cx='40' cy='60' r='2.5'/></g>`),
  },
  blossoms: {
    id: "blossoms", label: "Blossoms", size: 160,
    render: (c, o) => {
      const petal = (cx: number, cy: number, r: number) =>
        [0, 72, 144, 216, 288].map((a) => `<ellipse cx='${cx}' cy='${cy - r}' rx='${r * 0.55}' ry='${r}' transform='rotate(${a} ${cx} ${cy})'/>`).join("");
      return svg(160, 160, `<g fill='${safe(c)}' fill-opacity='${o}'>${petal(40, 45, 9)}${petal(120, 115, 7)}${petal(125, 30, 4)}${petal(35, 130, 4)}</g>`);
    },
  },
  embers: {
    id: "embers", label: "Embers", size: 180,
    render: (c, o) => svg(180, 180, `<defs><radialGradient id='g'><stop offset='0' stop-color='${safe(c)}' stop-opacity='${o * 2}'/><stop offset='1' stop-color='${safe(c)}' stop-opacity='0'/></radialGradient></defs><circle cx='30' cy='40' r='6' fill='url(#g)'/><circle cx='120' cy='20' r='4' fill='url(#g)'/><circle cx='150' cy='120' r='7' fill='url(#g)'/><circle cx='70' cy='150' r='5' fill='url(#g)'/><circle cx='95' cy='85' r='3' fill='url(#g)'/>`),
  },
  frost: {
    id: "frost", label: "Frost crystals", size: 140,
    render: (c, o) => {
      const flake = (x: number, y: number, r: number) =>
        [0, 60, 120].map((a) => `<path d='M${x - r} ${y} H${x + r}' transform='rotate(${a} ${x} ${y})'/>`).join("");
      return svg(140, 140, `<g stroke='${safe(c)}' stroke-opacity='${o}' stroke-width='1' stroke-linecap='round'>${flake(35, 35, 12)}${flake(105, 95, 8)}${flake(110, 25, 5)}${flake(30, 115, 6)}</g>`);
    },
  },
  tapestry: {
    id: "tapestry", label: "Damask", size: 64,
    render: (c, o) => svg(64, 64, `<g fill='none' stroke='${safe(c)}' stroke-opacity='${o}' stroke-width='1'><path d='M32 4 L60 32 L32 60 L4 32Z'/><path d='M32 16 L48 32 L32 48 L16 32Z'/><circle cx='32' cy='32' r='4'/><path d='M0 0 L8 8 M64 0 L56 8 M0 64 L8 56 M64 64 L56 56'/></g>`),
  },
  pixels: {
    id: "pixels", label: "Pixels", size: 64,
    render: (c, o) => svg(64, 64, `<g fill='${safe(c)}' fill-opacity='${o}'><rect x='8' y='8' width='4' height='4'/><rect x='12' y='8' width='4' height='4'/><rect x='20' y='8' width='4' height='4'/><rect x='24' y='8' width='4' height='4'/><rect x='4' y='12' width='28' height='4'/><rect x='8' y='16' width='20' height='4'/><rect x='12' y='20' width='12' height='4'/><rect x='16' y='24' width='4' height='4'/><rect x='44' y='44' width='4' height='4'/><rect x='52' y='40' width='4' height='4'/></g>`),
  },
  clouds: {
    id: "clouds", label: "Clouds", size: 260,
    render: (c, o) => svg(260, 160, `<g fill='${safe(c)}' fill-opacity='${o}'><path d='M30 90 a22 22 0 0 1 40 -14 a28 28 0 0 1 52 8 a18 18 0 0 1 4 36 h-90 a16 16 0 0 1 -6 -30z'/><path d='M170 40 a14 14 0 0 1 26 -8 a18 18 0 0 1 32 6 a12 12 0 0 1 2 24 h-58 a11 11 0 0 1 -2 -22z'/></g>`),
  },
  books: {
    id: "books", label: "Book spines", size: 96,
    render: (c, o) => svg(96, 96, `<g fill='${safe(c)}' fill-opacity='${o}'><rect x='4' y='20' width='10' height='76'/><rect x='16' y='8' width='14' height='88'/><rect x='32' y='28' width='8' height='68'/><rect x='42' y='14' width='12' height='82'/><rect x='58' y='22' width='10' height='74' transform='rotate(-6 63 96)'/><rect x='74' y='10' width='16' height='86'/></g><g stroke='${safe(c)}' stroke-opacity='${o * 1.5}'><path d='M16 20 H30 M16 84 H30 M74 22 H90 M74 80 H90'/></g>`),
  },
  prism: {
    id: "prism", label: "Prism facets", size: 120,
    render: (c, o) => svg(120, 104, `<g fill='none' stroke='${safe(c)}' stroke-opacity='${o}' stroke-width='1'><path d='M0 0 L60 104 L120 0Z'/><path d='M30 52 H90'/><path d='M60 0 L30 52 M60 0 L90 52'/></g>`),
  },
  architecture: {
    id: "architecture", label: "Structural lines", size: 200,
    render: (c, o) => svg(200, 200, `<g stroke='${safe(c)}' stroke-opacity='${o}' fill='none' stroke-width='1'><path d='M0 124 H200 M124 0 V200'/><path d='M124 76 H200 M171 76 V124'/><circle cx='124' cy='124' r='76'/></g>`),
  },
  dots: {
    id: "dots", label: "Dots", size: 24,
    render: (c, o) => svg(24, 24, `<circle cx='12' cy='12' r='1.6' fill='${safe(c)}' fill-opacity='${o}'/>`),
  },
  diagonal: {
    id: "diagonal", label: "Diagonal lines", size: 16,
    render: (c, o) => svg(16, 16, `<path d='M-4 4 L4 -4 M0 16 L16 0 M12 20 L20 12' stroke='${safe(c)}' stroke-opacity='${o}' stroke-width='1'/>`),
  },
};

export const PATTERN_IDS = Object.keys(PATTERNS);

export function patternCss(id: string, color: string, opacity: number, scale = 1): { image: string; size: string } | null {
  const p = PATTERNS[id];
  if (!p) return null;
  const s = Math.round(p.size * Math.min(3, Math.max(0.5, scale)));
  return { image: p.render(color, Math.min(1, Math.max(0, opacity))), size: `${s}px auto` };
}
