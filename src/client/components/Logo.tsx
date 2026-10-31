import { useId } from "react";

/**
 * Crew Plus mark: a bold open "C" ring on a gradient squircle, with a four-point spark sitting in
 * the opening (the "plus"). Three small dots along the ring stand for the crew. Colors come from
 * the active theme, so the mark matches every one of the 20 themes.
 */
export function LogoMark({ size = 36, className = "" }: { size?: number; className?: string }) {
  const id = useId().replace(/:/g, "");
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" className={className} aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={`${id}-bg`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" style={{ stopColor: "var(--c-accent)" }} />
          <stop offset="1" style={{ stopColor: "var(--c-accent2)" }} />
        </linearGradient>
        <radialGradient id={`${id}-shine`} cx="0.25" cy="0.15" r="0.9">
          <stop offset="0" stopColor="#fff" stopOpacity="0.45" />
          <stop offset="0.55" stopColor="#fff" stopOpacity="0" />
        </radialGradient>
      </defs>
      <rect x="1" y="1" width="46" height="46" rx="15" fill={`url(#${id}-bg)`} />
      <rect x="1" y="1" width="46" height="46" rx="15" fill={`url(#${id}-shine)`} />
      {/* The C: a 270° ring opening to the right */}
      <path d="M29.8 17.2 A11 11 0 1 0 29.8 32.8" fill="none" stroke="#fff" strokeWidth="6.5" strokeLinecap="round" />
      {/* Crew dots riding the ring */}
      <circle cx="11.6" cy="20.6" r="1.35" fill="var(--c-accent2)" opacity="0.9" />
      <circle cx="11" cy="25" r="1.35" fill="var(--c-accent2)" opacity="0.9" />
      <circle cx="11.6" cy="29.4" r="1.35" fill="var(--c-accent2)" opacity="0.9" />
      {/* The plus: a four-point spark in the opening */}
      <path d="M37 18.5 Q37.8 24.2 43.5 25 Q37.8 25.8 37 31.5 Q36.2 25.8 30.5 25 Q36.2 24.2 37 18.5Z" fill="#fff" />
    </svg>
  );
}

export function Logo({ size = 36, wordmark = true, className = "" }: { size?: number; wordmark?: boolean; className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2.5 ${className}`}>
      <LogoMark size={size} />
      {wordmark ? (
        <span className="heading font-extrabold leading-none tracking-tight" style={{ fontSize: size * 0.62 }}>
          Crew
          <span className="ml-1 bg-gradient-to-r from-[var(--c-accent)] to-[var(--c-accent2)] bg-clip-text text-transparent">Plus</span>
        </span>
      ) : null}
    </span>
  );
}
