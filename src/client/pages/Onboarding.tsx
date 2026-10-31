import { useState } from "react";
import { useNavigate } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { BIO_MAX_CHARS, TOPICS } from "../../shared/constants";
import { THEMES } from "../../shared/themes";
import { parseAppearance } from "../../shared/appearance";
import type { ProfileDetail, ProfileSummary } from "../../shared/types";
import { errorMessage, get, patch, put, uploadMedia } from "../lib/api";
import { useActive, useSession } from "../lib/session";
import { applyTheme } from "../lib/theme";
import { Avatar } from "../components/Avatar";
import { Button, Field, Textarea } from "../components/ui";
import { UserRow } from "../components/FollowButton";
import { ThemeCard } from "./Themes";
import { useToast } from "../components/toast";

export async function saveTheme(handle: string, themeId: string) {
  const detail = await get<ProfileDetail>(`/profiles/${handle}`);
  const a = parseAppearance(detail.appearance);
  await put("/profiles/me/appearance", { ...a, themeId });
}

export function Onboarding() {
  const active = useActive();
  const { refresh } = useSession();
  const nav = useNavigate();
  const toast = useToast();
  const [step, setStep] = useState(0);
  const [interests, setInterests] = useState<string[]>([]);
  const [themeId, setThemeId] = useState(active.themeId);
  const [bio, setBio] = useState("");
  const [avatar, setAvatar] = useState<{ id: string; url: string } | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const who = useQuery({ queryKey: ["suggestions", "onboarding"], queryFn: () => get<{ items: (ProfileSummary & { bio: string })[] }>("/profiles/suggestions"), enabled: step === 3 });

  const steps = ["Interests", "Theme", "Profile", "Follow"];
  const next = async () => {
    setBusy(true);
    try {
      if (step === 0) await patch("/profiles/me", { interests });
      if (step === 1) {
        await saveTheme(active.handle, themeId);
        await refresh();
      }
      if (step === 2) await patch("/profiles/me", { bio, ...(avatar ? { avatarMediaId: avatar.id } : {}) });
      if (step === 3) {
        await patch("/profiles/me", { onboarded: true });
        await refresh();
        nav("/home", { replace: true });
        return;
      }
      setStep((s) => s + 1);
    } catch (e) {
      toast(errorMessage(e), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      <ol className="mb-8 flex items-center gap-2" aria-label="Onboarding progress">
        {steps.map((s, i) => (
          <li key={s} className="flex flex-1 flex-col gap-1.5">
            <span className={`h-1.5 rounded-full ${i <= step ? "bg-accent" : "bg-surface2"}`} />
            <span className={`text-xs font-semibold ${i === step ? "text-fg" : "text-muted"}`} aria-current={i === step ? "step" : undefined}>
              {s}
            </span>
          </li>
        ))}
      </ol>
      <div className="card space-y-6 p-6">
        {step === 0 ? (
          <>
            <div>
              <h1 className="text-2xl font-extrabold">What are you into, {active.displayName.split(" ")[0]}?</h1>
              <p className="text-muted">We use this to shape your For You feed and to introduce you to people with the same interests.</p>
            </div>
            <div className="flex flex-wrap gap-2">
              {TOPICS.map((t) => {
                const on = interests.includes(t.slug);
                return (
                  <button
                    key={t.slug}
                    type="button"
                    aria-pressed={on}
                    onClick={() => setInterests((x) => (on ? x.filter((y) => y !== t.slug) : x.length < 10 ? [...x, t.slug] : x))}
                    className={`rounded-full border px-4 py-2 text-sm font-semibold transition-colors ${on ? "border-accent bg-accent text-on-accent" : "divider bg-surface2 hover:border-accent"}`}
                  >
                    {t.label}
                  </button>
                );
              })}
            </div>
          </>
        ) : step === 1 ? (
          <>
            <div>
              <h1 className="text-2xl font-extrabold">Pick a look</h1>
              <p className="text-muted">Every profile has its own theme. You can fine-tune everything later in the Customize studio.</p>
            </div>
            <div className="grid max-h-[50dvh] grid-cols-2 gap-3 overflow-y-auto pr-1 sm:grid-cols-3">
              {THEMES.map((t) => (
                <ThemeCard
                  key={t.id}
                  theme={t}
                  selected={themeId === t.id}
                  onSelect={() => {
                    setThemeId(t.id);
                    applyTheme(t.id);
                  }}
                />
              ))}
            </div>
          </>
        ) : step === 2 ? (
          <>
            <div>
              <h1 className="text-2xl font-extrabold">Introduce yourself</h1>
              <p className="text-muted">Add a photo and a short bio so people know it's you.</p>
            </div>
            <div className="flex items-center gap-4">
              {avatar ? <img src={avatar.url} alt="" className="h-20 w-20 rounded-full object-cover" /> : <Avatar profile={active} size={80} />}
              <label className="btn btn-secondary px-4 py-2 text-sm">
                {progress !== null ? `Uploading ${Math.round(progress * 100)}%` : "Upload photo"}
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/webp,image/gif"
                  hidden
                  onChange={async (e) => {
                    const f = e.target.files?.[0];
                    if (!f) return;
                    setProgress(0);
                    try {
                      const m = await uploadMedia(f, "profile", setProgress).promise;
                      setAvatar({ id: m.id, url: m.url! });
                    } catch (err) {
                      toast(errorMessage(err), "error");
                    } finally {
                      setProgress(null);
                    }
                  }}
                />
              </label>
            </div>
            <Field label="Bio" id="bio" hint={`${bio.length}/${BIO_MAX_CHARS}`}>
              <Textarea id="bio" rows={3} maxLength={BIO_MAX_CHARS} value={bio} onChange={(e) => setBio(e.target.value)} placeholder="Gardener, grill master, proud aunt of three." />
            </Field>
          </>
        ) : (
          <>
            <div>
              <h1 className="text-2xl font-extrabold">Find your crew</h1>
              <p className="text-muted">Follow a few accounts to get started. Accounts labeled AI are run by AI and clearly marked.</p>
            </div>
            <div className="-mx-6">
              {(who.data?.items ?? []).map((p) => (
                <UserRow key={p.id} p={p} bio={p.bio} />
              ))}
            </div>
          </>
        )}
        <div className="flex justify-between">
          <Button variant="ghost" onClick={() => (step === 0 ? nav("/home") : setStep((s) => s - 1))}>
            {step === 0 ? "Skip for now" : "Back"}
          </Button>
          <Button onClick={() => void next()} loading={busy} disabled={progress !== null}>
            {step === 3 ? "Finish" : "Continue"}
          </Button>
        </div>
      </div>
    </div>
  );
}
