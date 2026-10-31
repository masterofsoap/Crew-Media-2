import { useState } from "react";
import type { MediaView } from "../../shared/types";
import { Icon } from "./Icon";
import { timeLeft } from "../lib/format";
import { Dialog } from "./ui";

function Expired({ removed }: { removed: boolean }) {
  return (
    <div className="flex h-full min-h-[120px] w-full flex-col items-center justify-center gap-1.5 bg-surface2 p-4 text-center text-muted" style={{ backgroundImage: "repeating-linear-gradient(135deg, transparent 0 10px, color-mix(in srgb, var(--c-text) 4%, transparent) 10px 20px)" }}>
      <Icon name={removed ? "block" : "clock"} size={22} />
      <span className="text-sm font-semibold">{removed ? "Media removed" : "Media expired after 7 days."}</span>
    </div>
  );
}

/** Up to 4 attachments, each expiring independently; expired ones render a placeholder. */
export function MediaGrid({ media, compact = false }: { media: MediaView[]; compact?: boolean }) {
  const [zoom, setZoom] = useState<MediaView | null>(null);
  if (!media.length) return null;
  const cols = media.length === 1 ? "grid-cols-1" : "grid-cols-2";
  return (
    <>
      <div className={`grid ${cols} gap-0.5 overflow-hidden rounded-2xl border divider`} onClick={(e) => e.stopPropagation()}>
        {media.map((m, i) => {
          const tall = media.length === 3 && i === 0;
          const aspect = media.length === 1 && m.width && m.height ? `${m.width} / ${m.height}` : "16 / 10";
          return (
            <div key={m.id} className={`relative bg-surface2 ${tall ? "row-span-2" : ""}`} style={{ aspectRatio: tall ? undefined : aspect, maxHeight: compact ? 220 : 520 }}>
              {m.status !== "ready" || !m.url ? (
                <Expired removed={m.status === "removed"} />
              ) : m.kind === "image" ? (
                <button type="button" className="block h-full w-full" onClick={() => setZoom(m)} aria-label={m.alt ? `View image: ${m.alt}` : "View image"}>
                  <img src={m.thumbUrl && compact ? m.thumbUrl : m.url} alt={m.alt} loading="lazy" decoding="async" className="h-full w-full object-cover" />
                </button>
              ) : (
                <video src={m.url} poster={m.thumbUrl ?? undefined} controls preload="metadata" playsInline className="h-full w-full bg-black object-contain" aria-label={m.alt || "Video"} />
              )}
              {m.status === "ready" && m.expiresAt ? (
                <span className="pointer-events-none absolute bottom-2 left-2 rounded-full bg-black/60 px-2 py-0.5 text-[11px] font-semibold text-white">{timeLeft(m.expiresAt)}</span>
              ) : null}
            </div>
          );
        })}
      </div>
      <Dialog open={!!zoom} onClose={() => setZoom(null)} title={zoom?.alt || "Image"} wide>
        {zoom?.url ? <img src={zoom.url} alt={zoom.alt} className="mx-auto max-h-[75dvh] w-auto rounded-xl" /> : null}
      </Dialog>
    </>
  );
}
