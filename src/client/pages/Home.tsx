import { Link, useSearchParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import type { ProfileSummary } from "../../shared/types";
import { get } from "../lib/api";
import { Feed } from "../components/Feed";
import { Composer } from "../components/Composer";
import { Button, EmptyState, Tabs } from "../components/ui";
import { UserRow } from "../components/FollowButton";

function FollowSuggestions() {
  const q = useQuery({ queryKey: ["suggestions"], queryFn: () => get<{ items: (ProfileSummary & { bio: string })[] }>("/profiles/suggestions") });
  return (
    <div className="border-b divider">
      <EmptyState icon="users" title="Your Following feed is quiet">
        Follow a few people and accounts to fill it up. Here are some to start with.
      </EmptyState>
      {(q.data?.items ?? []).slice(0, 5).map((p) => (
        <UserRow key={p.id} p={p} bio={p.bio} />
      ))}
      <div className="flex justify-center py-4">
        <Link to="/explore">
          <Button variant="secondary" size="sm" icon="explore">
            Explore more
          </Button>
        </Link>
      </div>
    </div>
  );
}

export function Home() {
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") === "following" ? "following" : "for-you";
  return (
    <div>
      <div className="sticky top-0 z-20 hidden bg-[color-mix(in_srgb,var(--c-bg)_80%,transparent)] backdrop-blur-md md:block">
        <h1 className="sr-only">Home</h1>
        <Tabs
          label="Feed"
          tabs={[
            { id: "for-you", label: "For You" },
            { id: "following", label: "Following" },
          ]}
          value={tab}
          onChange={(v) => setParams(v === "following" ? { tab: "following" } : {}, { replace: true })}
        />
      </div>
      <div className="md:hidden">
        <Tabs
          label="Feed"
          tabs={[
            { id: "for-you", label: "For You" },
            { id: "following", label: "Following" },
          ]}
          value={tab}
          onChange={(v) => setParams(v === "following" ? { tab: "following" } : {}, { replace: true })}
        />
      </div>
      <div className="hidden border-b divider px-4 py-3 md:block">
        <Composer />
      </div>
      {tab === "for-you" ? (
        <Feed queryKey={["feed", "for-you"]} path="/feed/for-you" empty={<EmptyState icon="sparkle" title="Nothing here yet">Post something, or check back soon — the community is warming up.</EmptyState>} />
      ) : (
        <Feed queryKey={["feed", "following"]} path="/feed/following" empty={<FollowSuggestions />} />
      )}
    </div>
  );
}
