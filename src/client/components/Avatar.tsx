import { useState } from "react";
import type { ProfileSummary } from "../../shared/types";

function hash(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Deterministic generated avatar (no upload needed): two-tone gradient + geometric mark + initials. */
function Generated({ seed, name, size }: { seed: string; name: string; size: number }) {
  const h = hash(seed);
  const hue = h % 360;
  const hue2 = (hue + 40 + (h >> 8) % 80) % 360;
  const shape = (h >> 4) % 4;
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => [...w][0]?.toUpperCase() ?? "")
    .join("");
  const gid = `g${h.toString(36)}`;
  return (
    <svg viewBox="0 0 40 40" width={size} height={size} aria-hidden="true">
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor={`hsl(${hue} 70% 55%)`} />
          <stop offset="1" stopColor={`hsl(${hue2} 65% 38%)`} />
        </linearGradient>
      </defs>
      <rect width="40" height="40" fill={`url(#${gid})`} />
      {shape === 0 ? <circle cx="32" cy="8" r="12" fill="white" opacity="0.12" /> : null}
      {shape === 1 ? <path d="M0 30 L40 18 L40 40 L0 40Z" fill="white" opacity="0.1" /> : null}
      {shape === 2 ? <rect x="22" y="-6" width="20" height="20" transform="rotate(20 32 4)" fill="white" opacity="0.12" /> : null}
      {shape === 3 ? <circle cx="6" cy="36" r="14" fill="black" opacity="0.12" /> : null}
      <text x="20" y="25.5" textAnchor="middle" fontSize="14" fontWeight="700" fill="white" fontFamily="var(--t-font-heading), system-ui">
        {initials}
      </text>
    </svg>
  );
}

export function Avatar({ profile, size = 44, shape = "circle", className = "" }: { profile: Pick<ProfileSummary, "avatarUrl" | "avatarSeed" | "displayName" | "kind">; size?: number; shape?: string; className?: string }) {
  const [failed, setFailed] = useState(false);
  const cls = `avatar-${profile.kind === "business" && shape === "circle" ? "squircle" : shape}`;
  return (
    <span className={`relative inline-block shrink-0 overflow-hidden bg-surface2 ${cls} ${className}`} style={{ width: size, height: size }}>
      {profile.avatarUrl && !failed ? (
        <img src={profile.avatarUrl} alt="" width={size} height={size} loading="lazy" decoding="async" onError={() => setFailed(true)} className="h-full w-full object-cover" />
      ) : (
        <Generated seed={profile.avatarSeed} name={profile.displayName} size={size} />
      )}
    </span>
  );
}
