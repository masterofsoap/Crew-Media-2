import { useId } from "react";
import { MILESTONES } from "../../shared/constants";
import { compactNumber } from "../../shared/text";

/**
 * Eight milestone badges with distinct silhouettes and materials that grow more ornate:
 * 1 Sprout Seal (bronze, scalloped seal) → 2 Guardian Shield (silver) → 3 Hex Star (gold) →
 * 4 Faceted Crystal (platinum gem) → 5 Laurel Crest (emerald wreath) → 6 Sovereign Crown
 * (sapphire) → 7 Solar Radiance (ruby sunburst) → 8 Celestial Orbit (prismatic planet).
 */

const MATERIALS: Record<number, [string, string, string]> = {
  1: ["#f0b27a", "#b06a32", "#6e3d17"],
  2: ["#ffffff", "#c3cbd6", "#6f7b8c"],
  3: ["#fff2a8", "#f2b632", "#9a6a07"],
  4: ["#ffffff", "#d9e6f2", "#8fa3b8"],
  5: ["#a8f0c8", "#22a565", "#0c5a35"],
  6: ["#b9d4ff", "#2f62e0", "#142f80"],
  7: ["#ffb3b8", "#e02a43", "#7a0b1c"],
  8: ["#ff8bd8", "#7c6cff", "#20d8ff"],
};

function Defs({ id, level }: { id: string; level: number }) {
  const [a, b, c] = MATERIALS[level]!;
  return (
    <defs>
      <linearGradient id={`${id}-m`} x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stopColor={a} />
        <stop offset="0.55" stopColor={b} />
        <stop offset="1" stopColor={c} />
      </linearGradient>
      <linearGradient id={`${id}-s`} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="#fff" stopOpacity="0.75" />
        <stop offset="0.5" stopColor="#fff" stopOpacity="0" />
      </linearGradient>
      {level === 8 ? (
        <linearGradient id={`${id}-p`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#ff5fa2" />
          <stop offset="0.25" stopColor="#ffd34d" />
          <stop offset="0.5" stopColor="#45f0a6" />
          <stop offset="0.75" stopColor="#46b6ff" />
          <stop offset="1" stopColor="#b56bff" />
        </linearGradient>
      ) : null}
    </defs>
  );
}

function Shape({ id, level }: { id: string; level: number }) {
  const m = `url(#${id}-m)`;
  const s = `url(#${id}-s)`;
  const ink = MATERIALS[level]![2];
  switch (level) {
    case 1: {
      const scallops = Array.from({ length: 12 }, (_, i) => {
        const a = (i / 12) * Math.PI * 2;
        return <circle key={i} cx={12 + Math.cos(a) * 9} cy={12 + Math.sin(a) * 9} r="2.6" fill={m} />;
      });
      return (
        <g>
          {scallops}
          <circle cx="12" cy="12" r="9" fill={m} />
          <circle cx="12" cy="12" r="6.6" fill="none" stroke={ink} strokeOpacity="0.5" strokeWidth="0.7" />
          <path d="M12 16.5v-5M12 12c-2.4 0-3.6-1.5-3.8-3.6 2.3 0 3.6 1.2 3.8 3.6Zm0-1.2c.2-2.2 1.6-3.4 3.9-3.4-.2 2.2-1.6 3.4-3.9 3.4Z" fill="#fff" stroke="#fff" strokeWidth="0.6" strokeLinejoin="round" />
          <ellipse cx="12" cy="8" rx="6" ry="3" fill={s} />
        </g>
      );
    }
    case 2:
      return (
        <g>
          <path d="M12 1.8 20.5 5v6.5c0 5.4-3.6 9.2-8.5 10.7C7.1 20.7 3.5 16.9 3.5 11.5V5Z" fill={m} stroke={ink} strokeWidth="0.8" />
          <path d="M12 4.2 18.3 6.6v4.9c0 4-2.6 6.9-6.3 8.2-3.7-1.3-6.3-4.2-6.3-8.2V6.6Z" fill="none" stroke="#fff" strokeOpacity="0.6" strokeWidth="0.7" />
          <path d="m8.2 11.8 2.7 2.7 5-5.2" fill="none" stroke={ink} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M12 1.8 20.5 5v3C16 6.5 8 6.5 3.5 8V5Z" fill={s} />
        </g>
      );
    case 3:
      return (
        <g>
          <path d="M12 1.5 21.1 6.75v10.5L12 22.5 2.9 17.25V6.75Z" fill={m} stroke={ink} strokeWidth="0.8" />
          <path d="M12 4 18.9 8v8L12 20 5.1 16V8Z" fill="none" stroke="#fff" strokeOpacity="0.55" strokeWidth="0.6" />
          <path d="m12 6.6 1.7 3.5 3.8.5-2.8 2.6.7 3.8L12 15.2 8.6 17l.7-3.8-2.8-2.6 3.8-.5Z" fill="#fff" stroke={ink} strokeWidth="0.5" strokeLinejoin="round" />
          <path d="M12 1.5 21.1 6.75V9C16 7 8 7 2.9 9V6.75Z" fill={s} />
        </g>
      );
    case 4:
      return (
        <g>
          <path d="M6 3h12l4.5 6L12 22 1.5 9Z" fill={m} stroke={ink} strokeWidth="0.8" strokeLinejoin="round" />
          <path d="M1.5 9h21M8.5 3 12 22M15.5 3 12 22M6 3l2.5 6L12 3l3.5 6L18 3" fill="none" stroke={ink} strokeOpacity="0.55" strokeWidth="0.6" strokeLinejoin="round" />
          <path d="M6 3h12l2 2.7c-5-1.4-11-1.4-16 0Z" fill={s} />
          <circle cx="17.5" cy="6" r="0.9" fill="#fff" />
        </g>
      );
    case 5: {
      const leaves = (side: 1 | -1) =>
        Array.from({ length: 5 }, (_, i) => {
          const a = (Math.PI * (0.62 + i * 0.16)) * side;
          const x = 12 + Math.sin(a) * 8.6;
          const y = 13 + Math.cos(a) * 8.6;
          return <ellipse key={i} cx={x} cy={y} rx="1.4" ry="2.8" transform={`rotate(${(-a * 180) / Math.PI + (side === 1 ? 35 : -35)} ${x} ${y})`} fill={m} stroke={ink} strokeWidth="0.35" />;
        });
      return (
        <g>
          {leaves(1)}
          {leaves(-1)}
          <circle cx="12" cy="12" r="6.2" fill={m} stroke={ink} strokeWidth="0.7" />
          <path d="m12 8.4 1.1 2.3 2.5.3-1.8 1.7.5 2.5-2.3-1.2-2.3 1.2.5-2.5-1.8-1.7 2.5-.3Z" fill="#fff" />
          <path d="M9.5 21.5h5" stroke={ink} strokeWidth="1.2" strokeLinecap="round" />
          <ellipse cx="12" cy="9.6" rx="4.2" ry="2" fill={s} />
        </g>
      );
    }
    case 6:
      return (
        <g>
          <path d="M3 8.5 7.5 12 12 4.5 16.5 12 21 8.5 19 18.5H5Z" fill={m} stroke={ink} strokeWidth="0.8" strokeLinejoin="round" />
          <rect x="4.6" y="18.3" width="14.8" height="3" rx="0.8" fill={m} stroke={ink} strokeWidth="0.7" />
          <circle cx="12" cy="4.4" r="1.4" fill="#fff" stroke={ink} strokeWidth="0.5" />
          <circle cx="3" cy="8.4" r="1.1" fill="#fff" stroke={ink} strokeWidth="0.5" />
          <circle cx="21" cy="8.4" r="1.1" fill="#fff" stroke={ink} strokeWidth="0.5" />
          <path d="m12 12.6 1.4 1.8-1.4 1.8-1.4-1.8Z" fill="#fff" />
          <circle cx="8" cy="19.8" r="0.7" fill="#fff" />
          <circle cx="16" cy="19.8" r="0.7" fill="#fff" />
          <path d="M5 9.8 7.5 12 12 4.5 16.5 12 19 9.8l-.3 1.6C15 10 9 10 5.3 11.4Z" fill={s} />
        </g>
      );
    case 7: {
      const rays = Array.from({ length: 16 }, (_, i) => {
        const a = (i / 16) * Math.PI * 2;
        const long = i % 2 === 0;
        const r1 = 7.2;
        const r2 = long ? 11.6 : 9.6;
        const w = long ? 0.28 : 0.22;
        const p = (r: number, off: number) => `${12 + Math.cos(a + off) * r},${12 + Math.sin(a + off) * r}`;
        return <polygon key={i} points={`${p(r1, -w)} ${p(r2, 0)} ${p(r1, w)}`} fill={m} />;
      });
      return (
        <g>
          {rays}
          <circle cx="12" cy="12" r="7.2" fill={m} stroke={ink} strokeWidth="0.7" />
          <circle cx="12" cy="12" r="5" fill="none" stroke="#fff" strokeOpacity="0.6" strokeWidth="0.6" />
          <path d="M12 8.6 15 12l-3 3.4L9 12Z" fill="#fff" stroke={ink} strokeWidth="0.4" />
          <ellipse cx="12" cy="9" rx="4.5" ry="2.2" fill={s} />
        </g>
      );
    }
    default: {
      const p = `url(#${id}-p)`;
      return (
        <g>
          <circle cx="12" cy="12" r="11" fill="#0b0b22" />
          <circle cx="12" cy="12" r="11" fill="none" stroke={p} strokeWidth="1" />
          <circle cx="12" cy="12" r="5.2" fill={m} />
          <ellipse cx="12" cy="12" rx="10" ry="3.2" transform="rotate(-22 12 12)" fill="none" stroke={p} strokeWidth="1.3" />
          <path d="M7 10.3a5.2 5.2 0 0 1 10 0" fill="none" stroke="#fff" strokeOpacity="0.5" strokeWidth="0.6" />
          <path d="m4.5 5 .5 1.2 1.2.5-1.2.5-.5 1.2-.5-1.2L2.8 6.7 4 6.2Z" fill="#fff" />
          <path d="m19 15.5.4 1 1 .4-1 .4-.4 1-.4-1-1-.4 1-.4Z" fill="#fff" />
          <circle cx="18.5" cy="5.5" r="0.7" fill="#ffd34d" />
          <circle cx="5.5" cy="18.5" r="0.6" fill="#46b6ff" />
        </g>
      );
    }
  }
}

export function MilestoneBadge({ level, size = 18, locked = false, title }: { level: number; size?: number; locked?: boolean; title?: string }) {
  const id = useId().replace(/:/g, "");
  if (level < 1 || level > 8) return null;
  const def = MILESTONES[level - 1]!;
  const label = title ?? `${def.name} — ${compactNumber(def.threshold)} followers milestone`;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      role="img"
      aria-label={locked ? `${def.name} (locked)` : label}
      style={locked ? { filter: "grayscale(1)", opacity: 0.35 } : undefined}
      className="inline-block shrink-0 align-[-0.15em]"
    >
      <title>{locked ? `${def.name} — unlocks at ${compactNumber(def.threshold)} followers` : label}</title>
      <Defs id={id} level={level} />
      <Shape id={id} level={level} />
    </svg>
  );
}

/** Name line badges: the highest earned milestone (or all, if requested). */
export function BadgeStrip({ level, size = 18, showAll = false }: { level: number; size?: number; showAll?: boolean }) {
  if (level < 1) return null;
  if (!showAll) return <MilestoneBadge level={level} size={size} />;
  return (
    <span className="inline-flex items-center gap-0.5">
      {Array.from({ length: level }, (_, i) => (
        <MilestoneBadge key={i} level={i + 1} size={size} />
      ))}
    </span>
  );
}
