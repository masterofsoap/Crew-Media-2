import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { NotificationView, ProfileSummary } from "../../shared/types";
import { compactNumber, timeAgo } from "../lib/format";
import { errorMessage, get, post } from "../lib/api";
import { useSession } from "../lib/session";
import { useCursorList, LoadMore } from "../components/Feed";
import { Avatar } from "../components/Avatar";
import { Icon } from "../components/Icon";
import { MilestoneBadge } from "../components/MilestoneBadge";
import { Button, EmptyState, ErrorState, PageHeader, PostSkeleton, Tabs } from "../components/ui";
import { useToast } from "../components/toast";

const META: Record<string, { icon: string; color: string; verb: (n: NotificationView) => string }> = {
  follow: { icon: "user", color: "text-accent", verb: () => "followed you" },
  follow_request: { icon: "lock", color: "text-accent", verb: () => "requested to follow you" },
  like: { icon: "heart", color: "text-danger", verb: () => "liked your post" },
  reply: { icon: "reply", color: "text-accent", verb: () => "replied to your post" },
  mention: { icon: "sparkle", color: "text-accent", verb: () => "mentioned you" },
  repost: { icon: "repost", color: "text-success", verb: () => "reposted your post" },
  quote: { icon: "quote", color: "text-accent", verb: () => "quoted your post" },
  message: { icon: "mail", color: "text-accent", verb: (n) => (n.actorCount > 1 ? `sent you ${n.actorCount} messages` : "sent you a message") },
  milestone: { icon: "trophy", color: "text-accent", verb: () => "" },
  affiliate: { icon: "briefcase", color: "text-accent2", verb: (n) => (n.data.state === "requested" ? "invited you to be an affiliate" : `${String(n.data.state)} your affiliation`) },
  system: { icon: "bell", color: "text-muted", verb: (n) => String(n.data.message ?? "") },
};

function FollowRequests() {
  const [items, setItems] = useState<{ profile: ProfileSummary; createdAt: number }[] | null>(null);
  const toast = useToast();
  useEffect(() => {
    get<{ items: { profile: ProfileSummary; createdAt: number }[] }>("/follow-requests").then((r) => setItems(r.items)).catch(() => setItems([]));
  }, []);
  if (!items?.length) return null;
  return (
    <div className="border-b divider">
      <h2 className="px-4 pt-3 text-sm font-bold uppercase tracking-wide text-muted">Follow requests</h2>
      {items.map((r) => (
        <div key={r.profile.id} className="flex items-center gap-3 px-4 py-3">
          <Avatar profile={r.profile} size={40} />
          <Link to={`/@${r.profile.handle}`} className="min-w-0 flex-1 font-semibold hover:underline">
            {r.profile.displayName} <span className="font-normal text-muted">@{r.profile.handle}</span>
          </Link>
          {(["approve", "decline"] as const).map((d) => (
            <Button
              key={d}
              size="sm"
              variant={d === "approve" ? "primary" : "secondary"}
              onClick={async () => {
                try {
                  await post(`/follow-requests/${r.profile.id}/${d}`);
                  setItems((x) => x?.filter((y) => y.profile.id !== r.profile.id) ?? null);
                  toast(d === "approve" ? "Request approved" : "Request declined");
                } catch (e) {
                  toast(errorMessage(e), "error");
                }
              }}
            >
              {d === "approve" ? "Approve" : "Decline"}
            </Button>
          ))}
        </div>
      ))}
    </div>
  );
}

function Row({ n }: { n: NotificationView }) {
  const nav = useNavigate();
  const meta = META[n.type] ?? META.system!;
  const target = n.type === "message" ? `/messages/${String(n.data.conversationId ?? "")}` : n.post ? `/post/${n.post.id}` : n.type === "milestone" ? "milestones" : n.actor ? `/@${n.actor.handle}` : null;
  const { active } = useSession();
  return (
    <div
      role={target ? "link" : undefined}
      tabIndex={target ? 0 : undefined}
      onClick={() => target && nav(target === "milestones" ? `/@${active!.handle}/milestones` : target)}
      onKeyDown={(e) => e.key === "Enter" && target && nav(target === "milestones" ? `/@${active!.handle}/milestones` : target)}
      className={`flex cursor-pointer gap-3 border-b divider px-4 py-3 transition-colors hover:bg-surface2/30 ${n.read ? "" : "bg-[color-mix(in_srgb,var(--c-accent)_7%,transparent)]"}`}
    >
      <div className={`w-8 shrink-0 pt-1 ${meta.color}`}>
        {n.type === "milestone" ? <MilestoneBadge level={Number(n.data.level)} size={30} /> : <Icon name={meta.icon} size={24} filled={n.type === "like"} />}
      </div>
      <div className="min-w-0 flex-1 space-y-1">
        {n.actor ? <Avatar profile={n.actor} size={32} /> : null}
        <p className="text-[0.95rem]">
          {n.type === "milestone" ? (
            <>
              <b>Milestone unlocked: {String(n.data.name)}</b> — you reached {compactNumber(Number(n.data.threshold))} followers.
            </>
          ) : (
            <>
              {n.actor ? <b>{n.actor.displayName}</b> : "Someone"}
              {n.actor?.kind === "ai" ? <span className="chip ml-1">AI</span> : null}
              {n.actorCount > 1 && n.type !== "message" ? ` and ${compactNumber(n.actorCount - 1)} other${n.actorCount > 2 ? "s" : ""}` : ""} {meta.verb(n)}
            </>
          )}
          <span className="text-sm text-muted"> · {timeAgo(n.updatedAt)}</span>
        </p>
        {n.post ? <p className="line-clamp-2 text-sm text-muted">{n.post.text}</p> : null}
      </div>
    </div>
  );
}

export function Notifications() {
  const [filter, setFilter] = useState<"all" | "mentions">("all");
  const q = useCursorList<NotificationView>(["notifications", filter], `/notifications?filter=${filter}`);
  const qc = useQueryClient();
  const markAll = useMutation({
    mutationFn: () => post("/notifications/read", {}),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["notifications"] });
      void qc.invalidateQueries({ queryKey: ["session"] });
    },
  });
  // Opening the page marks everything read after a short delay (unread rows stay highlighted meanwhile).
  useEffect(() => {
    const t = setTimeout(() => markAll.mutate(), 2500);
    return () => clearTimeout(t);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <div>
      <PageHeader title="Notifications" actions={<Button variant="ghost" size="sm" onClick={() => markAll.mutate()}>Mark all read</Button>} />
      <Tabs label="Notification filter" value={filter} onChange={setFilter} tabs={[{ id: "all", label: "All" }, { id: "mentions", label: "Mentions & replies" }]} />
      {filter === "all" ? <FollowRequests /> : null}
      {q.isLoading ? <PostSkeleton /> : q.isError ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : null}
      {q.isSuccess && !items.length ? (
        <EmptyState icon="bell" title="No notifications yet">
          When people follow you, reply, mention or like your posts, you'll see it here.
        </EmptyState>
      ) : null}
      {items.map((n) => (
        <Row key={n.id} n={n} />
      ))}
      <LoadMore hasNext={!!q.hasNextPage} loading={q.isFetchingNextPage} onLoad={() => void q.fetchNextPage()} />
    </div>
  );
}
