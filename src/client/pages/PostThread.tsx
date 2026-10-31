import { useNavigate, useParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import type { PostView } from "../../shared/types";
import { get } from "../lib/api";
import { fullDate } from "../lib/format";
import { useCursorList, LoadMore } from "../components/Feed";
import { PostCard } from "../components/PostCard";
import { Composer } from "../components/Composer";
import { EmptyState, ErrorState, PageHeader, PostSkeleton } from "../components/ui";

export function PostThread() {
  const { id = "" } = useParams();
  const nav = useNavigate();
  const q = useQuery({ queryKey: ["post", id], queryFn: ({ signal }) => get<{ post: PostView; ancestors: PostView[] }>(`/posts/${id}`, signal) });
  const replies = useCursorList<PostView>(["replies", id], `/posts/${id}/replies`, q.isSuccess);
  return (
    <div>
      <PageHeader title="Post" back={() => nav(-1)} />
      {q.isLoading ? (
        <PostSkeleton />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : (
        <>
          {q.data!.ancestors.map((a) => (
            <div key={a.id} className="relative">
              <span className="absolute bottom-0 left-[37px] top-14 w-0.5 bg-[var(--c-border)]" aria-hidden="true" />
              <PostCard post={a} />
            </div>
          ))}
          <PostCard post={q.data!.post} focus onDeleted={() => nav("/home")} />
          {!q.data!.post.deleted ? (
            <div className="border-b divider px-4 py-3">
              <Composer replyToId={id} placeholder="Post your reply" />
            </div>
          ) : null}
          {replies.isLoading ? <PostSkeleton /> : null}
          {(replies.data?.pages.flatMap((p) => p.items) ?? []).map((r) => (
            <PostCard key={r.id} post={r} />
          ))}
          {replies.isSuccess && !replies.data.pages[0]?.items.length ? <EmptyState icon="reply" title="No replies yet">Start the conversation.</EmptyState> : null}
          <LoadMore hasNext={!!replies.hasNextPage} loading={replies.isFetchingNextPage} onLoad={() => void replies.fetchNextPage()} />
        </>
      )}
    </div>
  );
}

export function PostHistory() {
  const { id = "" } = useParams();
  const nav = useNavigate();
  const post = useQuery({ queryKey: ["post", id], queryFn: () => get<{ post: PostView }>(`/posts/${id}`) });
  const q = useQuery({ queryKey: ["revisions", id], queryFn: () => get<{ items: { text: string; replacedAt: number }[] }>(`/posts/${id}/revisions`) });
  return (
    <div>
      <PageHeader title="Edit history" back={() => nav(-1)} />
      {post.data ? (
        <div className="border-b divider p-4">
          <p className="mb-1 text-xs font-semibold uppercase text-muted">Current version</p>
          <p className="whitespace-pre-wrap">{post.data.post.text}</p>
        </div>
      ) : null}
      {q.isError ? <ErrorState error={q.error} /> : null}
      {(q.data?.items ?? []).map((r, i) => (
        <div key={i} className="border-b divider p-4">
          <p className="mb-1 text-xs text-muted">Replaced {fullDate(r.replacedAt)}</p>
          <p className="whitespace-pre-wrap text-muted">{r.text}</p>
        </div>
      ))}
    </div>
  );
}
