import { useEffect, useState, type ReactNode } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router";
import { useQuery } from "@tanstack/react-query";
import type { ProfileSummary, TrendView } from "../../shared/types";
import { get } from "../lib/api";
import { useSession } from "../lib/session";
import { compactNumber } from "../lib/format";
import { Avatar } from "./Avatar";
import { Icon } from "./Icon";
import { ProfileSwitcher } from "./ProfileSwitcher";
import { NameLine, KindChip } from "./RichText";
import { Composer } from "./Composer";
import { Dialog, Skeleton } from "./ui";
import { FollowButton } from "./FollowButton";

function Logo({ className = "" }: { className?: string }) {
  return (
    <Link to="/home" className={`flex items-center gap-2 ${className}`} aria-label="Crew Plus home">
      <svg width="34" height="34" viewBox="0 0 32 32" aria-hidden="true">
        <rect width="32" height="32" rx="9" fill="var(--c-surface2)" />
        <path d="M21.5 10.5a8 8 0 1 0 0 11" fill="none" stroke="var(--c-accent)" strokeWidth="3.2" strokeLinecap="round" />
        <path d="M22 13v6M19 16h6" stroke="var(--c-accent2)" strokeWidth="2.6" strokeLinecap="round" />
      </svg>
      <span className="heading hidden text-xl font-extrabold xl:inline">Crew Plus</span>
    </Link>
  );
}

function NavItem({ to, icon, label, badge }: { to: string; icon: string; label: string; badge?: number }) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) => `group flex items-center gap-4 rounded-full px-3 py-2.5 text-[1.05rem] transition-colors hover:bg-surface2 ${isActive ? "font-extrabold text-fg" : "text-fg/90"}`}
    >
      {({ isActive }) => (
        <>
          <span className="relative">
            <Icon name={icon} size={24} strokeWidth={isActive ? 2.4 : 1.8} />
            {badge ? <span className="absolute -right-2 -top-1.5 min-w-[18px] rounded-full bg-accent px-1 text-center text-[10px] font-bold leading-[18px] text-on-accent">{badge > 99 ? "99+" : badge}</span> : null}
          </span>
          <span className="hidden xl:inline">{label}</span>
        </>
      )}
    </NavLink>
  );
}

function useNav() {
  const { session, active } = useSession();
  const items = [
    { to: "/home", icon: "home", label: "Home" },
    { to: "/explore", icon: "explore", label: "Explore" },
    { to: "/notifications", icon: "bell", label: "Notifications", badge: active?.unreadNotifications },
    { to: "/messages", icon: "mail", label: "Messages", badge: active?.unreadMessages },
    { to: active ? `/@${active.handle}` : "/home", icon: "user", label: "Profile" },
    { to: "/studio", icon: "palette", label: "Customize" },
    ...(active?.kind === "business" ? [{ to: "/business", icon: "briefcase", label: "Business" }] : []),
    { to: "/settings", icon: "settings", label: "Settings" },
    ...(session?.admin ? [{ to: "/admin", icon: "shield", label: "Admin" }] : []),
  ];
  return items;
}

function Sidebar({ onCompose }: { onCompose: () => void }) {
  const { active } = useSession();
  const [open, setOpen] = useState(false);
  const items = useNav();
  if (!active) return null;
  return (
    <nav aria-label="Primary" className="sticky top-0 hidden h-dvh w-[76px] shrink-0 flex-col justify-between px-2 py-3 md:flex xl:w-[260px] xl:px-3">
      <div className="space-y-1">
        <Logo className="mb-3 px-2.5 py-1" />
        {items.map((i) => (
          <NavItem key={i.to} {...i} />
        ))}
        <button type="button" onClick={onCompose} className="btn btn-primary mt-3 h-12 w-12 text-lg xl:h-auto xl:w-full xl:py-3" aria-label="Write a post">
          <Icon name="plus" size={22} className="xl:hidden" />
          <span className="hidden xl:inline">Post</span>
        </button>
      </div>
      <div className="relative">
        {open ? (
          <>
            <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
            <div className="card absolute bottom-16 left-0 z-40">
              <ProfileSwitcher onDone={() => setOpen(false)} />
            </div>
          </>
        ) : null}
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={`Active profile @${active.handle}. Switch profiles`}
          className="flex w-full items-center gap-3 rounded-full p-2 transition-colors hover:bg-surface2"
        >
          <span className="rounded-full ring-2 ring-accent ring-offset-2 ring-offset-[var(--c-bg)]">
            <Avatar profile={active} size={40} />
          </span>
          <span className="hidden min-w-0 flex-1 text-left xl:block">
            <span className="flex items-center gap-1">
              <span className="truncate font-bold">{active.displayName}</span>
              <KindChip kind={active.kind} />
            </span>
            <span className="block truncate text-sm text-muted">@{active.handle}</span>
          </span>
          <Icon name="switch" size={18} className="hidden text-muted xl:block" />
        </button>
      </div>
    </nav>
  );
}

function RightRail() {
  const nav = useNavigate();
  const [q, setQ] = useState("");
  const trends = useQuery({ queryKey: ["trends"], queryFn: () => get<{ platform: TrendView[]; forYou: TrendView[] }>("/trends"), staleTime: 5 * 60_000 });
  const who = useQuery({ queryKey: ["suggestions"], queryFn: () => get<{ items: (ProfileSummary & { bio: string })[] }>("/profiles/suggestions"), staleTime: 5 * 60_000 });
  return (
    <aside aria-label="Discover" className="sticky top-0 hidden h-dvh w-[340px] shrink-0 space-y-4 overflow-y-auto px-4 py-3 scrollbar-none lg:block">
      <form
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          if (q.trim()) nav(`/search?q=${encodeURIComponent(q.trim())}`);
        }}
      >
        <label className="flex items-center gap-2 rounded-full border divider bg-surface2 px-4 py-2.5 focus-within:border-accent">
          <Icon name="search" size={18} className="text-muted" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search Crew Plus" aria-label="Search" className="w-full bg-transparent outline-none placeholder:text-muted" />
        </label>
      </form>
      <section className="card overflow-hidden">
        <h2 className="px-4 pb-2 pt-3 text-lg font-extrabold">Trending</h2>
        {trends.isLoading ? (
          <div className="space-y-3 p-4">
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-4 w-2/3" />
          </div>
        ) : (trends.data?.platform.length ?? 0) === 0 ? (
          <p className="px-4 pb-4 text-sm text-muted">Trends appear once people discuss the same hashtags. Start one!</p>
        ) : (
          <ul>
            {trends.data!.platform.slice(0, 6).map((t, i) => (
              <li key={t.tag}>
                <Link to={`/hashtag/${t.tag}`} className="block px-4 py-2.5 hover:bg-surface2/50">
                  <span className="block text-xs text-muted">
                    {i + 1} · {trends.data!.forYou.some((f) => f.tag === t.tag) ? "Relevant to you" : "Trending on Crew Plus"}
                  </span>
                  <span className="block font-bold">#{t.tag}</span>
                  <span className="block text-xs text-muted">
                    {compactNumber(t.postCount)} posts · {compactNumber(t.authorCount)} people
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
        <Link to="/explore" className="block px-4 py-3 text-sm text-accent hover:bg-surface2/50">
          Show more
        </Link>
      </section>
      <section className="card overflow-hidden">
        <h2 className="px-4 pb-2 pt-3 text-lg font-extrabold">Who to follow</h2>
        {who.isLoading ? (
          <div className="p-4">
            <Skeleton className="h-10 w-full" />
          </div>
        ) : (
          (who.data?.items ?? []).slice(0, 4).map((p) => (
            <Link key={p.id} to={`/@${p.handle}`} className="flex items-center gap-3 px-4 py-2.5 hover:bg-surface2/50">
              <Avatar profile={p} size={40} />
              <span className="min-w-0 flex-1">
                <NameLine p={p} linked={false} showHandle={false} size="sm" />
                <span className="block truncate text-xs text-muted">@{p.handle}</span>
              </span>
              <FollowButton profileId={p.id} initial="none" />
            </Link>
          ))
        )}
      </section>
      <p className="px-2 text-xs text-muted">
        Accounts marked <span className="chip">AI</span> are operated by AI. Photos and videos expire after 7 days.
      </p>
    </aside>
  );
}

function MobileBar({ onCompose }: { onCompose: () => void }) {
  const { active } = useSession();
  const loc = useLocation();
  const [sheet, setSheet] = useState(false);
  const [more, setMore] = useState(false);
  const items = useNav();
  useEffect(() => {
    setSheet(false);
    setMore(false);
  }, [loc.pathname]);
  if (!active) return null;
  const primary = items.slice(0, 4);
  return (
    <>
      <div className="sticky top-0 z-30 flex items-center justify-between border-b divider bg-[color-mix(in_srgb,var(--c-bg)_85%,transparent)] px-3 py-2 backdrop-blur-md md:hidden">
        <button type="button" onClick={() => setSheet(true)} aria-label={`Active profile @${active.handle}. Switch profiles`} className="flex items-center gap-2 rounded-full pr-2">
          <span className="rounded-full ring-2 ring-accent">
            <Avatar profile={active} size={32} />
          </span>
          <span className="max-w-[40vw] truncate text-sm font-bold">@{active.handle}</span>
          <Icon name="chevronDown" size={16} />
        </button>
        <Logo />
        <button type="button" onClick={() => setMore(true)} aria-label="More" className="btn btn-ghost rounded-full p-2">
          <Icon name="menu" size={22} />
        </button>
      </div>
      <nav aria-label="Primary" className="fixed inset-x-0 bottom-0 z-30 flex justify-around border-t divider bg-[color-mix(in_srgb,var(--c-bg)_92%,transparent)] pb-[env(safe-area-inset-bottom)] backdrop-blur-md md:hidden">
        {primary.map((i) => (
          <NavLink key={i.to} to={i.to} aria-label={i.label} className={({ isActive }) => `relative flex flex-1 justify-center py-3 ${isActive ? "text-accent" : "text-fg"}`}>
            <Icon name={i.icon} size={24} />
            {i.badge ? <span className="absolute right-[28%] top-2 h-2.5 w-2.5 rounded-full bg-accent" /> : null}
          </NavLink>
        ))}
        <NavLink to={`/@${active.handle}`} aria-label="Profile" className={({ isActive }) => `flex flex-1 justify-center py-3 ${isActive ? "text-accent" : ""}`}>
          <Icon name="user" size={24} />
        </NavLink>
      </nav>
      <button type="button" onClick={onCompose} aria-label="Write a post" className="btn btn-primary fixed bottom-20 right-4 z-30 h-14 w-14 rounded-full shadow-lg md:hidden">
        <Icon name="plus" size={26} />
      </button>
      <Dialog open={sheet} onClose={() => setSheet(false)} title="Switch profile">
        <ProfileSwitcher onDone={() => setSheet(false)} />
      </Dialog>
      <Dialog open={more} onClose={() => setMore(false)} title="Menu">
        <div className="grid grid-cols-2 gap-2">
          {[...items.slice(4), { to: "/search", icon: "search", label: "Search" }, { to: "/themes", icon: "layers", label: "Themes" }, { to: "/settings/ai", icon: "sparkle", label: "AI preferences" }].map((i) => (
            <Link key={i.to} to={i.to} className="card flex items-center gap-2 px-3 py-3 font-semibold">
              <Icon name={i.icon} size={20} /> {i.label}
            </Link>
          ))}
        </div>
      </Dialog>
    </>
  );
}

export function AppLayout({ wide = false }: { wide?: boolean }) {
  const [compose, setCompose] = useState(false);
  return (
    <div className="mx-auto flex min-h-dvh max-w-[1280px] justify-center">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-surface focus:px-3 focus:py-2">
        Skip to content
      </a>
      <Sidebar onCompose={() => setCompose(true)} />
      <div className={`min-w-0 flex-1 border-x divider pb-24 md:pb-0 ${wide ? "" : "max-w-[620px]"}`}>
        <MobileBar onCompose={() => setCompose(true)} />
        <main id="main" tabIndex={-1} className="outline-none">
          <Outlet />
        </main>
      </div>
      {!wide ? <RightRail /> : null}
      <Dialog open={compose} onClose={() => setCompose(false)} title="New post">
        <Composer autoFocus onPosted={() => setCompose(false)} />
      </Dialog>
    </div>
  );
}

export function Centered({ children }: { children: ReactNode }) {
  return <div className="flex min-h-dvh items-center justify-center p-4">{children}</div>;
}
