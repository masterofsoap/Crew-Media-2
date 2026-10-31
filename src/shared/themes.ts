import { PATTERNS } from "./patterns";

/**
 * Central theme registry. Components never hardcode colors: they consume the CSS custom
 * properties produced by `themeCssVars`. Adding a theme = adding an entry here.
 */

export interface ThemeTokens {
  bg: string; // page base color
  surface: string; // cards
  surface2: string; // raised/inset surfaces, inputs
  text: string;
  muted: string;
  accent: string;
  accent2: string;
  onAccent: string; // text on accent fills
  border: string;
  danger: string;
  success: string;
}

export type FontId =
  | "inter" | "playfair" | "space-grotesk" | "press-start" | "cormorant" | "orbitron" | "fraunces"
  | "jetbrains" | "poiret" | "cinzel" | "quicksand" | "baskerville" | "syne";

export const FONTS: Record<FontId, { label: string; stack: string }> = {
  inter: { label: "Inter", stack: "'Inter', system-ui, sans-serif" },
  playfair: { label: "Playfair Display", stack: "'Playfair Display', Georgia, serif" },
  "space-grotesk": { label: "Space Grotesk", stack: "'Space Grotesk', system-ui, sans-serif" },
  "press-start": { label: "Press Start 2P", stack: "'Press Start 2P', ui-monospace, monospace" },
  cormorant: { label: "Cormorant Garamond", stack: "'Cormorant Garamond', Georgia, serif" },
  orbitron: { label: "Orbitron", stack: "'Orbitron', system-ui, sans-serif" },
  fraunces: { label: "Fraunces", stack: "'Fraunces', Georgia, serif" },
  jetbrains: { label: "JetBrains Mono", stack: "'JetBrains Mono', ui-monospace, monospace" },
  poiret: { label: "Poiret One", stack: "'Poiret One', system-ui, sans-serif" },
  cinzel: { label: "Cinzel", stack: "'Cinzel', Georgia, serif" },
  quicksand: { label: "Quicksand", stack: "'Quicksand', system-ui, sans-serif" },
  baskerville: { label: "Libre Baskerville", stack: "'Libre Baskerville', Georgia, serif" },
  syne: { label: "Syne", stack: "'Syne', system-ui, sans-serif" },
};
export const FONT_IDS = Object.keys(FONTS) as FontId[];

export interface ThemeDef {
  id: string;
  name: string;
  description: string;
  mode: "light" | "dark";
  tokens: ThemeTokens;
  headingFont: FontId;
  bodyFont: FontId;
  headingCase?: "none" | "uppercase";
  headingTracking?: string;
  radius: number; // card radius px
  controlRadius: number; // buttons/inputs
  borderWidth: number;
  shadow: string;
  glow: string; // focus/active glow
  surfaceEffect: "solid" | "glass" | "paper" | "pixel" | "outline";
  /** Layered page backdrop: gradients first, pattern last. */
  backdrop: string[];
  pattern?: { id: string; color: string; opacity: number; scale?: number };
  /** Optional slow ambient animation (disabled under reduced motion). */
  ambient?: "aurora" | "twinkle" | "drift" | "shimmer" | "pulse";
  preview: [string, string, string]; // swatches for the picker
}

const T = (t: ThemeTokens) => t;

export const THEMES: ThemeDef[] = [
  {
    id: "aurora-borealis", name: "Aurora Borealis", description: "Flowing northern-light ribbons over a deep polar night.",
    mode: "dark",
    tokens: T({ bg: "#060b1a", surface: "#0d1530", surface2: "#142046", text: "#e9f3ff", muted: "#93a8c9", accent: "#3ef0b0", accent2: "#8b7bff", onAccent: "#04140f", border: "#22335e", danger: "#ff6b8a", success: "#3ef0b0" }),
    headingFont: "space-grotesk", bodyFont: "inter", radius: 18, controlRadius: 999, borderWidth: 1,
    shadow: "0 10px 40px -12px rgba(62,240,176,.18)", glow: "0 0 0 3px rgba(62,240,176,.35)", surfaceEffect: "glass",
    backdrop: [
      "radial-gradient(ellipse 80% 50% at 20% 0%, rgba(62,240,176,.28), transparent 60%)",
      "radial-gradient(ellipse 60% 40% at 80% 10%, rgba(139,123,255,.30), transparent 60%)",
      "radial-gradient(ellipse 70% 40% at 50% 30%, rgba(38,190,255,.15), transparent 70%)",
      "linear-gradient(180deg, #060b1a 0%, #0a1230 100%)",
    ],
    pattern: { id: "stars", color: "#cfe8ff", opacity: 0.5 },
    ambient: "aurora", preview: ["#060b1a", "#3ef0b0", "#8b7bff"],
  },
  {
    id: "midnight-observatory", name: "Midnight Observatory", description: "Star charts, brass instruments and a restrained celestial glow.",
    mode: "dark",
    tokens: T({ bg: "#070812", surface: "#0e1020", surface2: "#171a30", text: "#ece8dc", muted: "#9a98a8", accent: "#d9b56a", accent2: "#7aa2ff", onAccent: "#140f02", border: "#272a45", danger: "#ff7a7a", success: "#8fd19e" }),
    headingFont: "cormorant", bodyFont: "inter", headingTracking: "0.02em", radius: 12, controlRadius: 10, borderWidth: 1,
    shadow: "0 8px 30px -10px rgba(0,0,0,.6)", glow: "0 0 0 3px rgba(217,181,106,.35)", surfaceEffect: "outline",
    backdrop: [
      "radial-gradient(circle at 85% 15%, rgba(122,162,255,.12), transparent 35%)",
      "radial-gradient(circle at 50% 120%, rgba(217,181,106,.08), transparent 50%)",
      "linear-gradient(#070812, #0b0d1c)",
    ],
    pattern: { id: "stars", color: "#f3e6c4", opacity: 0.7, scale: 1.2 },
    ambient: "twinkle", preview: ["#070812", "#d9b56a", "#7aa2ff"],
  },
  {
    id: "alpine-expedition", name: "Alpine Expedition", description: "Granite surfaces, layered ridgelines and trail-map clarity.",
    mode: "light",
    tokens: T({ bg: "#e8ecee", surface: "#f7f8f7", surface2: "#e2e7e8", text: "#1b2a30", muted: "#5b6d74", accent: "#d2552d", accent2: "#2f6b5e", onAccent: "#ffffff", border: "#c4cdd0", danger: "#c43a3a", success: "#2f6b5e" }),
    headingFont: "syne", bodyFont: "inter", headingCase: "uppercase", headingTracking: "0.06em", radius: 6, controlRadius: 6, borderWidth: 1,
    shadow: "0 2px 0 rgba(27,42,48,.08), 0 10px 24px -14px rgba(27,42,48,.35)", glow: "0 0 0 3px rgba(210,85,45,.3)", surfaceEffect: "solid",
    backdrop: ["linear-gradient(180deg, #dfe6ea 0%, #eef1f1 55%, #cfd8db 100%)"],
    pattern: { id: "mountains", color: "#7f939b", opacity: 0.18, scale: 2 },
    preview: ["#e8ecee", "#d2552d", "#2f6b5e"],
  },
  {
    id: "desert-dusk", name: "Desert Dusk", description: "Sandstone warmth and a horizon sliding into sunset.",
    mode: "light",
    tokens: T({ bg: "#f6e6d3", surface: "#fff6ec", surface2: "#f3e0cb", text: "#3a2318", muted: "#86634f", accent: "#d4562a", accent2: "#8c4a7a", onAccent: "#fff8f2", border: "#e3c6a6", danger: "#b8322b", success: "#5f7c3a" }),
    headingFont: "fraunces", bodyFont: "inter", radius: 22, controlRadius: 999, borderWidth: 1,
    shadow: "0 14px 30px -18px rgba(140,74,40,.45)", glow: "0 0 0 3px rgba(212,86,42,.3)", surfaceEffect: "solid",
    backdrop: [
      "radial-gradient(ellipse 120% 50% at 50% 110%, rgba(212,86,42,.35), transparent 60%)",
      "linear-gradient(180deg, #f9d9b8 0%, #f6e6d3 45%, #efcfae 100%)",
    ],
    pattern: { id: "dunes", color: "#c9875a", opacity: 0.16, scale: 2.5 },
    preview: ["#f6e6d3", "#d4562a", "#8c4a7a"],
  },
  {
    id: "ocean-depths", name: "Ocean Depths", description: "Pressure-dark water, caustic light and bioluminescent accents.",
    mode: "dark",
    tokens: T({ bg: "#021320", surface: "#06213a", surface2: "#0a2d4c", text: "#dff6ff", muted: "#7fa9bf", accent: "#22d3ee", accent2: "#5eead4", onAccent: "#012029", border: "#11406a", danger: "#fb7185", success: "#5eead4" }),
    headingFont: "quicksand", bodyFont: "inter", radius: 20, controlRadius: 14, borderWidth: 1,
    shadow: "0 18px 40px -20px rgba(34,211,238,.35)", glow: "0 0 0 3px rgba(34,211,238,.35)", surfaceEffect: "glass",
    backdrop: [
      "radial-gradient(ellipse 80% 30% at 50% -5%, rgba(94,234,212,.25), transparent 70%)",
      "linear-gradient(180deg, #053049 0%, #021320 60%, #010a12 100%)",
    ],
    pattern: { id: "waves", color: "#5eead4", opacity: 0.12, scale: 2 },
    ambient: "drift", preview: ["#021320", "#22d3ee", "#5eead4"],
  },
  {
    id: "botanical-conservatory", name: "Botanical Conservatory", description: "Glasshouse greens, pressed leaves and natural linen.",
    mode: "light",
    tokens: T({ bg: "#eef2e6", surface: "#fbfcf7", surface2: "#e5ecd9", text: "#1f2d1c", muted: "#5d6d55", accent: "#3f7d3a", accent2: "#b9781f", onAccent: "#f6fbf2", border: "#cbd8bb", danger: "#b4432f", success: "#3f7d3a" }),
    headingFont: "fraunces", bodyFont: "quicksand", radius: 16, controlRadius: 12, borderWidth: 1,
    shadow: "0 10px 26px -16px rgba(31,45,28,.4)", glow: "0 0 0 3px rgba(63,125,58,.3)", surfaceEffect: "solid",
    backdrop: [
      "radial-gradient(circle at 0% 0%, rgba(63,125,58,.18), transparent 40%)",
      "radial-gradient(circle at 100% 100%, rgba(185,120,31,.12), transparent 40%)",
      "linear-gradient(#eef2e6, #e7eddc)",
    ],
    pattern: { id: "leaves", color: "#3f7d3a", opacity: 0.14, scale: 1.4 },
    preview: ["#eef2e6", "#3f7d3a", "#b9781f"],
  },
  {
    id: "art-deco", name: "Art Deco", description: "Lacquered black, gilt fan motifs and confident geometry.",
    mode: "dark",
    tokens: T({ bg: "#0b0b0d", surface: "#141417", surface2: "#1d1d22", text: "#f3ead6", muted: "#a59c86", accent: "#d4af37", accent2: "#2bb3a3", onAccent: "#120e02", border: "#3a3320", danger: "#e0605a", success: "#2bb3a3" }),
    headingFont: "poiret", bodyFont: "inter", headingCase: "uppercase", headingTracking: "0.14em", radius: 2, controlRadius: 2, borderWidth: 1,
    shadow: "0 0 0 1px rgba(212,175,55,.25), 0 16px 30px -18px rgba(0,0,0,.8)", glow: "0 0 0 2px #d4af37", surfaceEffect: "outline",
    backdrop: ["linear-gradient(180deg, #0b0b0d, #121214)"],
    pattern: { id: "deco", color: "#d4af37", opacity: 0.16, scale: 1.2 },
    preview: ["#0b0b0d", "#d4af37", "#2bb3a3"],
  },
  {
    id: "retro-synthwave", name: "Retro Synthwave", description: "Chrome sunsets, neon horizon grids and late-night radio.",
    mode: "dark",
    tokens: T({ bg: "#13041f", surface: "#1d0a30", surface2: "#2a1045", text: "#fde8ff", muted: "#b993cf", accent: "#ff2bd6", accent2: "#29e7ff", onAccent: "#1a0016", border: "#4a1d72", danger: "#ff5470", success: "#29e7ff" }),
    headingFont: "orbitron", bodyFont: "space-grotesk", headingTracking: "0.05em", radius: 10, controlRadius: 6, borderWidth: 1,
    shadow: "0 0 24px -6px rgba(255,43,214,.45)", glow: "0 0 0 2px #29e7ff, 0 0 18px rgba(41,231,255,.6)", surfaceEffect: "glass",
    backdrop: [
      "radial-gradient(circle at 50% 78%, rgba(255,140,40,.55) 0, rgba(255,43,214,.35) 12%, transparent 30%)",
      "linear-gradient(180deg, #13041f 0%, #2b0a45 55%, #13041f 56%, #1d0a30 100%)",
    ],
    pattern: { id: "grid", color: "#ff2bd6", opacity: 0.22 },
    ambient: "pulse", preview: ["#13041f", "#ff2bd6", "#29e7ff"],
  },
  {
    id: "paper-ink", name: "Paper & Ink", description: "Editorial typesetting on toothy paper with ink-black rules.",
    mode: "light",
    tokens: T({ bg: "#f4efe4", surface: "#fbf8f1", surface2: "#efe8d9", text: "#16130f", muted: "#6b6255", accent: "#16130f", accent2: "#b3261e", onAccent: "#fbf8f1", border: "#2a251e", danger: "#b3261e", success: "#2f5d3a" }),
    headingFont: "playfair", bodyFont: "baskerville", radius: 0, controlRadius: 0, borderWidth: 1,
    shadow: "4px 4px 0 rgba(22,19,15,.9)", glow: "0 0 0 2px #b3261e", surfaceEffect: "paper",
    backdrop: ["linear-gradient(#f4efe4, #efe8da)"],
    pattern: { id: "paper", color: "#5a4a30", opacity: 0.12 },
    preview: ["#f4efe4", "#16130f", "#b3261e"],
  },
  {
    id: "celestial-gold", name: "Celestial Gold", description: "Velvet night, hairline gold filigree and constellation accents.",
    mode: "dark",
    tokens: T({ bg: "#0d0a14", surface: "#16111f", surface2: "#201a2c", text: "#f7efdc", muted: "#b2a68c", accent: "#e8c36a", accent2: "#c08cff", onAccent: "#1a1203", border: "#3d3220", danger: "#ff7b7b", success: "#a7d58a" }),
    headingFont: "cinzel", bodyFont: "inter", headingTracking: "0.08em", radius: 14, controlRadius: 999, borderWidth: 1,
    shadow: "0 0 0 1px rgba(232,195,106,.18), 0 20px 40px -24px rgba(232,195,106,.35)", glow: "0 0 0 3px rgba(232,195,106,.4)", surfaceEffect: "outline",
    backdrop: [
      "radial-gradient(circle at 50% -20%, rgba(232,195,106,.18), transparent 50%)",
      "radial-gradient(circle at 100% 100%, rgba(192,140,255,.10), transparent 40%)",
      "linear-gradient(#0d0a14, #120e1b)",
    ],
    pattern: { id: "stars", color: "#e8c36a", opacity: 0.55, scale: 0.9 },
    ambient: "shimmer", preview: ["#0d0a14", "#e8c36a", "#c08cff"],
  },
  {
    id: "cybernetic-circuit", name: "Cybernetic Circuit", description: "Trace lines, terminal type and disciplined electric green.",
    mode: "dark",
    tokens: T({ bg: "#050a08", surface: "#0a1410", surface2: "#0f1d17", text: "#d7ffe9", muted: "#7fa695", accent: "#39ff9f", accent2: "#00b3ff", onAccent: "#00140a", border: "#1b3a2c", danger: "#ff4f6d", success: "#39ff9f" }),
    headingFont: "jetbrains", bodyFont: "space-grotesk", radius: 4, controlRadius: 3, borderWidth: 1,
    shadow: "0 0 0 1px rgba(57,255,159,.15), 0 0 30px -12px rgba(57,255,159,.35)", glow: "0 0 0 2px #39ff9f", surfaceEffect: "outline",
    backdrop: ["linear-gradient(180deg, #050a08, #07110d)"],
    pattern: { id: "circuit", color: "#39ff9f", opacity: 0.16, scale: 1.3 },
    ambient: "pulse", preview: ["#050a08", "#39ff9f", "#00b3ff"],
  },
  {
    id: "cherry-blossom", name: "Cherry Blossom", description: "Pale petals drifting over layered spring silk.",
    mode: "light",
    tokens: T({ bg: "#fdf1f3", surface: "#fffafb", surface2: "#fbe6ea", text: "#3b2228", muted: "#8e6670", accent: "#d64b72", accent2: "#6b8f5b", onAccent: "#fff6f8", border: "#f2cdd6", danger: "#b8323b", success: "#6b8f5b" }),
    headingFont: "cormorant", bodyFont: "quicksand", headingTracking: "0.01em", radius: 24, controlRadius: 999, borderWidth: 1,
    shadow: "0 14px 30px -18px rgba(214,75,114,.4)", glow: "0 0 0 3px rgba(214,75,114,.28)", surfaceEffect: "solid",
    backdrop: [
      "radial-gradient(circle at 10% 10%, rgba(255,183,201,.45), transparent 35%)",
      "radial-gradient(circle at 90% 80%, rgba(214,75,114,.12), transparent 40%)",
      "linear-gradient(#fdf1f3, #fbe9ed)",
    ],
    pattern: { id: "blossoms", color: "#e57c9a", opacity: 0.28 },
    ambient: "drift", preview: ["#fdf1f3", "#d64b72", "#6b8f5b"],
  },
  {
    id: "volcanic-ember", name: "Volcanic Ember", description: "Basalt black, magma seams and drifting embers.",
    mode: "dark",
    tokens: T({ bg: "#0e0907", surface: "#1a110d", surface2: "#251812", text: "#fbe9de", muted: "#b08b78", accent: "#ff6a1a", accent2: "#ffbf3c", onAccent: "#1c0700", border: "#3d2418", danger: "#ff4d4d", success: "#d9c26a" }),
    headingFont: "syne", bodyFont: "inter", headingTracking: "-0.01em", radius: 10, controlRadius: 8, borderWidth: 1,
    shadow: "0 18px 40px -22px rgba(255,106,26,.55)", glow: "0 0 0 3px rgba(255,106,26,.45)", surfaceEffect: "solid",
    backdrop: [
      "radial-gradient(ellipse 100% 40% at 50% 120%, rgba(255,106,26,.45), transparent 60%)",
      "radial-gradient(circle at 20% 30%, rgba(255,191,60,.08), transparent 30%)",
      "linear-gradient(#0e0907, #150c08)",
    ],
    pattern: { id: "embers", color: "#ff8a3c", opacity: 0.4 },
    ambient: "drift", preview: ["#0e0907", "#ff6a1a", "#ffbf3c"],
  },
  {
    id: "arctic-glass", name: "Arctic Glass", description: "Frosted translucent panes over glacier-blue light.",
    mode: "light",
    tokens: T({ bg: "#e6f1f8", surface: "rgba(255,255,255,0.62)", surface2: "rgba(255,255,255,0.45)", text: "#0f2a3d", muted: "#557187", accent: "#0e7cc2", accent2: "#5cc6e8", onAccent: "#ffffff", border: "rgba(14,124,194,0.22)", danger: "#c43b52", success: "#1f8f74" }),
    headingFont: "space-grotesk", bodyFont: "inter", radius: 20, controlRadius: 14, borderWidth: 1,
    shadow: "0 8px 32px -12px rgba(14,60,100,.25), inset 0 1px 0 rgba(255,255,255,.7)", glow: "0 0 0 3px rgba(14,124,194,.3)", surfaceEffect: "glass",
    backdrop: [
      "radial-gradient(circle at 15% 20%, rgba(92,198,232,.45), transparent 40%)",
      "radial-gradient(circle at 85% 70%, rgba(14,124,194,.25), transparent 45%)",
      "linear-gradient(160deg, #f4fafe, #d8e9f4)",
    ],
    pattern: { id: "frost", color: "#0e7cc2", opacity: 0.18 },
    preview: ["#e6f1f8", "#0e7cc2", "#5cc6e8"],
  },
  {
    id: "royal-tapestry", name: "Royal Tapestry", description: "Woven damask in claret and indigo with gilded borders.",
    mode: "dark",
    tokens: T({ bg: "#1a0b1c", surface: "#261229", surface2: "#331a37", text: "#f8e9dc", muted: "#c1a0a8", accent: "#e0a43c", accent2: "#c2304f", onAccent: "#1d1003", border: "#5a2b50", danger: "#ff6a7d", success: "#9ccf8c" }),
    headingFont: "cinzel", bodyFont: "baskerville", headingTracking: "0.06em", radius: 8, controlRadius: 6, borderWidth: 2,
    shadow: "0 0 0 1px rgba(224,164,60,.35), 0 0 0 4px rgba(26,11,28,1), 0 0 0 5px rgba(224,164,60,.25)", glow: "0 0 0 3px rgba(224,164,60,.45)", surfaceEffect: "outline",
    backdrop: [
      "radial-gradient(circle at 50% 0%, rgba(194,48,79,.30), transparent 55%)",
      "linear-gradient(135deg, #1a0b1c, #22102b)",
    ],
    pattern: { id: "tapestry", color: "#e0a43c", opacity: 0.18 },
    preview: ["#1a0b1c", "#e0a43c", "#c2304f"],
  },
  {
    id: "pixel-arcade", name: "Pixel Arcade", description: "Chunky pixels, CRT glow and insert-coin energy.",
    mode: "dark",
    tokens: T({ bg: "#101026", surface: "#1a1a3a", surface2: "#24244d", text: "#f2f2ff", muted: "#9d9dd0", accent: "#ffd23f", accent2: "#ff3f6c", onAccent: "#1a1300", border: "#3f3f8a", danger: "#ff3f6c", success: "#3fff8b" }),
    headingFont: "press-start", bodyFont: "jetbrains", radius: 0, controlRadius: 0, borderWidth: 3,
    shadow: "4px 4px 0 #000", glow: "0 0 0 3px #ffd23f", surfaceEffect: "pixel",
    backdrop: [
      "repeating-linear-gradient(0deg, rgba(0,0,0,.18) 0 2px, transparent 2px 4px)",
      "linear-gradient(#101026, #16163a)",
    ],
    pattern: { id: "pixels", color: "#ff3f6c", opacity: 0.18, scale: 1.5 },
    preview: ["#101026", "#ffd23f", "#ff3f6c"],
  },
  {
    id: "cloudscape", name: "Cloudscape", description: "Airy cumulus, soft daylight and weightless surfaces.",
    mode: "light",
    tokens: T({ bg: "#e9f3ff", surface: "#ffffff", surface2: "#eef5ff", text: "#1d2f4f", muted: "#6b7fa3", accent: "#4a7dff", accent2: "#ff9fb2", onAccent: "#ffffff", border: "#d3e2fa", danger: "#e5484d", success: "#30a46c" }),
    headingFont: "quicksand", bodyFont: "quicksand", radius: 28, controlRadius: 999, borderWidth: 0,
    shadow: "0 20px 40px -24px rgba(74,125,255,.45)", glow: "0 0 0 3px rgba(74,125,255,.3)", surfaceEffect: "solid",
    backdrop: [
      "radial-gradient(ellipse 60% 30% at 20% 15%, rgba(255,255,255,.95), transparent 70%)",
      "radial-gradient(ellipse 50% 25% at 80% 40%, rgba(255,255,255,.85), transparent 70%)",
      "linear-gradient(180deg, #bcd8ff 0%, #e9f3ff 60%, #fff4f6 100%)",
    ],
    pattern: { id: "clouds", color: "#ffffff", opacity: 0.8, scale: 1.4 },
    ambient: "drift", preview: ["#e9f3ff", "#4a7dff", "#ff9fb2"],
  },
  {
    id: "vintage-library", name: "Vintage Library", description: "Oxblood leather, aged vellum and lamplit shelves.",
    mode: "dark",
    tokens: T({ bg: "#1f1510", surface: "#2a1d15", surface2: "#36261b", text: "#f1e4cc", muted: "#b49c7d", accent: "#c8963e", accent2: "#7c2d24", onAccent: "#1c1206", border: "#4d3726", danger: "#e06a5a", success: "#9bb37a" }),
    headingFont: "baskerville", bodyFont: "baskerville", radius: 6, controlRadius: 4, borderWidth: 1,
    shadow: "inset 0 0 0 1px rgba(200,150,62,.15), 0 16px 32px -20px rgba(0,0,0,.8)", glow: "0 0 0 3px rgba(200,150,62,.4)", surfaceEffect: "paper",
    backdrop: [
      "radial-gradient(ellipse 60% 50% at 50% 0%, rgba(255,190,100,.16), transparent 70%)",
      "linear-gradient(#1f1510, #170f0b)",
    ],
    pattern: { id: "books", color: "#c8963e", opacity: 0.08, scale: 1.6 },
    preview: ["#1f1510", "#c8963e", "#7c2d24"],
  },
  {
    id: "prismatic-spectrum", name: "Prismatic Spectrum", description: "Refracted light, iridescent edges and shifting hues.",
    mode: "light",
    tokens: T({ bg: "#f7f6fb", surface: "#ffffff", surface2: "#f1eff8", text: "#1c1830", muted: "#6c6788", accent: "#7c3aed", accent2: "#06b6d4", onAccent: "#ffffff", border: "#e1dcf2", danger: "#e11d48", success: "#059669" }),
    headingFont: "syne", bodyFont: "inter", headingTracking: "-0.02em", radius: 18, controlRadius: 12, borderWidth: 1,
    shadow: "0 12px 30px -16px rgba(124,58,237,.35)", glow: "0 0 0 3px rgba(6,182,212,.35)", surfaceEffect: "solid",
    backdrop: [
      "conic-gradient(from 210deg at 85% 10%, rgba(255,0,128,.10), rgba(255,200,0,.10), rgba(0,220,160,.10), rgba(0,140,255,.12), rgba(160,60,255,.10), rgba(255,0,128,.10))",
      "linear-gradient(#f7f6fb, #f3f1fa)",
    ],
    pattern: { id: "prism", color: "#7c3aed", opacity: 0.08, scale: 1.6 },
    ambient: "shimmer", preview: ["#f7f6fb", "#7c3aed", "#06b6d4"],
  },
  {
    id: "minimal-architecture", name: "Minimal Architecture", description: "Concrete greys, structural rules and generous editorial space.",
    mode: "light",
    tokens: T({ bg: "#f2f2f0", surface: "#fbfbfa", surface2: "#ececea", text: "#121212", muted: "#6f6f6b", accent: "#121212", accent2: "#e4572e", onAccent: "#fbfbfa", border: "#d7d7d3", danger: "#c8372d", success: "#2d7a4f" }),
    headingFont: "inter", bodyFont: "inter", headingTracking: "-0.03em", radius: 0, controlRadius: 0, borderWidth: 1,
    shadow: "none", glow: "0 0 0 2px #e4572e", surfaceEffect: "outline",
    backdrop: ["linear-gradient(#f2f2f0, #f2f2f0)"],
    pattern: { id: "architecture", color: "#121212", opacity: 0.07, scale: 2.5 },
    preview: ["#f2f2f0", "#121212", "#e4572e"],
  },
];

export const DEFAULT_THEME_ID = "aurora-borealis";
export const THEME_IDS = THEMES.map((t) => t.id);
const byId = new Map(THEMES.map((t) => [t.id, t]));
export function getTheme(id: string | null | undefined): ThemeDef {
  return byId.get(id ?? "") ?? byId.get(DEFAULT_THEME_ID)!;
}

/** Produce the CSS custom properties for a theme. Consumed by every component via Tailwind tokens. */
export function themeCssVars(t: ThemeDef): Record<string, string> {
  const layers = [...t.backdrop];
  const sizes = t.backdrop.map(() => "auto");
  if (t.pattern && PATTERNS[t.pattern.id]) {
    const p = PATTERNS[t.pattern.id]!;
    layers.unshift(p.render(t.pattern.color, t.pattern.opacity));
    sizes.unshift(`${Math.round(p.size * (t.pattern.scale ?? 1))}px auto`);
  }
  return {
    "--c-bg": t.tokens.bg,
    "--c-surface": t.tokens.surface,
    "--c-surface2": t.tokens.surface2,
    "--c-text": t.tokens.text,
    "--c-muted": t.tokens.muted,
    "--c-accent": t.tokens.accent,
    "--c-accent2": t.tokens.accent2,
    "--c-on-accent": t.tokens.onAccent,
    "--c-border": t.tokens.border,
    "--c-danger": t.tokens.danger,
    "--c-success": t.tokens.success,
    "--t-font-heading": FONTS[t.headingFont].stack,
    "--t-font-body": FONTS[t.bodyFont].stack,
    "--t-heading-case": t.headingCase ?? "none",
    "--t-heading-tracking": t.headingTracking ?? "normal",
    "--t-radius-card": `${t.radius}px`,
    "--t-radius-control": `${t.controlRadius}px`,
    "--t-border-w": `${t.borderWidth}px`,
    "--t-shadow-card": t.shadow,
    "--t-glow": t.glow,
    "--t-backdrop": layers.join(", "),
    "--t-backdrop-size": sizes.join(", "),
  };
}
