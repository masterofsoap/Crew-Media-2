import { useEffect, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { TOPICS } from "../../shared/constants";
import type { FeedItem, Page, ProfileSummary, TrendView } from "../../shared/types";
import { get } from "../lib/api";
import { compactNumber } from "../lib/format";
import { Feed, LoadMore } from "../components/Feed";
import { PostCard } from "../components/PostCard";
import { UserRow } from "../components/FollowButton";
import { Icon } from "../components/Icon";
import { EmptyState, ErrorState, PageHeader, PostSkeleton, Skeleton, Spinner, Tabs } from "../components/ui";

const RECENT_KEY = "crew:recent-searches";
function recent(): string[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]") as string[];
  } catch {
    return [];
  }
}
function remember(q: string) {
  const list = [q, ...recent().filter((x) => x !== q)].slice(0, 8);
  localStorage.setItem(RECENT_KEY, JSON.stringify(list));
}

function SearchBox({ initial = "", autoFocus = false }: { initial?: string; autoFocus?: boolean }) {
  const nav = useNavigate();
  const [q, setQ] = useState(initial);
  const [focused, setFocused] = useState(false);
  useEffect(() => setQ(initial), [initial]);
  const recents = recent();
  return (
    <form
      role="search"
      className="relative px-4 py-3"
      onSubmit={(e) => {
        e.preventDefault();
        const v = q.trim();
        if (!v) return;
        remember(v);
        nav(`/search?q=${encodeURIComponent(v)}`);
      }}
    >
      <label className="flex items-center gap-2 rounded-full border divider bg-surface2 px-4 py-2.5 focus-within:border-accent">
        <Icon name="search" size={18} className="text-muted" />
        <input
          value={q}
          autoFocus={autoFocus}
          onFocus={() => setFocused(true)}
          onBlur={() => setTimeout(() => setFocused(false), 150)}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search people, posts, #hashtags, topics"
          aria-label="Search"
          maxLength={100}
          className="w-full bg-transparent outline-none placeholder:text-muted"
        />
      </label>
      {focused && !q && recents.length ? (
        <div className="card absolute inset-x-4 top-16 z-20 py-2">
          <div className="flex items-center justify-between px-4 pb-1">
            <span className="text-sm font-bold">Recent</span>
            <button type="button" className="text-xs text-accent" onClick={() => (localStorage.removeItem(RECENT_KEY), setFocused(false))}>
              Clear
            </button>
          </div>
          {recents.map((r) => (
            <Link key={r} to={`/search?q=${encodeURIComponent(r)}`} className="flex items-center gap-2 px-4 py-2 hover:bg-surface2">
              <Icon name="clock" size={16} className="text-muted" /> {r}
            </Link>
          ))}
        </div>
      ) : null}
    </form>
  );
}

export function Explore() {
  const trends = useQuery({ queryKey: ["trends"], queryFn: () => get<{ platform: TrendView[]; forYou: TrendView[] }>("/trends") });
  const who = useQuery({ queryKey: ["suggestions"], queryFn: () => get<{ items: (ProfileSummary & { bio: string })[] }>("/profiles/suggestions") });
  return (
    <div>
      <PageHeader title="Explore" />
      <SearchBox />
      <section aria-labelledby="topics-h" className="border-b divider px-4 pb-4">
        <h2 id="topics-h" className="mb-3 text-lg font-extrabold">
          Topics
        </h2>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {TOPICS.map((t, i) => (
            <Link
              key={t.slug}
              to={`/topic/${t.slug}`}
              className="card relative overflow-hidden px-3 py-4 font-bold transition-transform hover:-translate-y-0.5"
              style={{ backgroundImage: `linear-gradient(135deg, color-mix(in srgb, var(--c-accent) ${10 + (i % 4) * 6}%, transparent), color-mix(in srgb, var(--c-accent2) ${8 + (i % 3) * 6}%, transparent))` }}
            >
              {t.label}
            </Link>
          ))}
        </div>
      </section>
      <section aria-labelledby="trends-h" className="border-b divider">
        <h2 id="trends-h" className="px-4 pb-1 pt-4 text-lg font-extrabold">
          Trending now
        </h2>
        {trends.isLoading ? (
          <div className="space-y-2 p-4">
            <Skeleton className="h-5 w-1/2" />
            <Skeleton className="h-5 w-1/3" />
          </div>
        ) : trends.isError ? (
          <ErrorState error={trends.error} onRetry={() => void trends.refetch()} />
        ) : trends.data!.platform.length === 0 ? (
          <p className="px-4 pb-4 text-sm text-muted">No trends yet. Trends form when several people discuss the same hashtag.</p>
        ) : (
          <>
            {trends.data!.forYou.length ? (
              <div className="px-4 pb-2 pt-1 text-xs font-semibold uppercase tracking-wide text-muted">Relevant to you: {trends.data!.forYou.map((t) => `#${t.tag}`).join(", ")}</div>
            ) : null}
            <ol>
              {trends.data!.platform.map((t, i) => (
                <li key={t.tag}>
                  <Link to={`/hashtag/${t.tag}`} className="flex items-center gap-4 px-4 py-3 hover:bg-surface2/40">
                    <span className="w-6 text-right text-sm font-bold text-muted">{i + 1}</span>
                    <span className="flex-1">
                      <span className="block font-bold">#{t.tag}</span>
                      <span className="text-xs text-muted">
                        {compactNumber(t.postCount)} posts from {compactNumber(t.authorCount)} people
                      </span>
                    </span>
                  </Link>
                </li>
              ))}
            </ol>
          </>
        )}
      </section>
      <section aria-labelledby="who-h">
        <h2 id="who-h" className="px-4 pb-1 pt-4 text-lg font-extrabold">
          People and accounts to follow
        </h2>
        {(who.data?.items ?? []).map((p) => (
          <UserRow key={p.id} p={p} bio={p.bio} />
        ))}
      </section>
    </div>
  );
}

type SearchType = "top" | "people" | "ai" | "business" | "posts" | "hashtags";

export function SearchPage() {
  const [params, setParams] = useSearchParams();
  const q = params.get("q") ?? "";
  const type = (params.get("type") as SearchType) || "top";
  const top = useQuery({
    queryKey: ["search", q, type],
    enabled: !!q && type !== "posts",
    queryFn: ({ signal }) => get<{ profiles?: (ProfileSummary & { bio: string })[]; posts?: Page<FeedItem>; hashtags?: { tag: string; postCount: number }[]; topics?: { slug: string; label: string }[] }>(`/search?q=${encodeURIComponent(q)}&type=${type}`, signal),
  });
  return (
    <div>
      <PageHeader title="Search" />
      <SearchBox initial={q} autoFocus={!q} />
      <Tabs
        label="Search results"
        value={type}
        onChange={(t) => setParams({ q, type: t }, { replace: true })}
        tabs={[
          { id: "top", label: "Top" },
          { id: "people", label: "People" },
          { id: "ai", label: "AI accounts" },
          { id: "business", label: "Businesses" },
          { id: "posts", label: "Posts" },
          { id: "hashtags", label: "Hashtags" },
        ]}
      />
      {!q ? (
        <EmptyState icon="search" title="Search Crew Plus">
          Find people, AI accounts, businesses, posts and hashtags.
        </EmptyState>
      ) : type === "posts" ? (
        <PostResults q={q} />
      ) : top.isLoading ? (
        <div className="flex justify-center py-10">
          <Spinner label="Searching" />
        </div>
      ) : top.isError ? (
        <ErrorState error={top.error} onRetry={() => void top.refetch()} />
      ) : (
        <div>
          {top.data!.topics?.length ? (
            <div className="flex flex-wrap gap-2 border-b divider px-4 py-3">
              {top.data!.topics.map((t) => (
                <Link key={t.slug} to={`/topic/${t.slug}`} className="chip !px-3 !py-1 !text-sm">
                  {t.label}
                </Link>
              ))}
            </div>
          ) : null}
          {top.data!.hashtags?.length ? (
            <div className="border-b divider">
              {top.data!.hashtags.map((h) => (
                <Link key={h.tag} to={`/hashtag/${h.tag}`} className="flex items-center gap-3 px-4 py-3 hover:bg-surface2/40">
                  <span className="grid h-10 w-10 place-items-center rounded-full bg-surface2">
                    <Icon name="hash" size={18} />
                  </span>
                  <span>
                    <span className="block font-bold">#{h.tag}</span>
                    <span className="text-xs text-muted">{compactNumber(h.postCount)} posts</span>
                  </span>
                </Link>
              ))}
            </div>
          ) : null}
          {top.data!.profiles?.length ? (
            <div className="border-b divider">
              {top.data!.profiles.map((p) => (
                <UserRow key={p.id} p={p} bio={p.bio} />
              ))}
            </div>
          ) : null}
          {top.data!.posts?.items.length ? top.data!.posts.items.map((i) => <PostCard key={i.key} item={i} />) : null}
          {!top.data!.profiles?.length && !top.data!.posts?.items.length && !top.data!.hashtags?.length && !top.data!.topics?.length ? (
            <EmptyState icon="search" title={`No results for “${q}”`}>
              Try different words, or check the spelling.
            </EmptyState>
          ) : null}
        </div>
      )}
    </div>
  );
}

function PostResults({ q }: { q: string }) {
  const [pages, setPages] = useState<FeedItem[][]>([]);
  const [cursor, setCursor] = useState<string | null | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const load = async (c?: string | null) => {
    setLoading(true);
    try {
      const r = await get<{ posts: Page<FeedItem> }>(`/search?q=${encodeURIComponent(q)}&type=posts${c ? `&cursor=${encodeURIComponent(c)}` : ""}`);
      setPages((p) => (c ? [...p, r.posts.items] : [r.posts.items]));
      setCursor(r.posts.cursor);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    setPages([]);
    setCursor(undefined);
    void load(null);
  }, [q]); // eslint-disable-line react-hooks/exhaustive-deps
  if (error) return <ErrorState error={error} onRetry={() => (setError(null), void load(null))} />;
  const items = pages.flat();
  if (loading && !items.length) return <PostSkeleton />;
  if (!items.length) return <EmptyState icon="search" title={`No posts match “${q}”`} />;
  return (
    <>
      {items.map((i) => (
        <PostCard key={i.key} item={i} />
      ))}
      <LoadMore hasNext={!!cursor} loading={loading} onLoad={() => void load(cursor)} />
    </>
  );
}

export function HashtagPage() {
  const { tag = "" } = useParams();
  const nav = useNavigate();
  const info = useQuery({ queryKey: ["hashtag-info", tag], queryFn: () => get<{ tag: string; postCount: number }>(`/hashtags/${encodeURIComponent(tag)}`) });
  return (
    <div>
      <PageHeader title={`#${info.data?.tag ?? tag}`} subtitle={info.data ? `${compactNumber(info.data.postCount)} posts` : undefined} back={() => nav(-1)} />
      <Feed queryKey={["hashtag", tag]} path={`/hashtags/${encodeURIComponent(tag)}`} empty={<EmptyState icon="hash" title={`No posts with #${tag} yet`}>Be the first to use it.</EmptyState>} />
    </div>
  );
}

export function TopicPage() {
  const { slug = "" } = useParams();
  const nav = useNavigate();
  const topic = TOPICS.find((t) => t.slug === slug);
  if (!topic) return <EmptyState icon="explore" title="Unknown topic" />;
  return (
    <div>
      <PageHeader title={topic.label} subtitle="Recent posts on this topic" back={() => nav(-1)} />
      <Feed queryKey={["topic", slug]} path={`/topics/${slug}`} empty={<EmptyState icon="explore" title={`Nothing about ${topic.label} yet`}>Start the conversation.</EmptyState>} />
    </div>
  );
}
