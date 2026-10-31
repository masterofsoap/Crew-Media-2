import { z } from "zod";
import { FONT_IDS, THEME_IDS, DEFAULT_THEME_ID, type FontId } from "./themes";
import { PATTERN_IDS } from "./patterns";

/**
 * Profile appearance configuration (version 1).
 * This is a constrained, declarative styling language: every field is an enum, bounded number
 * or validated hex color. It is rendered into scoped CSS custom properties on the profile
 * container only — there is no raw CSS or script, so a profile cannot escape its container or
 * restyle security-critical UI.
 */

export const APPEARANCE_VERSION = 1;

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Use a #RRGGBB color");
const id = z.string().regex(/^[A-Za-z0-9_-]{1,40}$/);
const pct = z.number().int().min(0).max(100);

export const ACCENT_ICONS = ["none", "spark", "heart", "bolt", "leaf", "star", "moon", "sun", "wave", "flame", "crown", "music", "camera", "gamepad", "book", "rocket", "paw", "coffee", "anchor", "diamond"] as const;
export const SECTION_IDS = ["about", "badges", "featured", "widgets", "media", "affiliates", "posts"] as const;
export const WIDGET_TYPES = ["text", "links", "interests", "stats", "countdown", "quote"] as const;

const widget = z.object({
  id,
  type: z.enum(WIDGET_TYPES),
  title: z.string().max(40).default(""),
  body: z.string().max(400).default(""),
  links: z.array(z.object({ label: z.string().min(1).max(40), url: z.string().url().max(300).refine((u) => /^https?:\/\//i.test(u), "http(s) only") })).max(6).default([]),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});
export type ProfileWidget = z.infer<typeof widget>;

export const appearanceSchema = z.object({
  v: z.literal(APPEARANCE_VERSION).default(APPEARANCE_VERSION),
  themeId: z.enum(THEME_IDS as [string, ...string[]]).default(DEFAULT_THEME_ID),
  tone: z.enum(["theme", "light", "dark"]).default("theme"),
  colors: z.object({
    useTheme: z.boolean().default(true),
    accent: hex.default("#3ef0b0"),
    accent2: hex.default("#8b7bff"),
    name: hex.default("#ffffff"),
  }).default({}),
  gradient: z.object({
    enabled: z.boolean().default(false),
    from: hex.default("#3ef0b0"),
    via: hex.default("#26beff"),
    to: hex.default("#8b7bff"),
    angle: z.number().int().min(0).max(360).default(135),
    kind: z.enum(["linear", "radial", "conic"]).default("linear"),
    placement: z.enum(["banner", "background", "card", "name"]).default("banner"),
  }).default({}),
  typography: z.object({
    headingFont: z.enum(["theme", ...FONT_IDS] as [string, ...string[]]).default("theme"),
    bodyFont: z.enum(["theme", ...FONT_IDS] as [string, ...string[]]).default("theme"),
    nameSize: z.number().int().min(18).max(48).default(26),
    nameWeight: z.enum(["400", "600", "700", "800"]).default("800"),
    nameEffect: z.enum(["plain", "gradient", "outline", "shadow", "glow"]).default("plain"),
    handleStyle: z.enum(["plain", "pill", "mono", "subtle"]).default("plain"),
    letterSpacing: z.number().min(-0.05).max(0.3).default(0),
    uppercaseName: z.boolean().default(false),
  }).default({}),
  layout: z.object({
    variant: z.enum(["classic", "centered", "split", "magazine", "compact"]).default("classic"),
    density: z.enum(["cozy", "comfortable", "spacious"]).default("comfortable"),
    cardShape: z.enum(["theme", "rounded", "sharp", "pill", "notched"]).default("theme"),
    radius: z.number().int().min(0).max(40).default(18),
    borderWidth: z.number().int().min(0).max(6).default(1),
    borderStyle: z.enum(["solid", "double", "dashed", "dotted", "groove", "none"]).default("solid"),
    shadow: z.enum(["theme", "none", "soft", "lifted", "dramatic", "offset"]).default("theme"),
    glow: pct.default(0),
    align: z.enum(["left", "center"]).default("left"),
    outline: z.enum(["none", "single", "double", "ornate"]).default("none"),
  }).default({}),
  banner: z.object({
    mediaId: id.nullable().default(null),
    posX: pct.default(50),
    posY: pct.default(50),
    zoom: z.number().int().min(100).max(250).default(100),
    height: z.enum(["short", "medium", "tall"]).default("medium"),
    overlay: z.enum(["none", "fade", "tint", "vignette", "grain", "duotone"]).default("fade"),
    overlayOpacity: pct.default(40),
  }).default({}),
  background: z.object({
    type: z.enum(["theme", "solid", "gradient", "pattern", "image"]).default("theme"),
    color: hex.default("#0d1530"),
    mediaId: id.nullable().default(null),
    pattern: z.enum(PATTERN_IDS as [string, ...string[]]).default("stars"),
    patternColor: hex.default("#ffffff"),
    patternOpacity: pct.default(25),
    patternScale: z.number().min(0.5).max(3).default(1),
    texture: z.enum(["none", "grain", "paper", "linen", "noise"]).default("none"),
    effect: z.enum(["none", "shimmer", "drift", "twinkle", "pulse", "aurora"]).default("none"),
    dim: pct.default(0),
  }).default({}),
  avatar: z.object({
    shape: z.enum(["circle", "squircle", "hexagon", "square", "octagon", "blob"]).default("circle"),
    ring: z.enum(["none", "solid", "gradient", "double", "dashed", "glow"]).default("solid"),
    ringColor: hex.default("#3ef0b0"),
    size: z.enum(["sm", "md", "lg", "xl"]).default("lg"),
    animate: z.boolean().default(true),
  }).default({}),
  accentIcon: z.object({
    icon: z.enum(ACCENT_ICONS).default("none"),
    placement: z.enum(["name", "banner", "corner"]).default("name"),
  }).default({}),
  badges: z.object({
    show: z.boolean().default(true),
    placement: z.enum(["name", "below", "section"]).default("name"),
    size: z.enum(["sm", "md", "lg"]).default("md"),
    showAll: z.boolean().default(false),
  }).default({}),
  bio: z.object({
    layout: z.enum(["paragraph", "card", "quote", "centered"]).default("paragraph"),
  }).default({}),
  sections: z.object({
    order: z.array(z.enum(SECTION_IDS)).default([...SECTION_IDS]),
    hidden: z.array(z.enum(SECTION_IDS)).default([]),
  }).default({}),
  widgets: z.array(widget).max(6).default([]),
  featuredPostIds: z.array(id).max(3).default([]),
  highlightedMediaIds: z.array(id).max(6).default([]),
  motion: z.enum(["full", "reduced", "none"]).default("full"),
});

export type Appearance = z.infer<typeof appearanceSchema>;

export function defaultAppearance(themeId = DEFAULT_THEME_ID): Appearance {
  return appearanceSchema.parse({ themeId });
}

/** Parse untrusted stored/submitted appearance; falls back field-by-field to defaults. */
export function parseAppearance(raw: unknown): Appearance {
  const r = appearanceSchema.safeParse(raw ?? {});
  if (r.success) return normalizeSections(r.data);
  // Salvage: keep valid top-level groups, default the rest.
  const base = defaultAppearance();
  if (raw && typeof raw === "object") {
    for (const key of Object.keys(base) as (keyof Appearance)[]) {
      const candidate = { ...base, [key]: (raw as Record<string, unknown>)[key] };
      const one = appearanceSchema.safeParse(candidate);
      if (one.success) (base as Record<string, unknown>)[key] = one.data[key];
    }
  }
  return normalizeSections(base);
}

function normalizeSections(a: Appearance): Appearance {
  const seen = new Set<string>();
  const order = a.sections.order.filter((s) => (seen.has(s) ? false : (seen.add(s), true)));
  for (const s of SECTION_IDS) if (!seen.has(s)) order.push(s);
  return { ...a, sections: { ...a.sections, order } };
}

export function fontOrTheme(v: string, fallback: FontId): FontId {
  return v === "theme" ? fallback : (v as FontId);
}

/** Built-in presets for the studio. Each is a partial appearance merged over defaults. */
export const APPEARANCE_PRESETS: { id: string; name: string; description: string; value: Partial<Appearance> & Record<string, unknown> }[] = [
  { id: "clean", name: "Clean Slate", description: "Theme defaults, nothing extra.", value: {} },
  {
    id: "neon", name: "Neon Arcade", description: "Glowing name, gradient banner, grid backdrop.",
    value: {
      themeId: "retro-synthwave",
      gradient: { enabled: true, from: "#ff2bd6", via: "#7a2bff", to: "#29e7ff", angle: 120, kind: "linear", placement: "banner" },
      typography: { headingFont: "orbitron", bodyFont: "theme", nameSize: 30, nameWeight: "800", nameEffect: "glow", handleStyle: "mono", letterSpacing: 0.04, uppercaseName: true },
      layout: { variant: "centered", density: "comfortable", cardShape: "notched", radius: 10, borderWidth: 2, borderStyle: "solid", shadow: "dramatic", glow: 60, align: "center", outline: "single" },
      background: { type: "pattern", color: "#13041f", mediaId: null, pattern: "grid", patternColor: "#29e7ff", patternOpacity: 30, patternScale: 1, texture: "none", effect: "pulse", dim: 0 },
      avatar: { shape: "hexagon", ring: "glow", ringColor: "#29e7ff", size: "xl", animate: true },
      accentIcon: { icon: "gamepad", placement: "name" },
    },
  },
  {
    id: "photographer", name: "Darkroom", description: "Tall banner, magazine layout, highlighted media.",
    value: {
      themeId: "minimal-architecture",
      layout: { variant: "magazine", density: "spacious", cardShape: "sharp", radius: 0, borderWidth: 1, borderStyle: "solid", shadow: "none", glow: 0, align: "left", outline: "none" },
      banner: { mediaId: null, posX: 50, posY: 50, zoom: 100, height: "tall", overlay: "vignette", overlayOpacity: 50 },
      typography: { headingFont: "playfair", bodyFont: "theme", nameSize: 40, nameWeight: "400", nameEffect: "plain", handleStyle: "subtle", letterSpacing: -0.02, uppercaseName: false },
      sections: { order: ["media", "about", "featured", "badges", "widgets", "affiliates", "posts"], hidden: [] },
      accentIcon: { icon: "camera", placement: "corner" },
    },
  },
  {
    id: "professional", name: "Storefront", description: "Professional split layout for business identities.",
    value: {
      themeId: "paper-ink",
      layout: { variant: "split", density: "comfortable", cardShape: "rounded", radius: 8, borderWidth: 1, borderStyle: "solid", shadow: "soft", glow: 0, align: "left", outline: "none" },
      typography: { headingFont: "theme", bodyFont: "theme", nameSize: 28, nameWeight: "700", nameEffect: "plain", handleStyle: "pill", letterSpacing: 0, uppercaseName: false },
      bio: { layout: "card" },
      sections: { order: ["about", "affiliates", "featured", "widgets", "badges", "media", "posts"], hidden: [] },
    },
  },
  {
    id: "cozy", name: "Kitchen Table", description: "Warm, soft and family-friendly.",
    value: {
      themeId: "desert-dusk",
      layout: { variant: "classic", density: "cozy", cardShape: "pill", radius: 28, borderWidth: 0, borderStyle: "solid", shadow: "lifted", glow: 0, align: "left", outline: "none" },
      avatar: { shape: "blob", ring: "double", ringColor: "#d4562a", size: "lg", animate: true },
      bio: { layout: "quote" },
      background: { type: "pattern", color: "#f6e6d3", mediaId: null, pattern: "dots", patternColor: "#d4562a", patternOpacity: 20, patternScale: 1, texture: "paper", effect: "none", dim: 0 },
      accentIcon: { icon: "heart", placement: "name" },
    },
  },
  {
    id: "regal", name: "Gilded Crest", description: "Ornate outlines and a crown accent.",
    value: {
      themeId: "royal-tapestry",
      layout: { variant: "centered", density: "spacious", cardShape: "theme", radius: 8, borderWidth: 2, borderStyle: "double", shadow: "theme", glow: 20, align: "center", outline: "ornate" },
      typography: { headingFont: "cinzel", bodyFont: "theme", nameSize: 32, nameWeight: "700", nameEffect: "gradient", handleStyle: "plain", letterSpacing: 0.08, uppercaseName: true },
      gradient: { enabled: true, from: "#e0a43c", via: "#fff1c7", to: "#c2304f", angle: 90, kind: "linear", placement: "name" },
      accentIcon: { icon: "crown", placement: "name" },
      badges: { show: true, placement: "below", size: "lg", showAll: true },
    },
  },
];
