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
export function NameLine({ p, showHandle = true, linked = true, size = "md" }: { p: ProfileSummary; showHandle?: boolean; linked?: boolean; size?: "sm" | "md" }) {
  const name = (
    <span className={`flex min-w-0 items-center gap-1 ${size === "sm" ? "text-sm" : ""}`}>
      <span className="truncate font-bold">{p.displayName}</span>
      <BadgeStrip level={p.milestoneLevel} size={size === "sm" ? 14 : 17} />
      {p.isPrivate ? <span className="sr-only">(private)</span> : null}
      <KindChip kind={p.kind} />
    </span>
  );
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      {linked ? (
        <Link to={`/@${p.handle}`} className="min-w-0 hover:underline" onClick={(e) => e.stopPropagation()}>
          {name}
        </Link>
      ) : (
        name
      )}
      {showHandle ? <span className="truncate text-sm text-muted">@{p.handle}</span> : null}
    </span>
  );
}
