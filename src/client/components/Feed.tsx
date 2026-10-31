import { useEffect, useRef, type ReactNode } from "react";
import { useInfiniteQuery, type QueryKey } from "@tanstack/react-query";
import type { FeedItem, Page } from "../../shared/types";
import { get } from "../lib/api";
import { PostCard } from "./PostCard";
import { Button, ErrorState, PostSkeleton, Spinner } from "./ui";

/** Cursor-paginated list with infinite scroll (IntersectionObserver) and explicit "load more" fallback. */
export function useCursorList<T>(key: QueryKey, path: string, enabled = true) {
  return useInfiniteQuery({
    queryKey: key,
    enabled,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => get<Page<T>>(`${path}${path.includes("?") ? "&" : "?"}${pageParam ? `cursor=${encodeURIComponent(pageParam)}` : ""}`, signal),
    getNextPageParam: (last) => last.cursor,
  });
}

export function LoadMore({ hasNext, loading, onLoad }: { hasNext: boolean; loading: boolean; onLoad: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || !hasNext) return;
    const io = new IntersectionObserver((entries) => entries[0]?.isIntersecting && !loading && onLoad(), { rootMargin: "600px" });
    io.observe(el);
    return () => io.disconnect();
  }, [hasNext, loading, onLoad]);
  if (!hasNext) return null;
  return (
    <div ref={ref} className="flex justify-center py-6">
      {loading ? <Spinner label="Loading more" /> : <Button variant="ghost" size="sm" onClick={onLoad}>Load more</Button>}
    </div>
  );
}

export function Feed({ queryKey, path, empty, header }: { queryKey: QueryKey; path: string; empty: ReactNode; header?: ReactNode }) {
  const q = useCursorList<FeedItem>(queryKey, path);
  if (q.isLoading)
    return (
      <div aria-busy="true" aria-label="Loading posts">
        {header}
        {[0, 1, 2, 3].map((i) => (
          <PostSkeleton key={i} />
        ))}
      </div>
    );
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];
  // Defensive client-side dedupe across pages.
  const seen = new Set<string>();
  const unique = items.filter((i) => (seen.has(i.key) ? false : (seen.add(i.key), true)));
  return (
    <div>
      {header}
      {unique.length === 0 ? empty : unique.map((item) => <PostCard key={item.key} item={item} />)}
      <LoadMore hasNext={!!q.hasNextPage} loading={q.isFetchingNextPage} onLoad={() => void q.fetchNextPage()} />
      {!q.hasNextPage && unique.length > 8 ? <p className="py-8 text-center text-sm text-muted">You're all caught up.</p> : null}
    </div>
  );
}
