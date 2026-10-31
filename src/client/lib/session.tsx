import { createContext, useCallback, useContext, useEffect, useMemo, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { OwnedProfile, SessionInfo } from "../../shared/types";
import { get, post, setActingProfile } from "./api";
import { applyTheme } from "./theme";

interface SessionCtx {
  session: SessionInfo | null;
  loading: boolean;
  active: OwnedProfile | null;
  turnstileSiteKey: string | null;
  setSession: (s: SessionInfo | null) => void;
  refresh: () => Promise<void>;
  switchProfile: (id: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const Ctx = createContext<SessionCtx | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["session"],
    queryFn: () => get<{ session: SessionInfo | null; turnstileSiteKey?: string | null }>("/auth/session"),
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });
  const session = q.data?.session ?? null;
  const active = session?.profiles.find((p) => p.id === session.activeProfileId) ?? null;

  // Keep the API client's acting profile in lockstep with the server-side session.
  useEffect(() => {
    setActingProfile(session?.activeProfileId ?? "");
  }, [session?.activeProfileId]);

  useEffect(() => {
    applyTheme(active?.themeId);
  }, [active?.themeId]);

  const setSession = useCallback(
    (s: SessionInfo | null) => {
      setActingProfile(s?.activeProfileId ?? "");
      qc.setQueryData(["session"], { session: s, turnstileSiteKey: q.data?.turnstileSiteKey ?? s?.turnstileSiteKey ?? null });
    },
    [qc, q.data?.turnstileSiteKey],
  );

  const refresh = useCallback(async () => {
    await qc.invalidateQueries({ queryKey: ["session"] });
  }, [qc]);

  const switchProfile = useCallback(
    async (id: string) => {
      const r = await post<{ session: SessionInfo }>("/auth/switch", { profileId: id });
      setSession(r.session);
      // Everything below the session is profile-specific: drop it so nothing leaks across identities.
      qc.removeQueries({ predicate: (query) => query.queryKey[0] !== "session" });
    },
    [qc, setSession],
  );

  const signOut = useCallback(async () => {
    await post("/auth/logout").catch(() => undefined);
    qc.clear();
    setSession(null);
  }, [qc, setSession]);

  useEffect(() => {
    const onMismatch = () => void refresh();
    const onUnauthorized = () => void refresh();
    window.addEventListener("crew:profile-mismatch", onMismatch);
    window.addEventListener("crew:unauthorized", onUnauthorized);
    return () => {
      window.removeEventListener("crew:profile-mismatch", onMismatch);
      window.removeEventListener("crew:unauthorized", onUnauthorized);
    };
  }, [refresh]);

  const value = useMemo<SessionCtx>(
    () => ({
      session,
      loading: q.isLoading,
      active,
      turnstileSiteKey: q.data?.turnstileSiteKey ?? session?.turnstileSiteKey ?? null,
      setSession,
      refresh,
      switchProfile,
      signOut,
    }),
    [session, q.isLoading, active, q.data?.turnstileSiteKey, setSession, refresh, switchProfile, signOut],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession() {
  const c = useContext(Ctx);
  if (!c) throw new Error("useSession outside provider");
  return c;
}

/** For pages that require auth: the active profile is guaranteed by RequireAuth. */
export function useActive(): OwnedProfile {
  const { active } = useSession();
  if (!active) throw new Error("No active profile");
  return active;
}
