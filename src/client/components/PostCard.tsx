import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { FeedItem, PostView } from "../../shared/types";
import { compactNumber, fullDate, timeAgo } from "../lib/format";
import { del, errorMessage, post as apiPost } from "../lib/api";
import { useSession } from "../lib/session";
import { Avatar } from "./Avatar";
import { Icon } from "./Icon";
import { MediaGrid } from "./MediaGrid";
import { NameLine, RichText } from "./RichText";
import { ConfirmDialog, Dialog } from "./ui";
import { useToast } from "./toast";
import { Composer } from "./Composer";
import { ReportDialog } from "./ReportDialog";

/** Apply a change to every cached copy of a post (feeds, threads, profiles) for optimistic UI. */
export function usePatchPost() {
  const qc = useQueryClient();
  return (id: string, fn: (p: PostView) => PostView) => {
    const visit = (v: unknown): unknown => {
      if (!v || typeof v !== "object") return v;
      if (Array.isArray(v)) return v.map(visit);
      const o = v as Record<string, unknown>;
      if (o.id === id && "author" in o && "likeCount" in o) return fn(o as unknown as PostView);
      let changed = false;
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(o)) {
        const nv = visit(val);
        if (nv !== val) changed = true;
        out[k] = nv;
      }
      return changed ? out : o;
    };
    for (const q of qc.getQueryCache().getAll()) {
      const key = q.queryKey[0];
      if (key === "feed" || key === "post" || key === "timeline" || key === "replies" || key === "search" || key === "hashtag" || key === "topic") {
        qc.setQueryData(q.queryKey, (old: unknown) => visit(old));
      }
    }
  };
}

function Action({ icon, label, count, active, activeClass, onClick, filled }: { icon: string; label: string; count?: number; active?: boolean; activeClass?: string; onClick: () => void; filled?: boolean }) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={`group inline-flex items-center gap-1.5 rounded-full px-2 py-1.5 text-sm transition-colors ${active ? activeClass : "text-muted hover:text-fg"}`}
    >
      <span className="grid place-items-center rounded-full p-1 transition-colors group-hover:bg-surface2">
        <Icon name={icon} size={18} filled={filled} className={active && filled ? "animate-pop" : undefined} />
      </span>
      {count !== undefined && count > 0 ? <span className="tabular-nums">{compactNumber(count)}</span> : null}
    </button>
  );
}

export function QuoteCard({ post }: { post: PostView }) {
  const nav = useNavigate();
  if (post.deleted) return <div className="rounded-2xl border divider p-3 text-sm text-muted">This post is unavailable.</div>;
  return (
    <div
      role="link"
      tabIndex={0}
      onClick={(e) => {
        e.stopPropagation();
        nav(`/post/${post.id}`);
      }}
      onKeyDown={(e) => e.key === "Enter" && nav(`/post/${post.id}`)}
      className="cursor-pointer space-y-1.5 rounded-2xl border divider p-3 transition-colors hover:bg-surface2/50"
    >
      <div className="flex items-center gap-2">
        <Avatar profile={post.author} size={20} />
        <NameLine p={post.author} linked={false} size="sm" />
        <span className="text-xs text-muted">· {timeAgo(post.createdAt)}</span>
      </div>
      {post.text ? <RichText text={post.text} className="line-clamp-4 text-sm" /> : null}
      <MediaGrid media={post.media} compact />
    </div>
  );
}

export function PostCard({ item, post: postProp, focus = false, hideThreadLine = true, onDeleted }: { item?: FeedItem; post?: PostView; focus?: boolean; hideThreadLine?: boolean; onDeleted?: () => void }) {
  const p = (item?.post ?? postProp)!;
  const nav = useNavigate();
  const { active } = useSession();
  const toast = useToast();
  const patchPost = usePatchPost();
  const qc = useQueryClient();
  const [menu, setMenu] = useState(false);
  const [replying, setReplying] = useState(false);
  const [quoting, setQuoting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [editing, setEditing] = useState(false);
  const [reporting, setReporting] = useState(false);
  const mine = active?.id === p.author.id;

  const like = useMutation({
    mutationFn: () => (p.liked ? del<{ likeCount: number }>(`/posts/${p.id}/like`) : apiPost<{ likeCount: number }>(`/posts/${p.id}/like`)),
    onMutate: () => patchPost(p.id, (x) => ({ ...x, liked: !x.liked, likeCount: x.likeCount + (x.liked ? -1 : 1) })),
    onError: (e) => {
      patchPost(p.id, (x) => ({ ...x, liked: !x.liked, likeCount: x.likeCount + (x.liked ? -1 : 1) }));
      toast(errorMessage(e), "error");
    },
  });
  const repost = useMutation({
    mutationFn: () => (p.reposted ? del(`/posts/${p.id}/repost`) : apiPost(`/posts/${p.id}/repost`)),
    onMutate: () => patchPost(p.id, (x) => ({ ...x, reposted: !x.reposted, repostCount: x.repostCount + (x.reposted ? -1 : 1) })),
    onSuccess: () => toast(p.reposted ? "Repost removed" : "Reposted"),
    onError: (e) => {
      patchPost(p.id, (x) => ({ ...x, reposted: !x.reposted, repostCount: x.repostCount + (x.reposted ? -1 : 1) }));
      toast(errorMessage(e), "error");
    },
  });
  const remove = useMutation({
    mutationFn: () => del(`/posts/${p.id}`),
    onSuccess: () => {
      toast("Post deleted");
      setConfirmDelete(false);
      void qc.invalidateQueries({ queryKey: ["feed"] });
      void qc.invalidateQueries({ queryKey: ["timeline"] });
      onDeleted?.();
    },
    onError: (e) => toast(errorMessage(e), "error"),
  });

  if (p.deleted) {
    return <div className="border-b divider px-4 py-4 text-sm text-muted">{p.moderation === "removed" ? "This post was removed by moderators." : "This post was deleted."}</div>;
  }

  const share = async () => {
    const url = `${location.origin}/post/${p.id}`;
    try {
      await navigator.clipboard.writeText(url);
      toast("Link copied");
    } catch {
      toast(url, "info");
    }
  };

  return (
    <article
      className={`relative border-b divider px-4 pb-1.5 pt-3 transition-colors ${focus ? "" : "cursor-pointer hover:bg-surface2/30"}`}
      onClick={() => !focus && nav(`/post/${p.id}`)}
      aria-label={`Post by ${p.author.displayName}`}
    >
      {item?.repostedBy ? (
        <div className="mb-1 ml-8 flex items-center gap-1.5 text-xs font-semibold text-muted">
          <Icon name="repost" size={14} />
          <Link to={`/@${item.repostedBy.handle}`} onClick={(e) => e.stopPropagation()} className="hover:underline">
            {item.repostedBy.id === active?.id ? "You" : item.repostedBy.displayName} reposted
          </Link>
        </div>
      ) : item?.reason && !focus ? (
        <div className="mb-1 ml-14 text-xs text-muted">{item.reason}</div>
      ) : null}
      <div className="flex gap-3">
        <Link to={`/@${p.author.handle}`} onClick={(e) => e.stopPropagation()} className="shrink-0" aria-label={`${p.author.displayName}'s profile`}>
          <Avatar profile={p.author} size={focus ? 48 : 44} />
        </Link>
        <div className="min-w-0 flex-1">
          <div className="flex items-start gap-1">
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-1">
                <NameLine p={p.author} stacked={focus} handle="wide" />
                {!focus ? (
                  <span className="shrink-0 text-sm text-muted" title={fullDate(p.createdAt)}>
                    · {timeAgo(p.createdAt)}
                  </span>
                ) : null}
              </div>
              {p.replyToHandle && !hideThreadLine ? null : p.replyToHandle ? (
                <div className="text-sm text-muted">
                  Replying to{" "}
                  <Link to={`/@${p.replyToHandle}`} className="text-accent" onClick={(e) => e.stopPropagation()}>
                    @{p.replyToHandle}
                  </Link>
                </div>
              ) : null}
            </div>
            <div className="relative">
              <button type="button" aria-label="Post options" aria-haspopup="menu" aria-expanded={menu} className="btn btn-ghost rounded-full p-1.5 text-muted" onClick={(e) => (e.stopPropagation(), setMenu((m) => !m))}>
                <Icon name="more" size={18} />
              </button>
              {menu ? (
                <div role="menu" className="card absolute right-0 top-8 z-30 w-48 overflow-hidden py-1 text-sm" onClick={(e) => e.stopPropagation()} onMouseLeave={() => setMenu(false)}>
                  <button role="menuitem" className="flex w-full items-center gap-2 px-3 py-2 hover:bg-surface2" onClick={() => (setMenu(false), void share())}>
                    <Icon name="link" size={16} /> Copy link
                  </button>
                  {mine ? (
                    <>
                      <button role="menuitem" className="flex w-full items-center gap-2 px-3 py-2 hover:bg-surface2" onClick={() => (setMenu(false), setEditing(true))}>
                        <Icon name="edit" size={16} /> Edit
                      </button>
                      <button role="menuitem" className="flex w-full items-center gap-2 px-3 py-2 text-danger hover:bg-surface2" onClick={() => (setMenu(false), setConfirmDelete(true))}>
                        <Icon name="trash" size={16} /> Delete
                      </button>
                    </>
                  ) : (
                    <button role="menuitem" className="flex w-full items-center gap-2 px-3 py-2 hover:bg-surface2" onClick={() => (setMenu(false), setReporting(true))}>
                      <Icon name="flag" size={16} /> Report post
                    </button>
                  )}
                </div>
              ) : null}
            </div>
          </div>
          {p.text ? <RichText text={p.text} className={`mt-0.5 ${focus ? "text-[1.15rem] leading-relaxed" : ""}`} /> : null}
          {p.media.length ? (
            <div className="mt-2.5">
              <MediaGrid media={p.media} />
            </div>
          ) : null}
          {p.quote ? (
            <div className="mt-2.5">
              <QuoteCard post={p.quote} />
            </div>
          ) : null}
          {focus ? (
            <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 border-b divider pb-3 text-sm text-muted">
              <time dateTime={new Date(p.createdAt).toISOString()}>{fullDate(p.createdAt)}</time>
              {p.editedAt ? (
                <Link to={`/post/${p.id}/history`} className="hover:underline">
                  Edited {timeAgo(p.editedAt)}
                </Link>
              ) : null}
              {p.aiGenerated ? <span className="chip">AI-generated</span> : null}
            </div>
          ) : p.editedAt ? (
            <span className="text-xs text-muted">Edited</span>
          ) : null}
          <div className="-ml-2 mt-1 flex max-w-md items-center justify-between">
            <Action icon="reply" label={`Reply (${p.replyCount})`} count={p.replyCount} onClick={() => setReplying(true)} />
            <Action icon="repost" label={p.reposted ? "Undo repost" : "Repost"} count={p.repostCount} active={p.reposted} activeClass="text-success" onClick={() => repost.mutate()} />
            <Action icon="quote" label="Quote post" count={p.quoteCount} onClick={() => setQuoting(true)} />
            <Action icon="heart" label={p.liked ? "Unlike" : "Like"} count={p.likeCount} active={p.liked} activeClass="text-danger" filled={p.liked} onClick={() => like.mutate()} />
            <Action icon="share" label="Copy link to post" onClick={() => void share()} />
          </div>
        </div>
      </div>
      <Dialog open={replying} onClose={() => setReplying(false)} title={`Reply to @${p.author.handle}`}>
        <div onClick={(e) => e.stopPropagation()}>
          <QuoteCard post={p} />
          <div className="mt-3">
            <Composer replyToId={p.id} autoFocus placeholder="Write your reply" onPosted={() => setReplying(false)} />
          </div>
        </div>
      </Dialog>
      <Dialog open={quoting} onClose={() => setQuoting(false)} title="Quote post">
        <div onClick={(e) => e.stopPropagation()}>
          <Composer quoteOfId={p.id} autoFocus placeholder="Add your commentary" onPosted={() => setQuoting(false)} />
          <div className="mt-3">
            <QuoteCard post={p} />
          </div>
        </div>
      </Dialog>
      <Dialog open={editing} onClose={() => setEditing(false)} title="Edit post">
        <div onClick={(e) => e.stopPropagation()}>
          <p className="mb-2 text-xs text-muted">Edits are shown publicly with history. Attachments can't be changed.</p>
          <Composer editPost={p} autoFocus onPosted={() => setEditing(false)} />
        </div>
      </Dialog>
      <ConfirmDialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title="Delete post?"
        body="This removes the post from feeds, profiles and search. Attached media is deleted too. This can't be undone."
        confirmLabel="Delete"
        danger
        busy={remove.isPending}
        onConfirm={() => remove.mutate()}
      />
      <ReportDialog open={reporting} onClose={() => setReporting(false)} targetType="post" targetId={p.id} />
    </article>
  );
}
