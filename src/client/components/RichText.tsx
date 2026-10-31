import { Link } from "react-router";
import { tokenize } from "../../shared/text";
import type { ProfileSummary } from "../../shared/types";
import { BadgeStrip } from "./MilestoneBadge";

/** Renders user text as React nodes only — never as HTML. Links are rel=noopener nofollow. */
export function RichText({ text, className = "" }: { text: string; className?: string }) {
  const tokens = tokenize(text);
  return (
    <p className={`whitespace-pre-wrap break-words ${className}`}>
      {tokens.map((t, i) => {
        if (t.t === "hashtag")
          return (
            <Link key={i} to={`/hashtag/${encodeURIComponent(t.v.toLowerCase())}`} className="font-medium text-accent hover:underline" onClick={(e) => e.stopPropagation()}>
              #{t.v}
            </Link>
          );
        if (t.t === "mention")
          return (
            <Link key={i} to={`/@${t.v}`} className="font-medium text-accent hover:underline" onClick={(e) => e.stopPropagation()}>
              @{t.v}
            </Link>
          );
        if (t.t === "link") {
          let label = t.v.replace(/^https?:\/\//, "");
          if (label.length > 40) label = label.slice(0, 38) + "…";
          return (
            <a key={i} href={t.v} target="_blank" rel="noopener noreferrer nofollow ugc" className="text-accent hover:underline" onClick={(e) => e.stopPropagation()}>
              {label}
            </a>
          );
        }
        return <span key={i}>{t.v}</span>;
      })}
    </p>
  );
}

export function KindChip({ kind }: { kind: ProfileSummary["kind"] }) {
  if (kind === "ai")
    return (
      <span className="chip" title="This account is operated by AI" aria-label="AI account">
        AI
      </span>
    );
  if (kind === "business")
    return (
      <span className="chip" style={{ background: "color-mix(in srgb, var(--c-accent2) 18%, transparent)", color: "var(--c-accent2)" }}>
        Business
      </span>
    );
  return null;
}

/** Display name + milestone badge + account-kind chip + handle. */
/**
 * Display name + badge + kind chip, then the handle. The name always gets priority for space:
 * `stacked` puts the handle on its own line; `handle="wide"` hides it below the sm breakpoint.
 */
export function NameLine({ p, showHandle = true, linked = true, size = "md", stacked = false, handle = "always" }: { p: ProfileSummary; showHandle?: boolean; linked?: boolean; size?: "sm" | "md"; stacked?: boolean; handle?: "always" | "wide" }) {
  const name = (
    <span className={`flex min-w-0 items-center gap-1 ${size === "sm" ? "text-sm" : ""}`}>
      <span className="min-w-0 truncate font-bold">{p.displayName}</span>
      <span className="flex shrink-0 items-center gap-1">
        <BadgeStrip level={p.milestoneLevel} size={size === "sm" ? 14 : 17} />
        <KindChip kind={p.kind} />
      </span>
      {p.isPrivate ? <span className="sr-only">(private)</span> : null}
    </span>
  );
  const nameEl = linked ? (
    <Link to={`/@${p.handle}`} className="min-w-0 max-w-full hover:underline" onClick={(e) => e.stopPropagation()}>
      {name}
    </Link>
  ) : (
    name
  );
  const handleEl = showHandle ? (
    <span className={`min-w-0 truncate text-sm text-muted ${handle === "wide" && !stacked ? "hidden sm:block" : ""}`}>@{p.handle}</span>
  ) : null;
  return stacked ? (
    <span className="flex min-w-0 flex-col">
      {nameEl}
      {handleEl}
    </span>
  ) : (
    <span className="flex min-w-0 items-center gap-1.5">
      <span className="min-w-0 shrink">{nameEl}</span>
      {handleEl ? <span className="min-w-0 shrink-[2]">{handleEl}</span> : null}
    </span>
  );
}
