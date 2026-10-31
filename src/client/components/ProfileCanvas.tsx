import type { CSSProperties, ReactNode } from "react";
import { Link } from "react-router";
import { fontOrTheme, type Appearance, type ProfileWidget } from "../../shared/appearance";
import { FONTS, getTheme, themeCssVars } from "../../shared/themes";
import { patternCss } from "../../shared/patterns";
import { MILESTONES, TOPICS } from "../../shared/constants";
import type { ProfileDetail, PostView } from "../../shared/types";
import { compactNumber, monthYear } from "../lib/format";
import { Avatar } from "./Avatar";
import { Icon } from "./Icon";
import { BadgeStrip, MilestoneBadge } from "./MilestoneBadge";
import { KindChip, RichText } from "./RichText";
import { MediaGrid } from "./MediaGrid";

/**
 * Translate a validated Appearance into scoped CSS variables + classes. Values are only enums,
 * bounded numbers and #hex colors, so nothing user-controlled can become arbitrary CSS, and the
 * variables only apply inside the `.profile-canvas` container.
 */
export function appearanceStyle(a: Appearance): { style: CSSProperties; className: string } {
  const theme = getTheme(a.themeId);
  const vars: Record<string, string> = { ...themeCssVars(theme) };
  // Tone overrides (light/dark variants of any theme).
  if (a.tone === "dark" && theme.mode === "light") Object.assign(vars, { "--c-bg": "#0f1115", "--c-surface": "#171a21", "--c-surface2": "#20242d", "--c-text": "#eef0f4", "--c-muted": "#9aa1ae", "--c-border": "#2b303b" });
  if (a.tone === "light" && theme.mode === "dark") Object.assign(vars, { "--c-bg": "#f6f6f4", "--c-surface": "#ffffff", "--c-surface2": "#efefec", "--c-text": "#16171a", "--c-muted": "#626570", "--c-border": "#dcdcd6" });
  if (!a.colors.useTheme) {
    vars["--c-accent"] = a.colors.accent;
    vars["--c-accent2"] = a.colors.accent2;
  }
  vars["--pc-name-color"] = a.colors.useTheme ? "var(--c-text)" : a.colors.name;
  vars["--t-font-heading"] = FONTS[fontOrTheme(a.typography.headingFont, theme.headingFont)].stack;
  vars["--t-font-body"] = FONTS[fontOrTheme(a.typography.bodyFont, theme.bodyFont)].stack;

  const grad = a.gradient;
  const gradCss =
    grad.kind === "radial" ? `radial-gradient(circle at 30% 30%, ${grad.from}, ${grad.via}, ${grad.to})`
    : grad.kind === "conic" ? `conic-gradient(from ${grad.angle}deg, ${grad.from}, ${grad.via}, ${grad.to}, ${grad.from})`
    : `linear-gradient(${grad.angle}deg, ${grad.from}, ${grad.via}, ${grad.to})`;
  vars["--pc-gradient"] = gradCss;
  vars["--pc-name-gradient"] = grad.enabled && grad.placement === "name" ? gradCss : `linear-gradient(90deg, var(--c-accent), var(--c-accent2))`;

  // Background
  const bg = a.background;
  if (bg.type === "solid") {
    vars["--pc-bg-color"] = bg.color;
    vars["--pc-bg-image"] = "none";
  } else if (bg.type === "gradient" || (grad.enabled && grad.placement === "background")) {
    vars["--pc-bg-image"] = gradCss;
    vars["--pc-bg-size"] = "cover";
  } else if (bg.type === "pattern") {
    const p = patternCss(bg.pattern, bg.patternColor, bg.patternOpacity / 100, bg.patternScale);
    vars["--pc-bg-color"] = bg.color;
    if (p) {
      vars["--pc-bg-image"] = p.image;
      vars["--pc-bg-size"] = p.size;
    }
  } else if (bg.type === "image" && bg.mediaId) {
    vars["--pc-bg-image"] = `url("/api/media/${encodeURIComponent(bg.mediaId)}")`;
    vars["--pc-bg-size"] = "cover";
  }
  vars["--pc-dim"] = String(bg.dim / 100);

  // Cards
  const L = a.layout;
  const radius = L.cardShape === "theme" ? undefined : L.cardShape === "sharp" ? "0px" : L.cardShape === "pill" ? "28px" : `${L.radius}px`;
  if (radius) vars["--pc-radius"] = radius;
  vars["--pc-border-w"] = `${L.borderStyle === "none" ? 0 : L.borderWidth}px`;
  vars["--pc-border-style"] = L.borderStyle === "none" ? "solid" : L.borderStyle;
  const shadows: Record<string, string | undefined> = {
    theme: undefined,
    none: "0 0 0 transparent",
    soft: "0 6px 20px -10px rgba(0,0,0,.35)",
    lifted: "0 18px 40px -18px rgba(0,0,0,.5)",
    dramatic: "0 30px 60px -20px rgba(0,0,0,.7)",
    offset: "6px 6px 0 var(--c-accent)",
  };
  if (shadows[L.shadow]) vars["--pc-shadow"] = shadows[L.shadow]!;
  if (L.glow > 0) vars["--pc-glow"] = `0 0 ${Math.round(L.glow / 3)}px color-mix(in srgb, var(--c-accent) ${Math.round(L.glow * 0.7)}%, transparent)`;

  const classes = ["profile-canvas"];
  if (bg.texture !== "none") classes.push(`texture-${bg.texture}`);
  if (a.motion === "full" && bg.effect !== "none") classes.push(`fx-${bg.effect}`);
  return { style: vars as CSSProperties, className: classes.join(" ") };
}

const AVATAR_PX = { sm: 72, md: 96, lg: 124, xl: 148 } as const;
const BANNER_H = { short: "h-32 sm:h-36", medium: "h-40 sm:h-52", tall: "h-56 sm:h-72" } as const;
const DENSITY = { cozy: "gap-3 p-3", comfortable: "gap-4 p-4", spacious: "gap-6 p-6" } as const;

function Banner({ a, url }: { a: Appearance; url: string | null }) {
  const b = a.banner;
  const overlay: Record<string, CSSProperties> = {
    none: {},
    fade: { background: `linear-gradient(transparent 30%, var(--c-bg))` },
    tint: { background: "var(--c-accent)", mixBlendMode: "multiply" },
    vignette: { background: "radial-gradient(ellipse at center, transparent 40%, rgba(0,0,0,.85))" },
    grain: {},
    duotone: { background: "linear-gradient(135deg, var(--c-accent), var(--c-accent2))", mixBlendMode: "color" },
  };
  const useGradient = !url || (a.gradient.enabled && a.gradient.placement === "banner");
  return (
    <div className={`relative overflow-hidden ${BANNER_H[b.height]} ${b.overlay === "grain" ? "texture-grain" : ""}`} style={{ isolation: "isolate" }}>
      {url && !(a.gradient.enabled && a.gradient.placement === "banner") ? (
        <img src={url} alt="" className="absolute inset-0 h-full w-full object-cover" style={{ objectPosition: `${b.posX}% ${b.posY}%`, transform: `scale(${b.zoom / 100})`, transformOrigin: `${b.posX}% ${b.posY}%` }} />
      ) : null}
      {useGradient ? <div className="absolute inset-0" style={{ background: a.gradient.enabled && a.gradient.placement === "banner" ? "var(--pc-gradient)" : "linear-gradient(120deg, var(--c-accent), var(--c-accent2))", opacity: url ? 1 : 0.85 }} /> : null}
      <div className="absolute inset-0" style={{ ...overlay[b.overlay], opacity: b.overlayOpacity / 100 }} />
      {a.accentIcon.icon !== "none" && a.accentIcon.placement === "banner" ? (
        <Icon name={a.accentIcon.icon} size={120} className="absolute -bottom-6 right-6 text-white/25" strokeWidth={1.2} />
      ) : null}
    </div>
  );
}

function Widget({ w, profile }: { w: ProfileWidget; profile: ProfileDetail }) {
  const body = (() => {
    switch (w.type) {
      case "links":
        return (
          <ul className="space-y-1.5">
            {w.links.map((l, i) => (
              <li key={i}>
                <a href={l.url} target="_blank" rel="noopener noreferrer nofollow ugc" className="flex items-center gap-2 font-semibold text-accent hover:underline">
                  <Icon name="link" size={16} /> {l.label}
                </a>
              </li>
            ))}
          </ul>
        );
      case "interests":
        return (
          <div className="flex flex-wrap gap-1.5">
            {profile.interests.length ? profile.interests.map((s) => <Link key={s} to={`/topic/${s}`} className="chip">{TOPICS.find((t) => t.slug === s)?.label ?? s}</Link>) : <span className="text-sm text-muted">No interests listed.</span>}
          </div>
        );
      case "stats":
        return (
          <div className="grid grid-cols-3 gap-2 text-center">
            {[["Posts", profile.postCount], ["Followers", profile.followerCount], ["Following", profile.followingCount]].map(([k, v]) => (
              <div key={k as string}>
                <div className="heading text-xl font-extrabold">{compactNumber(v as number)}</div>
                <div className="text-xs text-muted">{k}</div>
              </div>
            ))}
          </div>
        );
      case "countdown": {
        if (!w.date) return null;
        const days = Math.ceil((new Date(`${w.date}T00:00:00`).getTime() - Date.now()) / 86400000);
        return (
          <div>
            <div className="heading text-3xl font-extrabold text-accent">{days > 0 ? `${days} days` : days === 0 ? "Today!" : `${-days} days ago`}</div>
            {w.body ? <p className="text-sm text-muted">{w.body}</p> : null}
          </div>
        );
      }
      case "quote":
        return <blockquote className="heading border-l-4 border-accent pl-3 text-lg italic">{w.body}</blockquote>;
      default:
        return <RichText text={w.body} className="text-sm" />;
    }
  })();
  return (
    <div className="pc-card p-4">
      {w.title ? <h3 className="mb-2 text-sm font-bold uppercase tracking-wide text-muted">{w.title}</h3> : null}
      {body}
    </div>
  );
}

export function ProfileCanvas({
  profile,
  appearance: a,
  actions,
  featured = [],
  highlighted,
  postsSection,
  preview = false,
}: {
  profile: ProfileDetail;
  appearance: Appearance;
  actions?: ReactNode;
  featured?: PostView[];
  highlighted?: ReactNode;
  postsSection?: ReactNode;
  preview?: boolean;
}) {
  const { style, className } = appearanceStyle(a);
  const t = a.typography;
  const L = a.layout;
  const centered = L.align === "center" || L.variant === "centered";
  const avatarPx = AVATAR_PX[a.avatar.size];
  const nameStyle: CSSProperties = {
    fontFamily: "var(--t-font-heading)",
    fontSize: `${t.nameSize}px`,
    fontWeight: Number(t.nameWeight),
    letterSpacing: `${t.letterSpacing}em`,
    textTransform: t.uppercaseName ? "uppercase" : "none",
    color: "var(--pc-name-color)",
    lineHeight: 1.1,
  };
  const nameClass = t.nameEffect === "gradient" ? "name-gradient" : t.nameEffect === "outline" ? "name-outline" : t.nameEffect === "shadow" ? "name-shadow" : t.nameEffect === "glow" ? "name-glow" : "";
  const handleEl =
    t.handleStyle === "pill" ? <span className="chip !text-sm">@{profile.handle}</span>
    : t.handleStyle === "mono" ? <span className="font-mono text-sm text-muted">@{profile.handle}</span>
    : t.handleStyle === "subtle" ? <span className="text-xs uppercase tracking-widest text-muted">@{profile.handle}</span>
    : <span className="text-muted">@{profile.handle}</span>;
  const ring =
    a.avatar.ring === "none" ? {}
    : a.avatar.ring === "gradient" ? { background: "linear-gradient(135deg, var(--c-accent), var(--c-accent2))", padding: 4 }
    : a.avatar.ring === "double" ? { boxShadow: `0 0 0 3px var(--c-bg), 0 0 0 6px ${a.avatar.ringColor}, 0 0 0 9px var(--c-bg), 0 0 0 11px ${a.avatar.ringColor}` }
    : a.avatar.ring === "dashed" ? { outline: `3px dashed ${a.avatar.ringColor}`, outlineOffset: 3 }
    : a.avatar.ring === "glow" ? { boxShadow: `0 0 0 3px ${a.avatar.ringColor}, 0 0 28px ${a.avatar.ringColor}` }
    : { boxShadow: `0 0 0 4px var(--c-bg), 0 0 0 7px ${a.avatar.ringColor}` };
  const accent = a.accentIcon.icon !== "none" && a.accentIcon.placement === "name" ? <Icon name={a.accentIcon.icon} size={Math.round(t.nameSize * 0.8)} className="text-accent" /> : null;
  const badgeSize = a.badges.size === "sm" ? 16 : a.badges.size === "lg" ? 28 : 21;
  const showBadges = a.badges.show && profile.milestoneLevel > 0;
  const hidden = new Set(a.sections.hidden);
  const outlineClass = L.outline === "single" ? "pc-outline-single" : L.outline === "double" ? "pc-outline-double" : L.outline === "ornate" ? "pc-outline-ornate" : "";
  const shapeAttr = L.cardShape === "notched" ? "notched" : undefined;
  const next = MILESTONES.find((m) => profile.followerCount < m.threshold);

  const header = (
    <div className={`pc-card ${outlineClass} overflow-hidden`} data-shape={shapeAttr}>
      <Banner a={a} url={profile.bannerUrl} />
      <div className={`relative ${DENSITY[L.density]} flex flex-col ${centered ? "items-center text-center" : ""}`}>
        {/* Avatar and actions share a row that wraps, so buttons never sit on top of the avatar. */}
        <div className={`flex w-full flex-wrap items-end gap-3 ${centered ? "flex-col items-center" : "justify-between"}`}>
          <div className={`${centered ? "-mt-20" : "-mt-16"} relative aspect-square shrink-0`} style={{ width: `min(${avatarPx}px, 30vw)`, minWidth: 64 }}>
            <span className={`block h-full w-full avatar-${a.avatar.shape}`} style={{ ...ring, background: a.avatar.ring === "gradient" ? (ring as CSSProperties).background : undefined }}>
              <Avatar profile={profile} size={avatarPx} shape={a.avatar.shape} className="!h-full !w-full [&_svg]:h-full [&_svg]:w-full" />
            </span>
            {a.accentIcon.icon !== "none" && a.accentIcon.placement === "corner" ? (
              <span className="absolute -bottom-1 -right-1 grid h-9 w-9 place-items-center rounded-full bg-accent text-on-accent shadow">
                <Icon name={a.accentIcon.icon} size={18} />
              </span>
            ) : null}
          </div>
          {actions ? <div className={`flex flex-wrap items-center gap-2 ${centered ? "justify-center" : "ml-auto justify-end"}`}>{actions}</div> : null}
        </div>
        <div className="mt-3 w-full min-w-0 space-y-2">
          <div className={`flex flex-wrap items-center gap-2 ${centered ? "justify-center" : ""}`}>
            <h1 className={`min-w-0 [overflow-wrap:anywhere] ${nameClass}`} style={nameStyle}>
              {profile.displayName}
            </h1>
            {accent}
            {showBadges && a.badges.placement === "name" ? <BadgeStrip level={profile.milestoneLevel} size={badgeSize} showAll={a.badges.showAll} /> : null}
            <KindChip kind={profile.kind} />
            {profile.isPrivate ? <Icon name="lock" size={16} className="text-muted" aria-label="Private profile" /> : null}
          </div>
          <div className={`flex flex-wrap items-center gap-2 ${centered ? "justify-center" : ""}`}>
            {handleEl}
            {profile.relationship?.followedBy ? <span className="rounded bg-surface2 px-1.5 py-0.5 text-xs text-muted">Follows you</span> : null}
          </div>
          {showBadges && a.badges.placement === "below" ? (
            <div className={`flex ${centered ? "justify-center" : ""}`}>
              <BadgeStrip level={profile.milestoneLevel} size={badgeSize} showAll={a.badges.showAll} />
            </div>
          ) : null}
        </div>
      </div>
      <div className={`space-y-3 px-4 pb-4 ${centered ? "text-center" : ""}`}>
        {profile.bio ? (
          a.bio.layout === "card" ? (
            <div className="rounded-xl bg-surface2 p-3"><RichText text={profile.bio} /></div>
          ) : a.bio.layout === "quote" ? (
            <blockquote className="heading border-l-4 border-accent pl-3 text-left text-[1.05rem] italic"><RichText text={profile.bio} /></blockquote>
          ) : (
            <RichText text={profile.bio} className={a.bio.layout === "centered" ? "text-center" : ""} />
          )
        ) : null}
        <div className={`flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted ${centered ? "justify-center" : ""}`}>
          {profile.business ? <span className="flex items-center gap-1"><Icon name="briefcase" size={15} /> {profile.business.category}</span> : null}
          {profile.location ? <span className="flex items-center gap-1"><Icon name="location" size={15} /> {profile.location}</span> : null}
          {profile.website ? (
            <a href={profile.website} target="_blank" rel="noopener noreferrer nofollow ugc" className="flex min-w-0 max-w-full items-center gap-1 text-accent hover:underline">
              <Icon name="link" size={15} className="shrink-0" /> <span className="truncate">{profile.website.replace(/^https?:\/\//, "").replace(/\/$/, "")}</span>
            </a>
          ) : null}
          <span className="flex items-center gap-1"><Icon name="calendar" size={15} /> Joined {monthYear(profile.createdAt)}</span>
        </div>
        {profile.aiPersona ? <p className="text-xs text-muted">AI-operated account · {profile.aiPersona.summary.split(".")[0]}.</p> : null}
        <div className={`flex gap-5 text-sm ${centered ? "justify-center" : ""}`}>
          <Link to={preview ? "#" : `/@${profile.handle}/following`} className="hover:underline"><b className="text-fg">{compactNumber(profile.followingCount)}</b> <span className="text-muted">Following</span></Link>
          <Link to={preview ? "#" : `/@${profile.handle}/followers`} className="hover:underline"><b className="text-fg">{compactNumber(profile.followerCount)}</b> <span className="text-muted">Followers</span></Link>
        </div>
      </div>
    </div>
  );

  const sections: Record<string, ReactNode> = {
    about: null, // the header carries the "about" content; position is fixed at the top
    badges:
      showBadges && a.badges.placement === "section" ? (
        <div className="pc-card p-4">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-sm font-bold uppercase tracking-wide text-muted">Milestones</h2>
            {!preview ? <Link to={`/@${profile.handle}/milestones`} className="text-xs text-accent">View all</Link> : null}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            {MILESTONES.map((m) => <MilestoneBadge key={m.level} level={m.level} size={34} locked={m.level > profile.milestoneLevel} />)}
          </div>
          {next ? <p className="mt-2 text-xs text-muted">{compactNumber(next.threshold - profile.followerCount)} more followers to unlock {next.name}.</p> : null}
        </div>
      ) : null,
    featured: featured.length ? (
      <div className="pc-card overflow-hidden">
        <h2 className="px-4 pt-3 text-sm font-bold uppercase tracking-wide text-muted">Featured</h2>
        <div className="divide-y divide-[var(--c-border)]">
          {featured.map((p) => (
            <Link key={p.id} to={preview ? "#" : `/post/${p.id}`} className="block px-4 py-3 hover:bg-surface2/40">
              <RichText text={p.text} className="line-clamp-3" />
              {p.media.length ? <div className="mt-2"><MediaGrid media={p.media} compact /></div> : null}
            </Link>
          ))}
        </div>
      </div>
    ) : null,
    widgets: a.widgets.length ? <div className={`grid gap-3 ${L.variant === "magazine" ? "sm:grid-cols-2" : ""}`}>{a.widgets.map((w) => <Widget key={w.id} w={w} profile={profile} />)}</div> : null,
    media: highlighted ?? null,
    affiliates: profile.affiliations.length ? (
      <div className="pc-card p-4">
        <h2 className="mb-2 text-sm font-bold uppercase tracking-wide text-muted">Affiliations</h2>
        <ul className="space-y-2">
          {profile.affiliations.map((af) => {
            const other = af.business.id === profile.id ? af.affiliate : af.business;
            return (
              <li key={af.id}>
                <Link to={preview ? "#" : `/@${other.handle}`} className="flex items-center gap-2 hover:underline">
                  <Avatar profile={other} size={28} />
                  <span className="font-semibold">{other.displayName}</span>
                  <span className="text-xs text-muted">{af.relationType.replace(/_/g, " ")}</span>
                </Link>
              </li>
            );
          })}
        </ul>
        <p className="mt-2 text-[11px] text-muted">Affiliations are mutually confirmed by both profiles. They are not business verification.</p>
      </div>
    ) : null,
    posts: postsSection ?? null,
  };

  return (
    <div className={className} style={style}>
      <div className="pc-bg" aria-hidden="true" />
      <div className="pc-dim" aria-hidden="true" />
      <div className={`flex flex-col ${DENSITY[L.density]} ${L.variant === "compact" ? "!gap-2 !p-2" : ""}`}>
        {header}
        {a.sections.order.filter((s) => s !== "about" && !hidden.has(s) && sections[s]).map((s) => (
          <section key={s} aria-label={s}>{sections[s]}</section>
        ))}
      </div>
    </div>
  );
}
