import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { parseAppearance } from "../../shared/appearance";
import { MILESTONES } from "../../shared/constants";
import type { ConversationView, PostView, ProfileDetail, ProfileSummary } from "../../shared/types";
import { del, errorMessage, get, post } from "../lib/api";
import { compactNumber, fullDate } from "../lib/format";
import { useSession } from "../lib/session";
import { ProfileCanvas } from "../components/ProfileCanvas";
import { FollowButton, UserRow } from "../components/FollowButton";
import { Feed, useCursorList, LoadMore } from "../components/Feed";
import { PostCard } from "../components/PostCard";
import { MilestoneBadge } from "../components/MilestoneBadge";
import { Button, ConfirmDialog, EmptyState, ErrorState, IconButton, PageHeader, Skeleton, Tabs } from "../components/ui";
import { ReportDialog } from "../components/ReportDialog";
import { useToast } from "../components/toast";
import { Icon } from "../components/Icon";
import { NotFound } from "../components/NotFound";

function parseHandle(raw: string | undefined): string | null {
  if (!raw || !raw.startsWith("@")) return null;
  const h = raw.slice(1);
  return /^[A-Za-z0-9_]{1,20}$/.test(h) ? h : null;
}

export function useProfile(handle: string | null) {
  return useQuery({ queryKey: ["profile", handle], enabled: !!handle, queryFn: ({ signal }) => get<ProfileDetail>(`/profiles/${handle}`, signal) });
}

function ProfileActions({ p }: { p: ProfileDetail }) {
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const [menu, setMenu] = useState(false);
  const [confirmBlock, setConfirmBlock] = useState(false);
  const [report, setReport] = useState(false);
  const rel = p.relationship!;
  const refresh = () => void qc.invalidateQueries({ queryKey: ["profile", p.handle] });
  const message = useMutation({
    mutationFn: () => post<ConversationView>("/conversations", { memberIds: [p.id] }),
    onSuccess: (c) => nav(`/messages/${c.id}`),
    onError: (e) => toast(errorMessage(e), "error"),
  });
  const mute = useMutation({ mutationFn: () => (rel.muting ? del(`/mutes/${p.id}`) : post(`/mutes/${p.id}`)), onSuccess: () => (toast(rel.muting ? "Unmuted" : "Muted. You won't see their posts in feeds."), refresh()) });
  const block = useMutation({
    mutationFn: () => (rel.blocking ? del(`/blocks/${p.id}`) : post(`/blocks/${p.id}`)),
    onSuccess: () => {
      toast(rel.blocking ? "Unblocked" : "Blocked");
      setConfirmBlock(false);
      refresh();
    },
    onError: (e) => toast(errorMessage(e), "error"),
  });
  return (
    <>
      <div className="relative">
        <IconButton icon="more" label="More options" className="border divider bg-surface" onClick={() => setMenu((m) => !m)} aria-haspopup="menu" aria-expanded={menu} />
        {menu ? (
          <>
            <div className="fixed inset-0 z-30" onClick={() => setMenu(false)} />
            <div role="menu" className="card absolute right-0 top-11 z-40 w-52 py-1 text-left text-sm">
              <button role="menuitem" className="flex w-full items-center gap-2 px-3 py-2 hover:bg-surface2" onClick={() => (setMenu(false), mute.mutate())}>
                <Icon name="mute" size={16} /> {rel.muting ? "Unmute" : "Mute"} @{p.handle}
              </button>
              <button role="menuitem" className="flex w-full items-center gap-2 px-3 py-2 text-danger hover:bg-surface2" onClick={() => (setMenu(false), rel.blocking ? block.mutate() : setConfirmBlock(true))}>
                <Icon name="block" size={16} /> {rel.blocking ? "Unblock" : "Block"} @{p.handle}
              </button>
              <button role="menuitem" className="flex w-full items-center gap-2 px-3 py-2 hover:bg-surface2" onClick={() => (setMenu(false), setReport(true))}>
                <Icon name="flag" size={16} /> Report profile
              </button>
            </div>
          </>
        ) : null}
      </div>
      {rel.canMessage && !rel.blocking ? <IconButton icon="mail" label="Message" className="border divider bg-surface" onClick={() => message.mutate()} disabled={message.isPending} /> : null}
      {rel.blocking ? (
        <Button variant="danger" size="sm" onClick={() => block.mutate()}>Blocked</Button>
      ) : (
        <FollowButton profileId={p.id} initial={rel.following ? "following" : rel.requested ? "requested" : "none"} onChange={refresh} />
      )}
      <ConfirmDialog
        open={confirmBlock}
        onClose={() => setConfirmBlock(false)}
        title={`Block @${p.handle}?`}
        body="They won't be able to follow you, message you or see your posts, and you won't see theirs. Existing follows between you are removed. AI accounts also respect blocks."
        confirmLabel="Block"
        danger
        busy={block.isPending}
        onConfirm={() => block.mutate()}
      />
      <ReportDialog open={report} onClose={() => setReport(false)} targetType="profile" targetId={p.id} />
    </>
  );
}

function ProfilePosts({ p }: { p: ProfileDetail }) {
  const [tab, setTab] = useState<"posts" | "replies" | "media" | "likes">("posts");
  const pinned = useQuery({ queryKey: ["post", p.pinnedPostId], enabled: !!p.pinnedPostId && tab === "posts", queryFn: () => get<{ post: PostView }>(`/posts/${p.pinnedPostId}`) });
  if (!p.canView)
    return (
      <div className="pc-card">
        <EmptyState icon="lock" title="These posts are protected">Only approved followers can see @{p.handle}'s posts. Send a follow request to ask.</EmptyState>
      </div>
    );
  return (
    <div className="pc-card overflow-hidden">
      <Tabs
        label="Profile content"
        value={tab}
        onChange={setTab}
        tabs={[
          { id: "posts", label: "Posts" },
          { id: "replies", label: "Replies" },
          { id: "media", label: "Media" },
          ...(p.likesPublic || p.isSelf ? [{ id: "likes" as const, label: "Likes" }] : []),
        ]}
      />
      {tab === "posts" && pinned.data && !pinned.data.post.deleted ? (
        <div className="border-b divider">
          <div className="flex items-center gap-1.5 px-4 pt-2 text-xs font-semibold text-muted">
            <Icon name="pin" size={14} /> Pinned
          </div>
          <PostCard post={pinned.data.post} />
        </div>
      ) : null}
      <Feed
        key={tab}
        queryKey={["timeline", p.handle, tab]}
        path={`/profiles/${p.handle}/timeline?tab=${tab}`}
        empty={<EmptyState icon={tab === "media" ? "image" : tab === "likes" ? "heart" : "reply"} title={tab === "media" ? "No media yet" : tab === "likes" ? "No likes yet" : "Nothing here yet"}>{p.isSelf && tab === "posts" ? "Share your first post — the community is listening." : null}</EmptyState>}
      />
    </div>
  );
}

function Highlights({ ids }: { ids: string[] }) {
  const [broken, setBroken] = useState<Set<string>>(new Set());
  if (!ids.length) return null;
  return (
    <div className="pc-card p-3">
      <h2 className="mb-2 px-1 text-sm font-bold uppercase tracking-wide text-muted">Highlights</h2>
      <div className="grid grid-cols-3 gap-1.5">
        {ids.map((id) =>
          broken.has(id) ? (
            <div key={id} className="grid aspect-square place-items-center rounded-lg bg-surface2 p-2 text-center text-[11px] text-muted">Media expired</div>
          ) : (
            <img key={id} src={`/api/media/${id}`} alt="" loading="lazy" onError={() => setBroken((b) => new Set(b).add(id))} className="aspect-square w-full rounded-lg object-cover" />
          ),
        )}
      </div>
    </div>
  );
}

export function ProfilePage() {
  const { handle: raw } = useParams();
  const handle = parseHandle(raw);
  const nav = useNavigate();
  const q = useProfile(handle);
  const { active } = useSession();
  const appearance = q.data ? parseAppearance(q.data.appearance) : null;
  const featured = useQuery({
    queryKey: ["featured", handle, appearance?.featuredPostIds.join(",")],
    enabled: !!appearance?.featuredPostIds.length && !!q.data?.canView,
    queryFn: async () => (await Promise.all(appearance!.featuredPostIds.map((id) => get<{ post: PostView }>(`/posts/${id}`).then((r) => r.post).catch(() => null)))).filter((p): p is PostView => !!p && !p.deleted),
  });
  if (!handle) return <NotFound />;
  if (q.isLoading)
    return (
      <div className="space-y-3 p-4">
        <Skeleton className="h-48 w-full" />
        <Skeleton className="h-6 w-1/3" />
        <Skeleton className="h-4 w-2/3" />
      </div>
    );
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const p = q.data!;
  return (
    <div>
      <PageHeader title={p.displayName} subtitle={`${compactNumber(p.postCount)} posts`} back={() => nav(-1)} />
      <ProfileCanvas
        profile={p}
        appearance={appearance!}
        featured={featured.data ?? []}
        highlighted={p.canView ? <Highlights ids={appearance!.highlightedMediaIds} /> : null}
        actions={
          p.isSelf ? (
            <>
              <Link to="/studio"><Button variant="secondary" size="sm" icon="palette">Customize</Button></Link>
              <Link to="/settings"><Button variant="secondary" size="sm">Edit profile</Button></Link>
            </>
          ) : active ? (
            <ProfileActions p={p} />
          ) : null
        }
        postsSection={<ProfilePosts p={p} />}
      />
    </div>
  );
}

export function FollowList() {
  const { handle: raw, list } = useParams();
  const handle = parseHandle(raw);
  const nav = useNavigate();
  const valid = list === "followers" || list === "following";
  const q = useCursorList<ProfileSummary & { viewerFollows: boolean }>(["follows", handle, list], `/profiles/${handle}/${list}`, !!handle && valid);
  if (!handle || !valid) return <NotFound />;
  const items = q.data?.pages.flatMap((pg) => pg.items) ?? [];
  return (
    <div>
      <PageHeader title={list === "followers" ? "Followers" : "Following"} subtitle={`@${handle}`} back={() => nav(-1)} />
      <Tabs
        label="Follow lists"
        value={list}
        onChange={(v) => nav(`/@${handle}/${v}`, { replace: true })}
        tabs={[
          { id: "followers", label: "Followers" },
          { id: "following", label: "Following" },
        ]}
      />
      {q.isError ? <ErrorState error={q.error} /> : null}
      {q.isSuccess && !items.length ? <EmptyState icon="users" title={list === "followers" ? "No followers yet" : "Not following anyone yet"} /> : null}
      {items.map((p) => (
        <UserRow key={p.id} p={p} following={p.viewerFollows} />
      ))}
      <LoadMore hasNext={!!q.hasNextPage} loading={q.isFetchingNextPage} onLoad={() => void q.fetchNextPage()} />
    </div>
  );
}

export function MilestonesPage() {
  const { handle: raw } = useParams();
  const handle = parseHandle(raw);
  const nav = useNavigate();
  const q = useProfile(handle);
  if (!handle) return <NotFound />;
  const p = q.data;
  const next = p ? MILESTONES.find((m) => p.followerCount < m.threshold) : null;
  const prev = p && next ? [...MILESTONES].reverse().find((m) => m.threshold <= p.followerCount)?.threshold ?? 0 : 0;
  const pct = p && next ? Math.max(0, Math.min(100, ((p.followerCount - prev) / (next.threshold - prev)) * 100)) : 100;
  return (
    <div>
      <PageHeader title="Milestones" subtitle={`@${handle}`} back={() => nav(-1)} />
      {q.isError ? <ErrorState error={q.error} /> : null}
      {p ? (
        <div className="space-y-4 p-4">
          <div className="card space-y-3 p-5">
            <p className="text-sm text-muted">Followers</p>
            <p className="heading text-4xl font-extrabold">{p.followerCount.toLocaleString()}</p>
            {next ? (
              <>
                <div className="h-3 overflow-hidden rounded-full bg-surface2" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100} aria-label={`Progress to ${next.name}`}>
                  <div className="h-full rounded-full bg-gradient-to-r from-[var(--c-accent)] to-[var(--c-accent2)]" style={{ width: `${pct}%` }} />
                </div>
                <p className="text-sm">
                  <b>{(next.threshold - p.followerCount).toLocaleString()}</b> more followers to unlock <b>{next.name}</b>.
                </p>
              </>
            ) : (
              <p className="text-sm font-semibold text-accent">Every milestone unlocked. Legendary.</p>
            )}
            <p className="text-xs text-muted">Milestones celebrate community popularity — they are not identity verification. They're awarded from real follow relationships and kept forever once earned.</p>
          </div>
          <ol className="grid gap-3 sm:grid-cols-2">
            {p.milestones.map((m) => (
              <li key={m.level} className={`card flex items-center gap-4 p-4 ${m.achievedAt ? "" : "opacity-80"}`}>
                <MilestoneBadge level={m.level} size={56} locked={!m.achievedAt} />
                <div>
                  <p className="font-bold">{m.name}</p>
                  <p className="text-sm text-muted">{m.material} · {compactNumber(m.threshold)} followers</p>
                  <p className="text-xs text-muted">{m.achievedAt ? `Earned ${fullDate(m.achievedAt)}` : "Locked"}</p>
                </div>
              </li>
            ))}
          </ol>
        </div>
      ) : null}
    </div>
  );
}
