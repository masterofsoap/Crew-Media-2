import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useBlocker } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ACCENT_ICONS, APPEARANCE_PRESETS, SECTION_IDS, WIDGET_TYPES, appearanceSchema, defaultAppearance, parseAppearance, type Appearance, type ProfileWidget,
} from "../../shared/appearance";
import { FONTS, FONT_IDS, THEMES, getTheme } from "../../shared/themes";
import { PATTERNS, PATTERN_IDS } from "../../shared/patterns";
import type { FeedItem, Page, ProfileDetail } from "../../shared/types";
import { errorMessage, get, patch, put, uploadMedia } from "../lib/api";
import { useActive, useSession } from "../lib/session";
import { applyTheme } from "../lib/theme";
import { ProfileCanvas } from "../components/ProfileCanvas";
import { PostCard } from "../components/PostCard";
import { Button, ConfirmDialog, ErrorState, IconButton, Input, Slider, Spinner, Textarea, Toggle } from "../components/ui";
import { Icon } from "../components/Icon";
import { useToast } from "../components/toast";
import { ThemeCard } from "./Themes";

// ───────────── path helpers ─────────────
type Path = string;
function getAt(o: unknown, path: Path): unknown {
  return path.split(".").reduce<unknown>((acc, k) => (acc && typeof acc === "object" ? (acc as Record<string, unknown>)[k] : undefined), o);
}
function setAt<T>(o: T, path: Path, value: unknown): T {
  const [head, ...rest] = path.split(".");
  const obj = (o ?? {}) as Record<string, unknown>;
  return { ...obj, [head!]: rest.length ? setAt(obj[head!], rest.join("."), value) : value } as T;
}

// ───────────── contrast check ─────────────
function lum(hex: string) {
  const c = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => {
    const v = parseInt(c.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}
function contrast(a: string, b: string) {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x! + 0.05) / (y! + 0.05);
}

function useHistory(initial: Appearance) {
  const [state, setState] = useState({ past: [] as Appearance[], present: initial, future: [] as Appearance[] });
  const lastKey = useRef<{ key: string; at: number } | null>(null);
  const set = useCallback((next: Appearance, mergeKey?: string) => {
    setState((s) => {
      const now = Date.now();
      // Consecutive slider/color drags on the same control collapse into one undo step.
      const merge = mergeKey && lastKey.current?.key === mergeKey && now - lastKey.current.at < 600;
      lastKey.current = mergeKey ? { key: mergeKey, at: now } : null;
      return { past: merge ? s.past : [...s.past.slice(-80), s.present], present: next, future: [] };
    });
  }, []);
  const undo = useCallback(() => setState((s) => (s.past.length ? { past: s.past.slice(0, -1), present: s.past[s.past.length - 1]!, future: [s.present, ...s.future] } : s)), []);
  const redo = useCallback(() => setState((s) => (s.future.length ? { past: [...s.past, s.present], present: s.future[0]!, future: s.future.slice(1) } : s)), []);
  const reset = useCallback((a: Appearance) => setState({ past: [], present: a, future: [] }), []);
  return { ...state, set, undo, redo, reset, canUndo: state.past.length > 0, canRedo: state.future.length > 0 };
}

// ───────────── control primitives ─────────────
interface Ctl {
  a: Appearance;
  update: (path: Path, value: unknown, merge?: boolean) => void;
  resetPath: (path: Path) => void;
}

function Row({ label, path, ctl, children }: { label: string; path: Path; ctl: Ctl; children: ReactNode }) {
  const def = getAt(defaultAppearance(ctl.a.themeId), path);
  const changed = JSON.stringify(getAt(ctl.a, path)) !== JSON.stringify(def);
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold">{label}</span>
        {changed ? (
          <button type="button" onClick={() => ctl.resetPath(path)} className="flex items-center gap-1 text-xs text-muted hover:text-accent" aria-label={`Reset ${label}`}>
            <Icon name="reset" size={12} /> Reset
          </button>
        ) : null}
      </div>
      {children}
    </div>
  );
}

function Choice<T extends string>({ ctl, path, label, options, labels }: { ctl: Ctl; path: Path; label: string; options: readonly T[]; labels?: Partial<Record<T, string>> }) {
  const v = getAt(ctl.a, path) as T;
  return (
    <Row label={label} path={path} ctl={ctl}>
      <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label={label}>
        {options.map((o) => (
          <button
            key={o}
            type="button"
            role="radio"
            aria-checked={v === o}
            onClick={() => ctl.update(path, o)}
            className={`rounded-full border px-3 py-1 text-xs font-semibold capitalize transition-colors ${v === o ? "border-accent bg-accent text-on-accent" : "divider bg-surface2 hover:border-accent"}`}
          >
            {labels?.[o] ?? o.replace(/-/g, " ")}
          </button>
        ))}
      </div>
    </Row>
  );
}

function Color({ ctl, path, label }: { ctl: Ctl; path: Path; label: string }) {
  const v = getAt(ctl.a, path) as string;
  return (
    <Row label={label} path={path} ctl={ctl}>
      <div className="flex items-center gap-2">
        <input type="color" value={v} onChange={(e) => ctl.update(path, e.target.value, true)} aria-label={label} className="h-9 w-12 cursor-pointer rounded border divider bg-transparent" />
        <Input value={v} onChange={(e) => /^#[0-9a-fA-F]{0,6}$/.test(e.target.value) && e.target.value.length === 7 && ctl.update(path, e.target.value)} className="!w-28 font-mono text-sm" aria-label={`${label} hex`} maxLength={7} />
      </div>
    </Row>
  );
}

function Range({ ctl, path, label, min, max, step = 1, suffix }: { ctl: Ctl; path: Path; label: string; min: number; max: number; step?: number; suffix?: string }) {
  return (
    <Row label="" path={path} ctl={ctl}>
      <Slider label={label} value={getAt(ctl.a, path) as number} min={min} max={max} step={step} suffix={suffix} onChange={(v) => ctl.update(path, v, true)} />
    </Row>
  );
}

function Check({ ctl, path, label, description }: { ctl: Ctl; path: Path; label: string; description?: string }) {
  return <Toggle checked={!!getAt(ctl.a, path)} onChange={(v) => ctl.update(path, v)} label={label} description={description} />;
}

function ImagePick({ label, current, onPicked, onClear }: { label: string; current: string | null; onPicked: (id: string, url: string) => void; onClear: () => void }) {
  const [progress, setProgress] = useState<number | null>(null);
  const toast = useToast();
  return (
    <div className="space-y-1.5">
      <span className="text-sm font-semibold">{label}</span>
      <div className="flex items-center gap-2">
        {current ? <img src={current} alt="" className="h-12 w-20 rounded-lg object-cover" /> : <div className="grid h-12 w-20 place-items-center rounded-lg bg-surface2 text-muted"><Icon name="image" size={18} /></div>}
        <label className="btn btn-secondary px-3 py-1.5 text-xs">
          {progress !== null ? `${Math.round(progress * 100)}%` : "Upload"}
          <input
            type="file"
            hidden
            accept="image/jpeg,image/png,image/webp,image/gif"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (!f) return;
              setProgress(0);
              try {
                const m = await uploadMedia(f, "profile", setProgress).promise;
                onPicked(m.id, m.url!);
              } catch (err) {
                toast(errorMessage(err), "error");
              } finally {
                setProgress(null);
              }
            }}
          />
        </label>
        {current ? <Button size="sm" variant="ghost" onClick={onClear}>Remove</Button> : null}
      </div>
      <p className="text-[11px] text-muted">Profile artwork doesn't expire (only post and message media does).</p>
    </div>
  );
}

const CATEGORIES = [
  { id: "presets", label: "Presets", icon: "sparkle", simple: true },
  { id: "theme", label: "Theme", icon: "layers", simple: true },
  { id: "colors", label: "Colors & gradient", icon: "palette", simple: true },
  { id: "type", label: "Typography", icon: "type", simple: false },
  { id: "layout", label: "Layout & cards", icon: "monitor", simple: true },
  { id: "banner", label: "Banner", icon: "image", simple: true },
  { id: "background", label: "Background", icon: "wave", simple: false },
  { id: "avatar", label: "Avatar", icon: "user", simple: true },
  { id: "accents", label: "Accents & badges", icon: "star", simple: false },
  { id: "sections", label: "Sections & widgets", icon: "menu", simple: false },
  { id: "featured", label: "Featured & highlights", icon: "pin", simple: false },
  { id: "motion", label: "Motion", icon: "activity", simple: false },
] as const;
type Cat = (typeof CATEGORIES)[number]["id"];

export function Studio() {
  const active = useActive();
  const { refresh } = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const profile = useQuery({ queryKey: ["profile", active.handle], queryFn: () => get<ProfileDetail>(`/profiles/${active.handle}`) });
  const posts = useQuery({ queryKey: ["timeline", active.handle, "posts", "studio"], queryFn: () => get<Page<FeedItem>>(`/profiles/${active.handle}/timeline?tab=posts`) });
  const mediaPosts = useQuery({ queryKey: ["timeline", active.handle, "media", "studio"], queryFn: () => get<Page<FeedItem>>(`/profiles/${active.handle}/timeline?tab=media`) });
  const saved = useMemo(() => (profile.data ? parseAppearance(profile.data.appearance) : null), [profile.data]);
  if (profile.isLoading || !saved) return <div className="flex justify-center py-24">{profile.isError ? <ErrorState error={profile.error} /> : <Spinner size={28} label="Loading studio" />}</div>;
  return <StudioEditor key={active.id} profile={profile.data!} saved={saved} posts={posts.data?.items ?? []} mediaPosts={mediaPosts.data?.items ?? []} onSaved={async () => { await qc.invalidateQueries({ queryKey: ["profile", active.handle] }); await refresh(); toast("Profile appearance saved"); }} />;
}

function StudioEditor({ profile, saved, posts, mediaPosts, onSaved }: { profile: ProfileDetail; saved: Appearance; posts: FeedItem[]; mediaPosts: FeedItem[]; onSaved: () => Promise<void> }) {
  const toast = useToast();
  const h = useHistory(saved);
  const a = h.present;
  const [baseline, setBaseline] = useState(saved);
  const [mode, setMode] = useState<"simple" | "advanced">("simple");
  const [cat, setCat] = useState<Cat>("presets");
  const [device, setDevice] = useState<"desktop" | "mobile">("desktop");
  const [avatar, setAvatar] = useState<{ id: string | null; url: string | null } | null>(null);
  const [bannerUrl, setBannerUrl] = useState<string | null>(profile.bannerUrl);
  const [bgUrl, setBgUrl] = useState<string | null>(a.background.mediaId ? `/api/media/${a.background.mediaId}` : null);
  const [saving, setSaving] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [panelOpen, setPanelOpen] = useState(true);

  const dirty = JSON.stringify(a) !== JSON.stringify(baseline) || avatar !== null;
  const blocker = useBlocker(({ currentLocation, nextLocation }) => dirty && currentLocation.pathname !== nextLocation.pathname);

  useEffect(() => {
    const onBefore = (e: BeforeUnloadEvent) => {
      if (dirty) e.preventDefault();
    };
    window.addEventListener("beforeunload", onBefore);
    return () => window.removeEventListener("beforeunload", onBefore);
  }, [dirty]);

  // The studio previews the profile's theme across the whole app; restore the saved one on exit.
  const baselineRef = useRef(baseline);
  baselineRef.current = baseline;
  useEffect(() => {
    applyTheme(a.themeId);
  }, [a.themeId]);
  useEffect(() => () => applyTheme(baselineRef.current.themeId), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || (e.target as HTMLElement)?.tagName === "INPUT" || (e.target as HTMLElement)?.tagName === "TEXTAREA") return;
      if (e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) h.redo();
        else h.undo();
      } else if (e.key.toLowerCase() === "y") {
        e.preventDefault();
        h.redo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [h]);

  const ctl: Ctl = {
    a,
    update: (path, value, merge) => h.set(setAt(a, path, value), merge ? path : undefined),
    resetPath: (path) => h.set(setAt(a, path, getAt(defaultAppearance(a.themeId), path))),
  };

  const validation = appearanceSchema.safeParse(a);
  const warnings: string[] = [];
  if (!validation.success) warnings.push(...validation.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`));
  if (a.background.type === "image" && !a.background.mediaId) warnings.push("Background is set to Image but no image is uploaded — the theme backdrop will be used.");
  if (a.background.type === "solid") {
    const textColor = getTheme(a.themeId).tokens.text;
    if (/^#[0-9a-f]{6}$/i.test(textColor) && contrast(textColor, a.background.color) < 3) warnings.push("Low contrast: the solid background is close to the theme's text color. Raise contrast or add a dim.");
  }
  if (a.typography.nameEffect === "gradient" && !a.gradient.enabled) warnings.push("Gradient name effect uses your accent colors unless a gradient with Name placement is enabled.");
  if (a.typography.nameEffect === "outline" && a.typography.nameWeight === "400") warnings.push("Outlined names read best at a heavier weight.");

  const save = async () => {
    if (!validation.success) return toast("Fix the highlighted settings first.", "error");
    setSaving(true);
    try {
      const r = await put<{ appearance: Appearance }>("/profiles/me/appearance", a);
      if (avatar) await patch("/profiles/me", { avatarMediaId: avatar.id });
      setBaseline(r.appearance);
      h.reset(r.appearance);
      setAvatar(null);
      await onSaved();
    } catch (e) {
      toast(errorMessage(e), "error");
    } finally {
      setSaving(false);
    }
  };

  const discard = () => {
    h.reset(baseline);
    setAvatar(null);
    setBannerUrl(profile.bannerUrl);
    setConfirmDiscard(false);
  };

  const previewProfile: ProfileDetail = {
    ...profile,
    avatarUrl: avatar ? avatar.url : profile.avatarUrl,
    bannerUrl: a.banner.mediaId ? bannerUrl ?? `/api/media/${a.banner.mediaId}` : null,
  };
  const ownPosts = posts.filter((p) => p.post.author.id === profile.id && !p.repostedBy);
  const featured = ownPosts.map((p) => p.post).filter((p) => a.featuredPostIds.includes(p.id));
  const mediaOptions = mediaPosts.flatMap((p) => p.post.media.filter((m) => m.status === "ready" && m.kind === "image"));

  const visibleCats = CATEGORIES.filter((c) => mode === "advanced" || c.simple);

  const panel = (() => {
    switch (cat) {
      case "presets":
        return (
          <div className="space-y-3">
            <p className="text-sm text-muted">Start from a curated look, then adjust anything. Applying a preset is one undo step.</p>
            <div className="grid gap-2">
              {APPEARANCE_PRESETS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => h.set(parseAppearance({ ...defaultAppearance(), ...p.value, banner: { ...defaultAppearance().banner, ...((p.value.banner as object) ?? {}), mediaId: a.banner.mediaId }, featuredPostIds: a.featuredPostIds, highlightedMediaIds: a.highlightedMediaIds, widgets: a.widgets }))}
                  className="card flex items-center gap-3 p-3 text-left hover:border-accent"
                >
                  <span className="h-10 w-10 shrink-0 rounded-lg" style={{ background: `linear-gradient(135deg, ${getTheme((p.value.themeId as string) ?? a.themeId).tokens.accent}, ${getTheme((p.value.themeId as string) ?? a.themeId).tokens.accent2})` }} />
                  <span>
                    <span className="block font-bold">{p.name}</span>
                    <span className="block text-xs text-muted">{p.description}</span>
                  </span>
                </button>
              ))}
            </div>
            <Button variant="secondary" size="sm" icon="reset" onClick={() => h.set(parseAppearance({ ...defaultAppearance(a.themeId), banner: { ...defaultAppearance().banner, mediaId: a.banner.mediaId } }))}>
              Reset everything to theme defaults
            </Button>
          </div>
        );
      case "theme":
        return (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-2">
              {THEMES.map((t) => (
                <ThemeCard key={t.id} theme={t} selected={a.themeId === t.id} onSelect={() => ctl.update("themeId", t.id)} />
              ))}
            </div>
            <Choice ctl={ctl} path="tone" label="Light / dark variation" options={["theme", "light", "dark"] as const} labels={{ theme: "As designed" }} />
          </div>
        );
      case "colors":
        return (
          <div className="space-y-4">
            <Check ctl={ctl} path="colors.useTheme" label="Use theme colors" description="Turn off to choose your own accent palette." />
            {!a.colors.useTheme ? (
              <>
                <Color ctl={ctl} path="colors.accent" label="Accent" />
                <Color ctl={ctl} path="colors.accent2" label="Secondary accent" />
                <Color ctl={ctl} path="colors.name" label="Name color" />
              </>
            ) : null}
            <div className="border-t divider pt-3">
              <Check ctl={ctl} path="gradient.enabled" label="Custom gradient" />
              {a.gradient.enabled ? (
                <div className="space-y-3">
                  <div className="h-10 rounded-lg" style={{ background: a.gradient.kind === "radial" ? `radial-gradient(circle, ${a.gradient.from}, ${a.gradient.via}, ${a.gradient.to})` : `linear-gradient(${a.gradient.angle}deg, ${a.gradient.from}, ${a.gradient.via}, ${a.gradient.to})` }} />
                  <Color ctl={ctl} path="gradient.from" label="From" />
                  <Color ctl={ctl} path="gradient.via" label="Via" />
                  <Color ctl={ctl} path="gradient.to" label="To" />
                  <Choice ctl={ctl} path="gradient.kind" label="Style" options={["linear", "radial", "conic"] as const} />
                  <Range ctl={ctl} path="gradient.angle" label="Direction" min={0} max={360} suffix="°" />
                  <Choice ctl={ctl} path="gradient.placement" label="Apply to" options={["banner", "background", "card", "name"] as const} />
                </div>
              ) : null}
            </div>
          </div>
        );
      case "type":
        return (
          <div className="space-y-4">
            {(["headingFont", "bodyFont"] as const).map((k) => (
              <Row key={k} label={k === "headingFont" ? "Heading font" : "Body font"} path={`typography.${k}`} ctl={ctl}>
                <select className="input" value={a.typography[k]} onChange={(e) => ctl.update(`typography.${k}`, e.target.value)} aria-label={k}>
                  <option value="theme">Theme default ({FONTS[k === "headingFont" ? getTheme(a.themeId).headingFont : getTheme(a.themeId).bodyFont].label})</option>
                  {FONT_IDS.map((f) => (
                    <option key={f} value={f} style={{ fontFamily: FONTS[f].stack }}>
                      {FONTS[f].label}
                    </option>
                  ))}
                </select>
              </Row>
            ))}
            <Range ctl={ctl} path="typography.nameSize" label="Name size" min={18} max={48} suffix="px" />
            <Choice ctl={ctl} path="typography.nameWeight" label="Name weight" options={["400", "600", "700", "800"] as const} />
            <Choice ctl={ctl} path="typography.nameEffect" label="Name style" options={["plain", "gradient", "outline", "shadow", "glow"] as const} />
            <Range ctl={ctl} path="typography.letterSpacing" label="Letter spacing" min={-0.05} max={0.3} step={0.01} suffix="em" />
            <Check ctl={ctl} path="typography.uppercaseName" label="Uppercase name" />
            <Choice ctl={ctl} path="typography.handleStyle" label="Handle presentation" options={["plain", "pill", "mono", "subtle"] as const} />
            <Choice ctl={ctl} path="bio.layout" label="Bio layout" options={["paragraph", "card", "quote", "centered"] as const} />
          </div>
        );
      case "layout":
        return (
          <div className="space-y-4">
            <Choice ctl={ctl} path="layout.variant" label="Profile layout" options={["classic", "centered", "split", "magazine", "compact"] as const} />
            <Choice ctl={ctl} path="layout.density" label="Spacing & density" options={["cozy", "comfortable", "spacious"] as const} />
            <Choice ctl={ctl} path="layout.align" label="Alignment" options={["left", "center"] as const} />
            <Choice ctl={ctl} path="layout.cardShape" label="Card shape" options={["theme", "rounded", "sharp", "pill", "notched"] as const} />
            {a.layout.cardShape === "rounded" ? <Range ctl={ctl} path="layout.radius" label="Corner radius" min={0} max={40} suffix="px" /> : null}
            <Choice ctl={ctl} path="layout.borderStyle" label="Border style" options={["solid", "double", "dashed", "dotted", "groove", "none"] as const} />
            {mode === "advanced" ? (
              <>
                <Range ctl={ctl} path="layout.borderWidth" label="Border thickness" min={0} max={6} suffix="px" />
                <Choice ctl={ctl} path="layout.shadow" label="Shadow" options={["theme", "none", "soft", "lifted", "dramatic", "offset"] as const} />
                <Range ctl={ctl} path="layout.glow" label="Glow" min={0} max={100} />
                <Choice ctl={ctl} path="layout.outline" label="Decorative outline" options={["none", "single", "double", "ornate"] as const} />
              </>
            ) : null}
          </div>
        );
      case "banner":
        return (
          <div className="space-y-4">
            <ImagePick
              label="Banner image"
              current={a.banner.mediaId ? bannerUrl ?? `/api/media/${a.banner.mediaId}` : null}
              onPicked={(id, url) => {
                setBannerUrl(url);
                ctl.update("banner.mediaId", id);
              }}
              onClear={() => ctl.update("banner.mediaId", null)}
            />
            <Choice ctl={ctl} path="banner.height" label="Height" options={["short", "medium", "tall"] as const} />
            {a.banner.mediaId ? (
              <>
                <Range ctl={ctl} path="banner.posX" label="Horizontal position" min={0} max={100} suffix="%" />
                <Range ctl={ctl} path="banner.posY" label="Vertical position" min={0} max={100} suffix="%" />
                <Range ctl={ctl} path="banner.zoom" label="Zoom / crop" min={100} max={250} suffix="%" />
              </>
            ) : null}
            <Choice ctl={ctl} path="banner.overlay" label="Overlay" options={["none", "fade", "tint", "vignette", "grain", "duotone"] as const} />
            {a.banner.overlay !== "none" ? <Range ctl={ctl} path="banner.overlayOpacity" label="Overlay strength" min={0} max={100} suffix="%" /> : null}
          </div>
        );
      case "background":
        return (
          <div className="space-y-4">
            <Choice ctl={ctl} path="background.type" label="Background" options={["theme", "solid", "gradient", "pattern", "image"] as const} />
            {a.background.type === "solid" || a.background.type === "pattern" ? <Color ctl={ctl} path="background.color" label="Base color" /> : null}
            {a.background.type === "pattern" ? (
              <>
                <Row label="Pattern" path="background.pattern" ctl={ctl}>
                  <div className="grid grid-cols-4 gap-1.5">
                    {PATTERN_IDS.map((id) => (
                      <button
                        key={id}
                        type="button"
                        aria-pressed={a.background.pattern === id}
                        aria-label={PATTERNS[id]!.label}
                        title={PATTERNS[id]!.label}
                        onClick={() => ctl.update("background.pattern", id)}
                        className={`h-12 rounded-lg border-2 ${a.background.pattern === id ? "border-accent" : "border-transparent"}`}
                        style={{ backgroundColor: a.background.color, backgroundImage: PATTERNS[id]!.render(a.background.patternColor, 0.6), backgroundSize: `${PATTERNS[id]!.size / 2}px auto` }}
                      />
                    ))}
                  </div>
                </Row>
                <Color ctl={ctl} path="background.patternColor" label="Pattern color" />
                <Range ctl={ctl} path="background.patternOpacity" label="Pattern opacity" min={0} max={100} suffix="%" />
                <Range ctl={ctl} path="background.patternScale" label="Pattern scale" min={0.5} max={3} step={0.1} suffix="×" />
              </>
            ) : null}
            {a.background.type === "gradient" ? <p className="text-sm text-muted">Uses your custom gradient (Colors & gradient).</p> : null}
            {a.background.type === "image" ? (
              <ImagePick
                label="Background art"
                current={bgUrl}
                onPicked={(id, url) => {
                  setBgUrl(url);
                  ctl.update("background.mediaId", id);
                }}
                onClear={() => (setBgUrl(null), ctl.update("background.mediaId", null))}
              />
            ) : null}
            <Choice ctl={ctl} path="background.texture" label="Texture" options={["none", "grain", "paper", "linen", "noise"] as const} />
            <Choice ctl={ctl} path="background.effect" label="Subtle animation" options={["none", "shimmer", "drift", "twinkle", "pulse", "aurora"] as const} />
            <Range ctl={ctl} path="background.dim" label="Dim (improves readability)" min={0} max={90} suffix="%" />
          </div>
        );
      case "avatar":
        return (
          <div className="space-y-4">
            <ImagePick label="Profile picture" current={avatar ? avatar.url : profile.avatarUrl} onPicked={(id, url) => setAvatar({ id, url })} onClear={() => setAvatar({ id: null, url: null })} />
            <p className="-mt-2 text-[11px] text-muted">Animated GIFs play unless the viewer prefers reduced motion.</p>
            <Choice ctl={ctl} path="avatar.shape" label="Shape" options={["circle", "squircle", "hexagon", "square", "octagon", "blob"] as const} />
            <Choice ctl={ctl} path="avatar.size" label="Size" options={["sm", "md", "lg", "xl"] as const} />
            <Choice ctl={ctl} path="avatar.ring" label="Ring" options={["none", "solid", "gradient", "double", "dashed", "glow"] as const} />
            {a.avatar.ring !== "none" && a.avatar.ring !== "gradient" ? <Color ctl={ctl} path="avatar.ringColor" label="Ring color" /> : null}
          </div>
        );
      case "accents":
        return (
          <div className="space-y-4">
            <Row label="Accent icon" path="accentIcon.icon" ctl={ctl}>
              <div className="grid grid-cols-6 gap-1.5">
                {ACCENT_ICONS.map((i) => (
                  <button key={i} type="button" aria-pressed={a.accentIcon.icon === i} aria-label={i} title={i} onClick={() => ctl.update("accentIcon.icon", i)} className={`grid h-10 place-items-center rounded-lg border ${a.accentIcon.icon === i ? "border-accent bg-accent text-on-accent" : "divider bg-surface2"}`}>
                    {i === "none" ? <Icon name="close" size={16} /> : <Icon name={i} size={18} />}
                  </button>
                ))}
              </div>
            </Row>
            {a.accentIcon.icon !== "none" ? <Choice ctl={ctl} path="accentIcon.placement" label="Icon placement" options={["name", "banner", "corner"] as const} /> : null}
            <div className="border-t divider pt-3">
              <Check ctl={ctl} path="badges.show" label="Show milestone badges" description={profile.milestoneLevel ? undefined : "You'll see these once you reach 5,000 followers."} />
              {a.badges.show ? (
                <div className="space-y-3">
                  <Choice ctl={ctl} path="badges.placement" label="Badge placement" options={["name", "below", "section"] as const} />
                  <Choice ctl={ctl} path="badges.size" label="Badge size" options={["sm", "md", "lg"] as const} />
                  <Check ctl={ctl} path="badges.showAll" label="Show every earned badge" />
                </div>
              ) : null}
            </div>
          </div>
        );
      case "sections":
        return <SectionsEditor ctl={ctl} />;
      case "featured":
        return (
          <div className="space-y-4">
            <div>
              <p className="text-sm font-semibold">Featured posts (up to 3)</p>
              <div className="mt-2 space-y-1.5">
                {ownPosts.length === 0 ? <p className="text-sm text-muted">Write a few posts first.</p> : null}
                {ownPosts.slice(0, 15).map((p) => {
                  const on = a.featuredPostIds.includes(p.post.id);
                  return (
                    <label key={p.post.id} className="flex cursor-pointer items-start gap-2 rounded-lg p-2 hover:bg-surface2">
                      <input
                        type="checkbox"
                        checked={on}
                        disabled={!on && a.featuredPostIds.length >= 3}
                        onChange={() => ctl.update("featuredPostIds", on ? a.featuredPostIds.filter((x) => x !== p.post.id) : [...a.featuredPostIds, p.post.id])}
                        className="mt-1 accent-[var(--c-accent)]"
                      />
                      <span className="line-clamp-2 text-sm">{p.post.text || "(media post)"}</span>
                    </label>
                  );
                })}
              </div>
            </div>
            <div>
              <p className="text-sm font-semibold">Highlighted media (up to 6)</p>
              <p className="text-[11px] text-muted">Post media still expires after 7 days; expired highlights show a placeholder.</p>
              <div className="mt-2 grid grid-cols-4 gap-1.5">
                {mediaOptions.length === 0 ? <p className="col-span-4 text-sm text-muted">No recent images.</p> : null}
                {mediaOptions.map((m) => {
                  const on = a.highlightedMediaIds.includes(m.id);
                  return (
                    <button
                      key={m.id}
                      type="button"
                      aria-pressed={on}
                      disabled={!on && a.highlightedMediaIds.length >= 6}
                      onClick={() => ctl.update("highlightedMediaIds", on ? a.highlightedMediaIds.filter((x) => x !== m.id) : [...a.highlightedMediaIds, m.id])}
                      className={`relative aspect-square overflow-hidden rounded-lg border-2 ${on ? "border-accent" : "border-transparent"}`}
                    >
                      <img src={m.thumbUrl ?? m.url!} alt={m.alt} className="h-full w-full object-cover" />
                      {on ? <Icon name="check" size={16} className="absolute right-1 top-1 rounded-full bg-accent p-0.5 text-on-accent" /> : null}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        );
      case "motion":
        return (
          <div className="space-y-4">
            <Choice ctl={ctl} path="motion" label="Motion on your profile" options={["full", "reduced", "none"] as const} labels={{ full: "Full effects", reduced: "Reduced", none: "None" }} />
            <p className="text-sm text-muted">Visitors who prefer reduced motion never see animated effects, regardless of this setting.</p>
          </div>
        );
    }
  })();

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-30 flex flex-wrap items-center gap-2 border-b divider bg-[color-mix(in_srgb,var(--c-bg)_88%,transparent)] px-4 py-2.5 backdrop-blur-md">
        <div className="mr-auto min-w-0">
          <h1 className="truncate text-lg font-extrabold">Customize @{profile.handle}</h1>
          <p className="text-xs text-muted" aria-live="polite">
            {dirty ? <span className="font-semibold text-accent">● Unsaved changes</span> : "All changes saved"}
          </p>
        </div>
        <div className="flex rounded-full border divider p-0.5 text-xs font-semibold" role="radiogroup" aria-label="Editor mode">
          {(["simple", "advanced"] as const).map((m) => (
            <button key={m} type="button" role="radio" aria-checked={mode === m} onClick={() => (setMode(m), !CATEGORIES.find((c) => c.id === cat)?.simple && m === "simple" && setCat("presets"))} className={`rounded-full px-3 py-1 capitalize ${mode === m ? "bg-accent text-on-accent" : ""}`}>
              {m}
            </button>
          ))}
        </div>
        <IconButton icon="undo" label="Undo (Ctrl+Z)" disabled={!h.canUndo} onClick={h.undo} />
        <IconButton icon="redo" label="Redo (Ctrl+Shift+Z)" disabled={!h.canRedo} onClick={h.redo} />
        <IconButton icon={device === "desktop" ? "monitor" : "phone"} label={`Preview: ${device}. Switch`} onClick={() => setDevice((d) => (d === "desktop" ? "mobile" : "desktop"))} />
        <Button variant="secondary" size="sm" disabled={!dirty} onClick={() => setConfirmDiscard(true)}>
          Discard
        </Button>
        <Button size="sm" disabled={!dirty || !validation.success} loading={saving} onClick={() => void save()}>
          Save
        </Button>
      </header>
      <div className="flex flex-1 flex-col lg:flex-row">
        <aside className={`border-b divider lg:w-[400px] lg:shrink-0 lg:border-b-0 lg:border-r ${panelOpen ? "" : "max-lg:hidden"}`} aria-label="Customization controls">
          <nav className="flex gap-1 overflow-x-auto border-b divider p-2 scrollbar-none" aria-label="Categories">
            {visibleCats.map((c) => (
              <button key={c.id} type="button" onClick={() => setCat(c.id)} aria-current={cat === c.id ? "page" : undefined} className={`flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold ${cat === c.id ? "bg-accent text-on-accent" : "bg-surface2 hover:bg-surface"}`}>
                <Icon name={c.icon} size={14} /> {c.label}
              </button>
            ))}
          </nav>
          <div className="max-h-[45dvh] space-y-4 overflow-y-auto p-4 lg:max-h-[calc(100dvh-120px)]">
            {warnings.length ? (
              <div role="alert" className="space-y-1 rounded-xl border border-[var(--c-danger)] p-3 text-xs">
                {warnings.map((w) => (
                  <p key={w} className="flex gap-1.5"><Icon name="flag" size={14} className="shrink-0 text-danger" /> {w}</p>
                ))}
              </div>
            ) : null}
            {panel}
          </div>
        </aside>
        <button type="button" className="btn btn-ghost py-2 text-xs lg:hidden" onClick={() => setPanelOpen((o) => !o)}>
          {panelOpen ? "Hide controls" : "Show controls"}
        </button>
        <section aria-label="Live preview" className="flex-1 overflow-y-auto bg-surface2/30 p-3 sm:p-6">
          <div className={`mx-auto overflow-hidden rounded-2xl border divider shadow-2xl transition-[max-width] ${device === "mobile" ? "max-w-[390px]" : "max-w-[760px]"}`}>
            <ProfileCanvas
              profile={previewProfile}
              appearance={validation.success ? validation.data : a}
              featured={featured}
              preview
              highlighted={
                a.highlightedMediaIds.length ? (
                  <div className="pc-card p-3">
                    <h2 className="mb-2 px-1 text-sm font-bold uppercase tracking-wide text-muted">Highlights</h2>
                    <div className="grid grid-cols-3 gap-1.5">
                      {a.highlightedMediaIds.map((id) => <img key={id} src={`/api/media/${id}`} alt="" className="aspect-square w-full rounded-lg object-cover" />)}
                    </div>
                  </div>
                ) : null
              }
              actions={<Button size="sm">Follow</Button>}
              postsSection={
                <div className="pc-card pointer-events-none overflow-hidden">
                  {ownPosts.slice(0, 2).map((p) => <PostCard key={p.key} item={p} />)}
                  {!ownPosts.length ? <p className="p-6 text-center text-sm text-muted">Your posts will appear here.</p> : null}
                </div>
              }
            />
          </div>
        </section>
      </div>
      <ConfirmDialog open={confirmDiscard} onClose={() => setConfirmDiscard(false)} title="Discard changes?" body="Your profile will go back to its last saved appearance." confirmLabel="Discard" danger onConfirm={discard} />
      <ConfirmDialog
        open={blocker.state === "blocked"}
        onClose={() => blocker.reset?.()}
        title="Leave without saving?"
        body="You have unsaved appearance changes."
        confirmLabel="Leave"
        danger
        onConfirm={() => blocker.proceed?.()}
      />
    </div>
  );
}

function SectionsEditor({ ctl }: { ctl: Ctl }) {
  const { a } = ctl;
  const order = a.sections.order.filter((s) => s !== "about");
  const move = (i: number, d: -1 | 1) => {
    const next = [...order];
    const j = i + d;
    if (j < 0 || j >= next.length) return;
    [next[i], next[j]] = [next[j]!, next[i]!];
    ctl.update("sections.order", ["about", ...next]);
  };
  const LABELS: Record<string, string> = { badges: "Milestone badges (section placement)", featured: "Featured posts", widgets: "Widgets", media: "Highlighted media", affiliates: "Affiliations", posts: "Posts & replies" };
  const addWidget = (type: ProfileWidget["type"]) =>
    ctl.update("widgets", [...a.widgets, { id: `w${Date.now().toString(36)}`, type, title: type === "links" ? "Links" : type === "countdown" ? "Counting down" : type === "interests" ? "Interests" : type === "stats" ? "By the numbers" : "", body: "", links: [] }]);
  const updateWidget = (i: number, patchW: Partial<ProfileWidget>) => ctl.update("widgets", a.widgets.map((w, j) => (j === i ? { ...w, ...patchW } : w)));
  return (
    <div className="space-y-5">
      <div>
        <p className="mb-2 text-sm font-semibold">Section order & visibility</p>
        <ol className="space-y-1.5">
          {order.map((s, i) => {
            const hidden = a.sections.hidden.includes(s);
            return (
              <li key={s} className="flex items-center gap-2 rounded-lg bg-surface2 px-2 py-1.5 text-sm">
                <span className={`flex-1 ${hidden ? "text-muted line-through" : ""}`}>{LABELS[s] ?? s}</span>
                <IconButton icon="chevronDown" label={`Move ${s} up`} size={14} className="rotate-180" disabled={i === 0} onClick={() => move(i, -1)} />
                <IconButton icon="chevronDown" label={`Move ${s} down`} size={14} disabled={i === order.length - 1} onClick={() => move(i, 1)} />
                {s !== "posts" ? <IconButton icon="eye" label={hidden ? `Show ${s}` : `Hide ${s}`} size={14} active={!hidden} onClick={() => ctl.update("sections.hidden", hidden ? a.sections.hidden.filter((x) => x !== s) : [...a.sections.hidden, s])} /> : null}
              </li>
            );
          })}
        </ol>
        <p className="mt-1 text-[11px] text-muted">The header (name, bio, stats) always stays on top. {SECTION_IDS.length} sections available.</p>
      </div>
      <div className="border-t divider pt-3">
        <p className="mb-2 text-sm font-semibold">Widgets ({a.widgets.length}/6)</p>
        <div className="space-y-3">
          {a.widgets.map((w, i) => (
            <div key={w.id} className="space-y-2 rounded-xl border divider p-3">
              <div className="flex items-center justify-between">
                <span className="chip capitalize">{w.type}</span>
                <IconButton icon="trash" label="Remove widget" size={14} onClick={() => ctl.update("widgets", a.widgets.filter((_, j) => j !== i))} />
              </div>
              <Input value={w.title} maxLength={40} onChange={(e) => updateWidget(i, { title: e.target.value })} placeholder="Title" aria-label="Widget title" />
              {w.type === "text" || w.type === "quote" || w.type === "countdown" ? <Textarea rows={2} maxLength={400} value={w.body} onChange={(e) => updateWidget(i, { body: e.target.value })} placeholder={w.type === "countdown" ? "What are you counting down to?" : "Text"} aria-label="Widget text" /> : null}
              {w.type === "countdown" ? <Input type="date" value={w.date ?? ""} onChange={(e) => updateWidget(i, { date: e.target.value || undefined })} aria-label="Date" /> : null}
              {w.type === "links" ? (
                <div className="space-y-1.5">
                  {w.links.map((l, k) => (
                    <div key={k} className="flex gap-1.5">
                      <Input value={l.label} maxLength={40} onChange={(e) => updateWidget(i, { links: w.links.map((x, m) => (m === k ? { ...x, label: e.target.value } : x)) })} placeholder="Label" aria-label="Link label" />
                      <Input value={l.url} maxLength={300} onChange={(e) => updateWidget(i, { links: w.links.map((x, m) => (m === k ? { ...x, url: e.target.value } : x)) })} placeholder="https://" aria-label="Link URL" />
                      <IconButton icon="close" label="Remove link" size={14} onClick={() => updateWidget(i, { links: w.links.filter((_, m) => m !== k) })} />
                    </div>
                  ))}
                  {w.links.length < 6 ? <Button size="sm" variant="ghost" icon="plus" onClick={() => updateWidget(i, { links: [...w.links, { label: "", url: "https://" }] })}>Add link</Button> : null}
                </div>
              ) : null}
            </div>
          ))}
        </div>
        {a.widgets.length < 6 ? (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {WIDGET_TYPES.map((t) => (
              <Button key={t} size="sm" variant="secondary" icon="plus" onClick={() => addWidget(t)} className="capitalize">
                {t}
              </Button>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
