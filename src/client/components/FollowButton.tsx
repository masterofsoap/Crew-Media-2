import { useState } from "react";
import { Link } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ProfileSummary } from "../../shared/types";
import { del, errorMessage, post } from "../lib/api";
import { useSession } from "../lib/session";
import { Avatar } from "./Avatar";
import { NameLine } from "./RichText";
import { Button } from "./ui";
import { useToast } from "./toast";

export function FollowButton({ profileId, initial, size = "sm", onChange }: { profileId: string; initial: "following" | "requested" | "none"; size?: "sm" | "md"; onChange?: (s: string) => void }) {
  const [state, setState] = useState(initial);
  const [hover, setHover] = useState(false);
  const qc = useQueryClient();
  const toast = useToast();
  const m = useMutation({
    mutationFn: (): Promise<{ state: "following" | "requested" | "none" }> => (state === "none" ? post(`/follows/${profileId}`) : del(`/follows/${profileId}`)),
    onMutate: () => setState((s) => (s === "none" ? "following" : "none")),
    onSuccess: (r) => {
      setState(r.state);
      onChange?.(r.state);
      if (r.state === "requested") toast("Follow request sent");
      void qc.invalidateQueries({ queryKey: ["feed", "following"] });
      void qc.invalidateQueries({ queryKey: ["profile"] });
    },
    onError: (e) => {
      setState(initial);
      toast(errorMessage(e), "error");
    },
  });
  const label = state === "following" ? (hover ? "Unfollow" : "Following") : state === "requested" ? "Requested" : "Follow";
  return (
    <Button
      size={size}
      variant={state === "none" ? "primary" : hover && state === "following" ? "danger" : "secondary"}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={(e) => {
        e.stopPropagation();
        e.preventDefault();
        m.mutate();
      }}
      aria-pressed={state !== "none"}
      className="min-w-[96px]"
    >
      {label}
    </Button>
  );
}

export function UserRow({ p, bio, following }: { p: ProfileSummary; bio?: string; following?: boolean }) {
  const { active } = useSession();
  return (
    <Link to={`/@${p.handle}`} className="flex items-start gap-3 px-4 py-3 transition-colors hover:bg-surface2/40">
      <Avatar profile={p} size={44} />
      <div className="min-w-0 flex-1">
        <NameLine p={p} linked={false} />
        {bio ? <p className="mt-0.5 line-clamp-2 text-sm text-muted">{bio}</p> : null}
      </div>
      {active && active.id !== p.id ? <FollowButton profileId={p.id} initial={following ? "following" : "none"} /> : null}
    </Link>
  );
}
