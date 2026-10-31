import { useState } from "react";
import { useNavigate } from "react-router";
import { useSession } from "../lib/session";
import { errorMessage } from "../lib/api";
import { Avatar } from "./Avatar";
import { Icon } from "./Icon";
import { KindChip } from "./RichText";
import { useToast } from "./toast";
import { Spinner } from "./ui";

/** Lists every profile this login can act as; switching is server-verified and clears per-profile caches. */
export function ProfileSwitcher({ onDone, compact = false }: { onDone?: () => void; compact?: boolean }) {
  const { session, active, switchProfile, signOut } = useSession();
  const [busy, setBusy] = useState<string | null>(null);
  const nav = useNavigate();
  const toast = useToast();
  if (!session || !active) return null;
  return (
    <div className="w-72 py-1 text-sm" role="menu" aria-label="Switch profile">
      <p className="px-4 pb-1 pt-2 text-xs font-semibold uppercase tracking-wide text-muted">Your profiles</p>
      {session.profiles.map((p) => (
        <button
          key={p.id}
          role="menuitemradio"
          aria-checked={p.id === active.id}
          disabled={!!busy}
          className={`flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-surface2 ${p.id === active.id ? "bg-surface2/60" : ""}`}
          onClick={async () => {
            if (p.id === active.id) return onDone?.();
            setBusy(p.id);
            try {
              await switchProfile(p.id);
              toast(`Now acting as @${p.handle}`, "info");
              onDone?.();
              nav("/home");
            } catch (e) {
              toast(errorMessage(e), "error");
            } finally {
              setBusy(null);
            }
          }}
        >
          <Avatar profile={p} size={36} />
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1.5">
              <span className="truncate font-bold">{p.displayName}</span>
              <KindChip kind={p.kind} />
            </span>
            <span className="block truncate text-muted">
              @{p.handle}
              {p.role === "manager" ? " · manager" : ""}
            </span>
          </span>
          {p.unreadNotifications + p.unreadMessages > 0 && p.id !== active.id ? <span className="chip">{p.unreadNotifications + p.unreadMessages}</span> : null}
          {busy === p.id ? <Spinner size={16} /> : p.id === active.id ? <Icon name="check" size={18} className="text-accent" /> : null}
        </button>
      ))}
      <div className="my-1 border-t divider" />
      {!compact ? (
        <>
          <button role="menuitem" className="flex w-full items-center gap-3 px-4 py-2.5 hover:bg-surface2" onClick={() => (onDone?.(), nav("/profiles/new"))}>
            <Icon name="plus" size={18} /> Add a profile
          </button>
          <button role="menuitem" className="flex w-full items-center gap-3 px-4 py-2.5 hover:bg-surface2" onClick={() => (onDone?.(), nav("/business/new"))}>
            <Icon name="briefcase" size={18} /> Create a business profile
          </button>
        </>
      ) : null}
      <button role="menuitem" className="flex w-full items-center gap-3 px-4 py-2.5 hover:bg-surface2" onClick={async () => (onDone?.(), await signOut(), nav("/"))}>
        <Icon name="logout" size={18} /> Sign out
      </button>
    </div>
  );
}
