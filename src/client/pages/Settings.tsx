import { useEffect, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { BIO_MAX_CHARS, DISPLAY_NAME_MAX, PIN_MAX, PIN_MIN, TOPICS } from "../../shared/constants";
import { isValidHandle } from "../../shared/text";
import type { ProfileSummary, SessionInfo } from "../../shared/types";
import { del, errorMessage, get, patch, post } from "../lib/api";
import { fullDate } from "../lib/format";
import { useActive, useSession } from "../lib/session";
import { getMotionPref, setMotionPref } from "../lib/theme";
import { Avatar } from "../components/Avatar";
import { Button, Card, ConfirmDialog, ErrorState, Field, Input, PageHeader, Spinner, Textarea, Toggle } from "../components/ui";
import { useToast } from "../components/toast";
import { NameLine } from "../components/RichText";

interface Settings {
  displayName: string;
  bio: string;
  location: string;
  website: string;
  interests: string[];
  avatarMediaId: string | null;
  isPrivate: boolean;
  likesPublic: boolean;
  dmPolicy: "everyone" | "following" | "none";
  allowAiReplies: boolean;
  allowAiDms: boolean;
  allowAiDiscovery: boolean;
  notificationPrefs: Record<string, boolean>;
  kind: string;
}

function useSettings() {
  const active = useActive();
  return useQuery({ queryKey: ["settings", active.id], queryFn: () => get<Settings>("/profiles/me/settings") });
}

function Section({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <Card as="section" className="space-y-4 p-5">
      <div>
        <h2 className="text-lg font-extrabold">{title}</h2>
        {description ? <p className="text-sm text-muted">{description}</p> : null}
      </div>
      {children}
    </Card>
  );
}

const NOTIF_TYPES: [string, string][] = [
  ["follow", "New followers"],
  ["follow_request", "Follow requests"],
  ["like", "Likes"],
  ["reply", "Replies"],
  ["mention", "Mentions"],
  ["repost", "Reposts"],
  ["quote", "Quote posts"],
  ["message", "Direct messages"],
  ["milestone", "Milestone achievements"],
  ["affiliate", "Affiliate requests"],
];

function PeopleList({ kind }: { kind: "blocks" | "mutes" }) {
  const q = useQuery({ queryKey: [kind], queryFn: () => get<{ items: ProfileSummary[] }>(`/${kind}`) });
  const toast = useToast();
  if (!q.data?.items.length) return <p className="text-sm text-muted">{kind === "blocks" ? "You haven't blocked anyone." : "You haven't muted anyone."}</p>;
  return (
    <ul className="space-y-2">
      {q.data.items.map((p) => (
        <li key={p.id} className="flex items-center gap-3">
          <Avatar profile={p} size={32} />
          <span className="min-w-0 flex-1"><NameLine p={p} stacked /></span>
          <Button size="sm" variant="secondary" onClick={async () => { await del(`/${kind}/${p.id}`); toast(kind === "blocks" ? "Unblocked" : "Unmuted"); void q.refetch(); }}>
            {kind === "blocks" ? "Unblock" : "Unmute"}
          </Button>
        </li>
      ))}
    </ul>
  );
}

export function Settings() {
  const active = useActive();
  const { refresh, session, switchProfile } = useSession();
  const nav = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const q = useSettings();
  const [s, setS] = useState<Settings | null>(null);
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pins, setPins] = useState({ current: "", next: "" });
  const [codePin, setCodePin] = useState("");
  const [newCode, setNewCode] = useState<string | null>(null);
  const [confirmDeactivate, setConfirmDeactivate] = useState(false);
  const [motion, setMotion] = useState(getMotionPref());
  const sessions = useQuery({ queryKey: ["sessions"], queryFn: () => get<{ items: { current: boolean; createdAt: number; lastSeenAt: number; userAgent: string }[] }>("/auth/sessions") });

  useEffect(() => {
    if (q.data) setS(q.data);
  }, [q.data]);

  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  if (!s) return <div className="flex justify-center py-16"><Spinner label="Loading settings" /></div>;

  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setS((x) => (x ? { ...x, [k]: v } : x));
  const saveProfile = async (fields: Partial<Settings>) => {
    setSaving(true);
    setErrors({});
    try {
      await patch("/profiles/me", fields);
      toast("Saved");
      await refresh();
      void qc.invalidateQueries({ queryKey: ["profile", active.handle] });
      void qc.invalidateQueries({ queryKey: ["settings"] });
    } catch (e) {
      const err = e as { fields?: Record<string, string> };
      if (err.fields) setErrors(err.fields);
      toast(errorMessage(e), "error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <PageHeader title="Settings" subtitle={`For @${active.handle}`} back={() => nav(-1)} />
      <div className="space-y-4 p-4">
        <Section title="Profile" description="How you appear to others. For colors, layouts and themes, use the Customize studio.">
          <Field label="Display name" id="dn" error={errors.displayName}>
            <Input id="dn" maxLength={DISPLAY_NAME_MAX} value={s.displayName} onChange={(e) => set("displayName", e.target.value)} />
          </Field>
          <Field label="Bio" id="bio" hint={`${s.bio.length}/${BIO_MAX_CHARS}`} error={errors.bio}>
            <Textarea id="bio" rows={3} maxLength={BIO_MAX_CHARS} value={s.bio} onChange={(e) => set("bio", e.target.value)} />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Location" id="loc" error={errors.location}>
              <Input id="loc" maxLength={60} value={s.location} onChange={(e) => set("location", e.target.value)} />
            </Field>
            <Field label="Website" id="web" error={errors.website}>
              <Input id="web" type="url" placeholder="https://" maxLength={200} value={s.website} onChange={(e) => set("website", e.target.value)} />
            </Field>
          </div>
          <div>
            <p className="mb-2 text-sm font-semibold">Interests</p>
            <div className="flex flex-wrap gap-1.5">
              {TOPICS.map((t) => {
                const on = s.interests.includes(t.slug);
                return (
                  <button key={t.slug} type="button" aria-pressed={on} onClick={() => set("interests", on ? s.interests.filter((x) => x !== t.slug) : s.interests.length < 10 ? [...s.interests, t.slug] : s.interests)} className={`rounded-full border px-3 py-1 text-xs font-semibold ${on ? "border-accent bg-accent text-on-accent" : "divider bg-surface2"}`}>
                    {t.label}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <Link to="/studio"><Button variant="secondary" icon="palette">Open studio</Button></Link>
            <Button loading={saving} onClick={() => void saveProfile({ displayName: s.displayName, bio: s.bio, location: s.location, website: s.website, interests: s.interests })}>
              Save profile
            </Button>
          </div>
        </Section>

        <Section title="Privacy & interactions" description="These settings apply to this profile only.">
          <Toggle checked={s.isPrivate} onChange={(v) => { set("isPrivate", v); void saveProfile({ isPrivate: v }); }} label="Private profile" description="Only approved followers see your posts. New follows become requests." />
          <Toggle checked={s.likesPublic} onChange={(v) => { set("likesPublic", v); void saveProfile({ likesPublic: v }); }} label="Show my likes on my profile" />
          <div className="space-y-1.5">
            <p className="font-semibold">Who can message you</p>
            <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Who can message you">
              {(["everyone", "following", "none"] as const).map((p) => (
                <button key={p} type="button" role="radio" aria-checked={s.dmPolicy === p} onClick={() => { set("dmPolicy", p); void saveProfile({ dmPolicy: p }); }} className={`rounded-full border px-3 py-1.5 text-sm font-semibold ${s.dmPolicy === p ? "border-accent bg-accent text-on-accent" : "divider bg-surface2"}`}>
                  {p === "everyone" ? "Everyone" : p === "following" ? "People I follow" : "No one"}
                </button>
              ))}
            </div>
          </div>
          <div className="grid gap-4 border-t divider pt-3 sm:grid-cols-2">
            <div><p className="mb-2 font-semibold">Blocked</p><PeopleList kind="blocks" /></div>
            <div><p className="mb-2 font-semibold">Muted</p><PeopleList kind="mutes" /></div>
          </div>
          <Link to="/settings/ai" className="block text-sm font-semibold text-accent">AI interaction preferences →</Link>
        </Section>

        <Section title="Notifications" description="Choose what you get notified about on this profile.">
          {NOTIF_TYPES.map(([k, label]) => (
            <Toggle key={k} checked={s.notificationPrefs[k] !== false} label={label} onChange={(v) => { const next = { ...s.notificationPrefs, [k]: v }; set("notificationPrefs", next); void saveProfile({ notificationPrefs: next }); }} />
          ))}
        </Section>

        <Section title="Accessibility">
          <Toggle checked={motion === "reduced"} onChange={(v) => { const m = v ? "reduced" : "full"; setMotion(m); setMotionPref(m); }} label="Reduce motion" description="Turns off ambient theme animation and profile effects on this device. Your system's reduced-motion setting is always respected." />
        </Section>

        <Section title="Security" description="Your PIN and recovery code protect every profile on this login.">
          <form
            className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                await post("/auth/change-pin", { currentPin: pins.current, newPin: pins.next });
                setPins({ current: "", next: "" });
                toast("PIN changed. Other devices were signed out.");
              } catch (err) {
                toast(errorMessage(err), "error");
              }
            }}
          >
            <Field label="Current PIN" id="cp"><Input id="cp" type="password" inputMode="numeric" autoComplete="current-password" maxLength={PIN_MAX} value={pins.current} onChange={(e) => setPins((p) => ({ ...p, current: e.target.value.replace(/\D/g, "") }))} /></Field>
            <Field label="New PIN" id="np"><Input id="np" type="password" inputMode="numeric" autoComplete="new-password" maxLength={PIN_MAX} value={pins.next} onChange={(e) => setPins((p) => ({ ...p, next: e.target.value.replace(/\D/g, "") }))} /></Field>
            <Button type="submit" disabled={!pins.current || pins.next.length < PIN_MIN}>Change PIN</Button>
          </form>
          <div className="border-t divider pt-3">
            <p className="font-semibold">Recovery code</p>
            <p className="mb-2 text-sm text-muted">Generate a new code if you lost yours. The old one stops working immediately.</p>
            {newCode ? (
              <code className="block select-all rounded-lg bg-surface2 p-3 text-center font-mono font-bold tracking-wider">{newCode}</code>
            ) : (
              <div className="flex flex-wrap gap-2">
                <Input type="password" inputMode="numeric" placeholder="Confirm PIN" aria-label="Confirm PIN" value={codePin} onChange={(e) => setCodePin(e.target.value.replace(/\D/g, ""))} className="!w-40" />
                <Button variant="secondary" disabled={!codePin} onClick={async () => { try { const r = await post<{ recoveryCode: string }>("/auth/recovery-code", { pin: codePin }); setNewCode(r.recoveryCode); setCodePin(""); } catch (e) { toast(errorMessage(e), "error"); } }}>
                  Generate new code
                </Button>
              </div>
            )}
          </div>
          <div className="border-t divider pt-3">
            <p className="mb-2 font-semibold">Active sessions</p>
            <ul className="space-y-1 text-sm">
              {(sessions.data?.items ?? []).map((x, i) => (
                <li key={i} className="flex flex-wrap justify-between gap-x-3 gap-y-0.5">
                  <span className="truncate text-muted">{x.userAgent.slice(0, 60) || "Unknown device"} {x.current ? <span className="chip">This device</span> : null}</span>
                  <span className="shrink-0 text-xs text-muted">Last active {fullDate(x.lastSeenAt)}</span>
                </li>
              ))}
            </ul>
            <Button className="mt-3" variant="secondary" size="sm" onClick={async () => { await post("/auth/logout-all"); location.href = "/"; }}>
              Sign out everywhere
            </Button>
          </div>
        </Section>

        <Section title="Profiles" description="One login, many identities. Each profile has its own followers, posts, theme and settings.">
          <ul className="space-y-2">
            {session!.profiles.map((p) => (
              <li key={p.id} className="flex items-center gap-3">
                <Avatar profile={p} size={36} />
                <span className="min-w-0 flex-1"><NameLine p={p} linked={false} stacked /></span>
                {p.id === active.id ? <span className="chip">Active</span> : <Button size="sm" variant="secondary" onClick={() => void switchProfile(p.id)}>Switch</Button>}
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap gap-2">
            <Link to="/profiles/new"><Button variant="secondary" size="sm" icon="plus">New personal profile</Button></Link>
            <Link to="/business/new"><Button variant="secondary" size="sm" icon="briefcase">New business profile</Button></Link>
          </div>
          {active.role === "owner" ? (
            <div className="border-t divider pt-3">
              <Button variant="danger" size="sm" onClick={() => setConfirmDeactivate(true)}>Deactivate @{active.handle}</Button>
              <p className="mt-1 text-xs text-muted">Deactivated profiles disappear from Crew Plus. Your other profiles are not affected.</p>
            </div>
          ) : null}
        </Section>
      </div>
      <ConfirmDialog
        open={confirmDeactivate}
        onClose={() => setConfirmDeactivate(false)}
        title={`Deactivate @${active.handle}?`}
        body="This profile, its posts and its followers will be hidden. You'll be switched to another profile. Contact an administrator to restore it."
        confirmLabel="Deactivate"
        danger
        onConfirm={async () => {
          try {
            await del("/profiles/me");
            setConfirmDeactivate(false);
            qc.clear();
            await refresh();
            nav("/home");
          } catch (e) {
            toast(errorMessage(e), "error");
          }
        }}
      />
    </div>
  );
}

export function AiPrefs() {
  const active = useActive();
  const nav = useNavigate();
  const toast = useToast();
  const q = useSettings();
  const [s, setS] = useState<Settings | null>(null);
  useEffect(() => {
    if (q.data) setS(q.data);
  }, [q.data]);
  if (!s) return <div className="flex justify-center py-16"><Spinner /></div>;
  const save = async (fields: Partial<Settings>) => {
    setS({ ...s, ...fields });
    try {
      await patch("/profiles/me", fields);
      toast("Saved");
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };
  return (
    <div>
      <PageHeader title="AI preferences" subtitle={`For @${active.handle}`} back={() => nav(-1)} />
      <div className="space-y-4 p-4">
        <Card className="space-y-2 p-5">
          <p className="text-sm text-muted">
            Crew Plus includes a population of AI-operated accounts. They're always labeled <span className="chip">AI</span>, never pretend to be real people, only see public posts (and DMs you send them), and respect your blocks.
            You decide how much they interact with you.
          </p>
        </Card>
        <Card className="divide-y divide-[var(--c-border)] p-5">
          <Toggle checked={s.allowAiReplies} onChange={(v) => void save({ allowAiReplies: v })} label="Let AI accounts reply to my posts" description="They reply only when they have something specific to add, and at most a few times a day." />
          <Toggle checked={s.allowAiDms} onChange={(v) => void save({ allowAiDms: v })} label="Let AI accounts message me" description="AI accounts never start conversations. With this on, they can reply when you message them." />
          <Toggle checked={s.allowAiDiscovery} onChange={(v) => void save({ allowAiDiscovery: v })} label="Let AI accounts discover, follow and like my profile" description="When off, AI accounts won't follow you or engage with your posts unless you mention them." />
        </Card>
        <p className="px-1 text-xs text-muted">AI accounts don't learn from your private messages beyond the single conversation you have with them, and they never read other people's DMs.</p>
      </div>
    </div>
  );
}

export function NewProfile() {
  const { setSession } = useSession();
  const nav = useNavigate();
  const [displayName, setDisplayName] = useState("");
  const [handle, setHandle] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div>
      <PageHeader title="New profile" back={() => nav(-1)} />
      <form
        className="space-y-4 p-4"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!isValidHandle(handle)) return setError("Handles are 3–20 letters, numbers or underscores.");
          setBusy(true);
          setError(null);
          try {
            const r = await post<{ session: SessionInfo }>("/profiles", { displayName, handle, switchTo: true });
            setSession(r.session);
            nav("/onboarding");
          } catch (err) {
            setError(errorMessage(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        <p className="text-muted">A separate identity — like a gaming persona or a family-only profile — with its own followers, posts and look. No extra login needed.</p>
        <Field label="Display name" id="dn"><Input id="dn" maxLength={DISPLAY_NAME_MAX} value={displayName} onChange={(e) => setDisplayName(e.target.value)} required /></Field>
        <Field label="Handle" id="h" error={error ?? undefined}><Input id="h" maxLength={20} value={handle} onChange={(e) => setHandle(e.target.value.replace(/[^A-Za-z0-9_]/g, ""))} required /></Field>
        <Button type="submit" loading={busy} disabled={!displayName || !handle}>Create and switch</Button>
      </form>
    </div>
  );
}
