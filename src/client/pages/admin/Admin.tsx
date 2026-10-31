import { useEffect, useState, type ReactNode } from "react";
import { Link, NavLink, Outlet, useNavigate, useParams } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { PostView, ProfileSummary } from "../../../shared/types";
import { ApiError, del, errorMessage, get, patch, post } from "../../lib/api";
import { bytes, compactNumber, fullDate, timeAgo } from "../../lib/format";
import { useSession } from "../../lib/session";
import { Avatar } from "../../components/Avatar";
import { NameLine } from "../../components/RichText";
import { Button, Card, ConfirmDialog, EmptyState, ErrorState, Field, Input, PageHeader, Slider, Spinner } from "../../components/ui";
import { useToast } from "../../components/toast";
import { Icon } from "../../components/Icon";

/** Run an admin mutation with a friendly message when step-up elevation is required. */
export function useAdminAction() {
  const toast = useToast();
  const { refresh } = useSession();
  return async (fn: () => Promise<unknown>, ok: string) => {
    try {
      const r = await fn();
      toast(ok);
      return r;
    } catch (e) {
      if (e instanceof ApiError && e.code === "ELEVATION_REQUIRED") {
        toast("Confirm your admin passphrase (top of the page) to continue.", "error");
        await refresh();
      } else toast(errorMessage(e), "error");
      return undefined;
    }
  };
}

function Bootstrap() {
  const toast = useToast();
  const { refresh } = useSession();
  const [f, setF] = useState({ token: "", passphrase: "", pin: "" });
  const [busy, setBusy] = useState(false);
  return (
    <div className="mx-auto max-w-md p-6">
      <Card className="space-y-4 p-6">
        <h1 className="text-xl font-extrabold">Administrator setup</h1>
        <p className="text-sm text-muted">
          The first owner is created with the <code>BOOTSTRAP_OWNER_TOKEN</code> deployment secret. This only works while no owner exists. If an owner exists, ask them to grant you a role.
        </p>
        <form
          className="space-y-3"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            try {
              await post("/admin/bootstrap", f);
              toast("You are now the owner.");
              await refresh();
            } catch (err) {
              toast(errorMessage(err), "error");
            } finally {
              setBusy(false);
            }
          }}
        >
          <Field label="Bootstrap token" id="bt"><Input id="bt" type="password" value={f.token} onChange={(e) => setF({ ...f, token: e.target.value })} /></Field>
          <Field label="Admin passphrase" id="bp" hint="At least 12 characters. Separate from your PIN; required for sensitive actions."><Input id="bp" type="password" autoComplete="new-password" value={f.passphrase} onChange={(e) => setF({ ...f, passphrase: e.target.value })} /></Field>
          <Field label="Your PIN" id="bpin"><Input id="bpin" type="password" inputMode="numeric" value={f.pin} onChange={(e) => setF({ ...f, pin: e.target.value.replace(/\D/g, "") })} /></Field>
          <Button type="submit" loading={busy} className="w-full">Claim owner role</Button>
        </form>
      </Card>
    </div>
  );
}

function ElevationBar() {
  const { session, refresh } = useSession();
  const toast = useToast();
  const [pass, setPass] = useState("");
  const [pin, setPin] = useState("");
  const admin = session!.admin!;
  if (admin.elevated) return <div className="flex items-center gap-2 border-b divider bg-[color-mix(in_srgb,var(--c-success)_12%,transparent)] px-4 py-2 text-sm"><Icon name="check" size={16} className="text-success" /> Admin actions unlocked for 15 minutes.</div>;
  if (!admin.hasPassphrase)
    return (
      <form className="flex flex-wrap items-center gap-2 border-b divider bg-surface2 px-4 py-3 text-sm" onSubmit={async (e) => { e.preventDefault(); try { await post("/admin/passphrase", { pin, passphrase: pass }); await post("/admin/elevate", { passphrase: pass }); setPass(""); setPin(""); await refresh(); toast("Passphrase set"); } catch (err) { toast(errorMessage(err), "error"); } }}>
        <span className="font-semibold">Set your admin passphrase to unlock admin actions:</span>
        <Input type="password" inputMode="numeric" placeholder="PIN" aria-label="PIN" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))} className="!w-28" />
        <Input type="password" placeholder="New passphrase (12+ chars)" aria-label="New passphrase" value={pass} onChange={(e) => setPass(e.target.value)} className="!w-64" />
        <Button size="sm" type="submit">Save</Button>
      </form>
    );
  return (
    <form className="flex flex-wrap items-center gap-2 border-b divider bg-surface2 px-4 py-3 text-sm" onSubmit={async (e) => { e.preventDefault(); try { await post("/admin/elevate", { passphrase: pass }); setPass(""); await refresh(); } catch (err) { toast(errorMessage(err), "error"); } }}>
      <Icon name="lock" size={16} />
      <span className="font-semibold">Read-only.</span> Enter your admin passphrase to unlock changes:
      <Input type="password" aria-label="Admin passphrase" value={pass} onChange={(e) => setPass(e.target.value)} className="!w-64" />
      <Button size="sm" type="submit">Unlock</Button>
    </form>
  );
}

export function AdminShell() {
  const { session } = useSession();
  if (!session?.admin) return <Bootstrap />;
  const links = [
    ["", "Dashboard", "activity"], ["accounts", "Accounts", "users"], ["admins", "Administrators", "shield"], ["ai", "AI operations", "sparkle"],
    ["media", "Media expiry", "clock"], ["reports", "Moderation", "flag"], ["logs", "Audit & errors", "book"],
  ] as const;
  return (
    <div>
      <header className="border-b divider px-4 pt-3">
        <h1 className="text-xl font-extrabold">Administration <span className="chip ml-1 capitalize">{session.admin.role}</span></h1>
        <nav className="mt-2 flex gap-1 overflow-x-auto scrollbar-none" aria-label="Admin sections">
          {links.map(([to, label, icon]) => (
            <NavLink key={to} to={`/admin${to ? `/${to}` : ""}`} end={!to} className={({ isActive }) => `flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-semibold ${isActive ? "border-accent text-fg" : "border-transparent text-muted"}`}>
              <Icon name={icon} size={16} /> {label}
            </NavLink>
          ))}
        </nav>
      </header>
      <ElevationBar />
      <div className="p-4"><Outlet /></div>
    </div>
  );
}

export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <Card className="p-4">
      <p className="heading text-2xl font-extrabold">{value}</p>
      <p className="text-xs text-muted">{label}</p>
      {hint ? <p className="mt-1 text-[11px] text-muted">{hint}</p> : null}
    </Card>
  );
}

interface DashboardData {
  counts: Record<string, number>;
  recentRegistrations: (ProfileSummary & { createdAt: number })[];
  recentPosts: PostView[];
  jobs: { queue: string; status: string; n: number }[];
  aiUsageToday: { model: string; task: string; calls: number; errors: number; input_tokens: number; output_tokens: number }[];
  aiBudget: { dailyCallBudget: number; dailyTokenBudget: number; paused: boolean };
  media: Record<string, number>;
  openReports: number;
  errors24h: number;
  audit: { id: string; action: string; target_type: string; target_id: string; created_at: number }[];
  storageNote: string;
}

export function AdminDashboard() {
  const q = useQuery({ queryKey: ["admin", "dashboard"], queryFn: () => get<DashboardData>("/admin/dashboard"), refetchInterval: 30_000 });
  const act = useAdminAction();
  if (q.isLoading) return <Spinner label="Loading" />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const d = q.data!;
  const c = d.counts;
  const calls = d.aiUsageToday.reduce((s, u) => s + u.calls, 0);
  const tokens = d.aiUsageToday.reduce((s, u) => s + u.input_tokens + u.output_tokens, 0);
  const modelErrors = d.aiUsageToday.reduce((s, u) => s + u.errors, 0);
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Logins (identities)" value={compactNumber(c.identities ?? 0)} />
        <Stat label="Personal profiles" value={compactNumber(c.personal ?? 0)} />
        <Stat label="Business profiles" value={compactNumber(c.business ?? 0)} />
        <Stat label="AI personas / audience" value={`${compactNumber(c.ai_personas ?? 0)} / ${compactNumber(c.ai_audience ?? 0)}`} />
        <Stat label="AI personas enabled" value={compactNumber(c.ai_enabled ?? 0)} hint={`${c.ai_active_24h ?? 0} active in 24h`} />
        <Stat label="Posts (24h)" value={compactNumber(c.posts_24h ?? 0)} hint={`${c.ai_posts_24h ?? 0} AI-generated`} />
        <Stat label="Messages (24h)" value={compactNumber(c.messages_24h ?? 0)} />
        <Stat label="Open reports" value={d.openReports} />
        <Stat label="AI calls today" value={`${calls} / ${d.aiBudget.dailyCallBudget}`} hint={d.aiBudget.paused ? "AI is PAUSED" : undefined} />
        <Stat label="AI tokens today" value={`${compactNumber(tokens)} / ${compactNumber(d.aiBudget.dailyTokenBudget)}`} />
        <Stat label="Model errors today" value={modelErrors} />
        <Stat label="Operational errors (24h)" value={d.errors24h} />
        <Stat label="Media awaiting expiry" value={compactNumber(d.media.active_expiring ?? 0)} hint={`${d.media.overdue ?? 0} overdue · ${d.media.in_cleanup ?? 0} in cleanup · ${d.media.failed ?? 0} failed`} />
        <Stat label="Active media storage" value={bytes(d.media.bytes_ready ?? 0)} hint={d.storageNote} />
      </div>
      <Card className="p-4">
        <h2 className="mb-2 font-extrabold">Queues (24h)</h2>
        {d.jobs.length ? (
          <div className="flex flex-wrap gap-2 text-sm">{d.jobs.map((j) => <span key={`${j.queue}${j.status}`} className="chip">{j.queue}: {j.status} {j.n}</span>)}</div>
        ) : <p className="text-sm text-muted">No queue activity recorded in the last 24 hours.</p>}
      </Card>
      <Card className="space-y-2 p-4">
        <h2 className="font-extrabold">Safe maintenance actions</h2>
        <p className="text-sm text-muted">These run the same jobs as the scheduled cron triggers. Requires elevation.</p>
        <div className="flex flex-wrap gap-2">
          {(["media-cleanup", "trends", "growth", "reconcile", "ai-tick", "prune"] as const).map((t) => (
            <Button key={t} size="sm" variant="secondary" onClick={() => void act(() => post(`/admin/maintenance/${t}`), `Ran ${t}`).then(() => q.refetch())}>Run {t}</Button>
          ))}
        </div>
      </Card>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="p-4">
          <h2 className="mb-2 font-extrabold">Recent registrations</h2>
          <ul className="space-y-2">
            {d.recentRegistrations.map((p) => (
              <li key={p.id}><Link to={`/admin/accounts/${p.id}`} className="flex items-center gap-2 hover:underline"><Avatar profile={p} size={28} /><NameLine p={p} linked={false} size="sm" /><span className="ml-auto text-xs text-muted">{timeAgo(p.createdAt)}</span></Link></li>
            ))}
          </ul>
        </Card>
        <Card className="p-4">
          <h2 className="mb-2 font-extrabold">Recent posts</h2>
          <ul className="space-y-2 text-sm">
            {d.recentPosts.map((p) => (
              <li key={p.id}><Link to={`/post/${p.id}`} className="hover:underline"><b>@{p.author.handle}</b> <span className="text-muted">{p.text.slice(0, 90)}</span></Link></li>
            ))}
          </ul>
        </Card>
      </div>
      <Card className="p-4">
        <h2 className="mb-2 font-extrabold">Recent admin activity</h2>
        {d.audit.length ? (
          <ul className="space-y-1 text-sm">{d.audit.map((x) => <li key={x.id}><span className="font-mono">{x.action}</span> <span className="text-muted">{x.target_type}:{x.target_id} · {fullDate(x.created_at)}</span></li>)}</ul>
        ) : <p className="text-sm text-muted">No administrative changes yet.</p>}
      </Card>
    </div>
  );
}

export function AdminAccounts() {
  const [q, setQ] = useState("");
  const [kind, setKind] = useState("all");
  const r = useQuery({ queryKey: ["admin", "accounts", q, kind], queryFn: () => get<{ items: (ProfileSummary & { status: string; visibility: number; followerCount: number; createdAt: number })[] }>(`/admin/accounts?q=${encodeURIComponent(q)}&kind=${kind}`) });
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search handle or name" aria-label="Search accounts" className="!w-72" />
        <select className="input !w-40" value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Account type">
          {["all", "personal", "business", "ai", "audience"].map((k) => <option key={k} value={k}>{k}</option>)}
        </select>
      </div>
      {r.isError ? <ErrorState error={r.error} /> : null}
      <Card className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase text-muted"><tr><th className="p-3">Profile</th><th>Status</th><th>Visibility</th><th>Followers</th><th>Joined</th></tr></thead>
          <tbody>
            {(r.data?.items ?? []).map((p) => (
              <tr key={p.id} className="border-t divider hover:bg-surface2/40">
                <td className="p-3"><Link to={`/admin/accounts/${p.id}`} className="flex items-center gap-2"><Avatar profile={p} size={28} /><NameLine p={p} linked={false} size="sm" /></Link></td>
                <td><span className={`chip ${p.status !== "active" ? "!text-danger" : ""}`}>{p.status}</span></td>
                <td className="tabular-nums">{p.visibility}</td>
                <td className="tabular-nums">{compactNumber(p.followerCount)}</td>
                <td className="text-muted">{timeAgo(p.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {r.isSuccess && !r.data.items.length ? <EmptyState icon="users" title="No accounts match" /> : null}
      </Card>
    </div>
  );
}

interface AccountDetail {
  profile: ProfileSummary & { status: string; visibility: number; followerCount: number; followingCount: number; postCount: number; createdAt: number; bio: string; aiPrefs: Record<string, boolean> };
  identity: { id: string; status: string; createdAt: number; lastLoginAt: number | null; failedAttempts: number; lockedUntil: number; adminRole: string | null } | null;
  profiles: ProfileSummary[];
  scores: Record<string, number> | null;
  reports: { id: string; reason: string; status: string; created_at: number }[];
  recentPosts: { id: string; text: string; created_at: number; deleted_at: number | null; moderation_status: string; ai_generated: number }[];
  agent: { archetype: string; activity_level: string; enabled: number; state: string; last_active_at: number | null; actions_today: number } | null;
  milestones: { level: number; achieved_at: number }[];
}

function visibilityLabel(v: number) {
  if (v <= 10) return "Lowest discovery exposure";
  if (v < 40) return "Below-normal discovery";
  if (v <= 60) return "Default discovery";
  if (v < 90) return "Above-normal discovery";
  return "Highest discovery exposure";
}

export function AdminAccountDetail() {
  const { id = "" } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const act = useAdminAction();
  const q = useQuery({ queryKey: ["admin", "account", id], queryFn: () => get<AccountDetail>(`/admin/accounts/${id}`) });
  const [vis, setVis] = useState(50);
  const [code, setCode] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<null | "suspend" | "identity">(null);
  useEffect(() => {
    if (q.data) setVis(q.data.profile.visibility);
  }, [q.data]);
  if (q.isLoading) return <Spinner />;
  if (q.isError) return <ErrorState error={q.error} />;
  const d = q.data!;
  const p = d.profile;
  const reload = () => void qc.invalidateQueries({ queryKey: ["admin", "account", id] });
  return (
    <div className="space-y-4">
      <PageHeader title={p.displayName} subtitle={`@${p.handle} · ${p.kind}${p.aiClass ? ` (${p.aiClass})` : ""}`} back={() => nav("/admin/accounts")} actions={<Link to={`/@${p.handle}`}><Button size="sm" variant="secondary">View profile</Button></Link>} />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Status" value={p.status} />
        <Stat label="Followers" value={compactNumber(p.followerCount)} />
        <Stat label="Posts" value={compactNumber(p.postCount)} />
        <Stat label="Milestones" value={d.milestones.length} />
      </div>
      <Card className="space-y-3 p-5">
        <h2 className="text-lg font-extrabold">Discovery visibility</h2>
        <Slider label={`Visibility — ${visibilityLabel(vis)}`} value={vis} min={0} max={100} onChange={setVis} />
        <p className="text-xs text-muted">
          Adjusts how strongly this profile is weighted in For You ranking, search ordering, suggestions and AI discovery (a bounded multiplier from 0.25× at 0 to 1.75× at 100; 50 = 1.0×). It never overrides privacy, blocks, message restrictions or moderation, never hides content from direct profile visits, and doesn't guarantee followers, likes or milestones. Changes are audited.
        </p>
        <div className="flex gap-2">
          <Button disabled={vis === p.visibility} onClick={() => void act(() => patch(`/admin/accounts/${id}/visibility`, { value: vis }), "Visibility updated").then(reload)}>Save visibility</Button>
          <Button variant="ghost" onClick={() => setVis(50)}>Reset to 50</Button>
        </div>
      </Card>
      <Card className="space-y-3 p-5">
        <h2 className="text-lg font-extrabold">Account controls</h2>
        <div className="flex flex-wrap gap-2">
          <Button variant={p.status === "active" ? "danger" : "primary"} size="sm" onClick={() => (p.status === "active" ? setConfirm("suspend") : void act(() => post(`/admin/accounts/${id}/status`, { status: "active" }), "Profile reactivated").then(reload))}>
            {p.status === "active" ? "Suspend profile" : "Reactivate profile"}
          </Button>
          {d.identity ? (
            <>
              <Button size="sm" variant="secondary" onClick={() => (d.identity!.status === "active" ? setConfirm("identity") : void act(() => post(`/admin/identities/${d.identity!.id}/status`, { status: "active" }), "Login restored").then(reload))}>
                {d.identity.status === "active" ? "Suspend login (all profiles)" : "Restore login"}
              </Button>
              <Button size="sm" variant="secondary" onClick={async () => { const r = (await act(() => post<{ code: string }>(`/admin/identities/${d.identity!.id}/recovery-token`), "Reset code issued")) as { code: string } | undefined; if (r) setCode(r.code); }}>
                Issue one-time PIN reset code
              </Button>
            </>
          ) : null}
          {d.agent ? (
            <Button size="sm" variant="secondary" onClick={() => void act(() => patch(`/admin/ai/agents/${id}`, { enabled: !d.agent!.enabled }), d.agent!.enabled ? "AI account disabled" : "AI account enabled").then(reload)}>
              {d.agent.enabled ? "Disable AI account" : "Enable AI account"}
            </Button>
          ) : null}
        </div>
        {code ? (
          <div className="rounded-xl bg-surface2 p-3 text-sm">
            <p className="mb-1 font-semibold">One-time reset code (valid 24h, shown once):</p>
            <code className="block select-all text-center font-mono text-lg font-bold">{code}</code>
            <p className="mt-1 text-xs text-muted">Only give this to the account holder after verifying their identity in person or through a trusted channel. They use it at /recover.</p>
          </div>
        ) : null}
      </Card>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="space-y-1 p-5 text-sm">
          <h2 className="mb-1 text-lg font-extrabold">Login identity</h2>
          {d.identity ? (
            <>
              <p>Status: <b>{d.identity.status}</b>{d.identity.adminRole ? <span className="chip ml-2">{d.identity.adminRole}</span> : null}</p>
              <p>Created: {fullDate(d.identity.createdAt)}</p>
              <p>Last sign-in: {d.identity.lastLoginAt ? fullDate(d.identity.lastLoginAt) : "—"}</p>
              <p>Failed attempts: {d.identity.failedAttempts}{d.identity.lockedUntil > Date.now() ? ` · locked until ${fullDate(d.identity.lockedUntil)}` : ""}</p>
              <p className="pt-2 font-semibold">Profiles on this login</p>
              <ul>{d.profiles.map((x) => <li key={x.id}><Link to={`/admin/accounts/${x.id}`} className="text-accent">@{x.handle}</Link> <span className="text-muted">({x.kind})</span></li>)}</ul>
            </>
          ) : <p className="text-muted">AI account — no login identity.</p>}
        </Card>
        <Card className="space-y-1 p-5 text-sm">
          <h2 className="mb-1 text-lg font-extrabold">Growth signals</h2>
          {d.scores ? Object.entries(d.scores).filter(([k]) => k !== "updated_at").map(([k, v]) => <p key={k}>{k.replace(/_/g, " ")}: <b>{typeof v === "number" ? v.toFixed(3) : v}</b></p>) : <p className="text-muted">Not computed yet.</p>}
          <p className="pt-2 text-muted">AI preferences: replies {p.aiPrefs.replies ? "on" : "off"}, DMs {p.aiPrefs.dms ? "on" : "off"}, discovery {p.aiPrefs.discovery ? "on" : "off"}</p>
          {d.agent ? <p className="text-muted">Agent: {d.agent.archetype} · {d.agent.activity_level} · {d.agent.state} · {d.agent.actions_today} actions today</p> : null}
        </Card>
      </div>
      <Card className="p-5">
        <h2 className="mb-2 text-lg font-extrabold">Recent posts</h2>
        <ul className="space-y-1 text-sm">
          {d.recentPosts.map((x) => <li key={x.id}><Link to={`/post/${x.id}`} className="hover:underline">{x.deleted_at ? <i className="text-muted">deleted</i> : x.text.slice(0, 120)}</Link> <span className="text-xs text-muted">{timeAgo(x.created_at)}{x.ai_generated ? " · AI" : ""}{x.moderation_status !== "ok" ? ` · ${x.moderation_status}` : ""}</span></li>)}
        </ul>
        {d.reports.length ? <p className="mt-2 text-sm text-danger">{d.reports.length} report(s) against this profile — see Moderation.</p> : null}
      </Card>
      <ConfirmDialog
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        title={confirm === "identity" ? "Suspend this login?" : "Suspend this profile?"}
        body={confirm === "identity" ? "Signs the person out everywhere and blocks sign-in for every profile on this login." : "The profile can't post or interact and is hidden from feeds until reactivated."}
        confirmLabel="Suspend"
        danger
        onConfirm={() => {
          const which = confirm;
          setConfirm(null);
          void act(() => (which === "identity" ? post(`/admin/identities/${d.identity!.id}/status`, { status: "suspended" }) : post(`/admin/accounts/${id}/status`, { status: "suspended" })), "Suspended").then(reload);
        }}
      />
    </div>
  );
}

export function AdminAdmins() {
  const q = useQuery({ queryKey: ["admin", "admins"], queryFn: () => get<{ items: { identityId: string; role: string; grantedAt: number; profile: ProfileSummary | null }[] }>("/admin/admins") });
  const act = useAdminAction();
  const { session } = useSession();
  const [handle, setHandle] = useState("");
  const [role, setRole] = useState("moderator");
  const [revoke, setRevoke] = useState<string | null>(null);
  return (
    <div className="space-y-4">
      <Card className="space-y-3 p-5">
        <h2 className="text-lg font-extrabold">Grant access</h2>
        <p className="text-sm text-muted">Moderators handle reports and suspensions. Admins also manage settings, AI, visibility and moderators. Owners can manage everyone. New admins set their own passphrase on first use.</p>
        <form className="flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); void act(() => post("/admin/admins", { handle, role }), "Role granted").then(() => { setHandle(""); void q.refetch(); }); }}>
          <Input value={handle} onChange={(e) => setHandle(e.target.value.replace(/^@/, ""))} placeholder="@handle" aria-label="Handle" className="!w-56" />
          <select className="input !w-40" value={role} onChange={(e) => setRole(e.target.value)} aria-label="Role">
            <option value="moderator">Moderator</option>
            <option value="admin">Admin</option>
            {session?.admin?.role === "owner" ? <option value="owner">Owner</option> : null}
          </select>
          <Button type="submit" disabled={!handle}>Grant</Button>
        </form>
      </Card>
      <Card>
        <ul className="divide-y divide-[var(--c-border)]">
          {(q.data?.items ?? []).map((a) => (
            <li key={a.identityId} className="flex items-center gap-3 p-4">
              {a.profile ? <Avatar profile={a.profile} size={36} /> : null}
              <span className="min-w-0 flex-1">{a.profile ? <NameLine p={a.profile} /> : a.identityId}<span className="block text-xs text-muted">since {fullDate(a.grantedAt)}</span></span>
              <span className="chip capitalize">{a.role}</span>
              {a.identityId !== session?.identityId ? <Button size="sm" variant="ghost" onClick={() => setRevoke(a.identityId)}>Revoke</Button> : <span className="text-xs text-muted">you</span>}
            </li>
          ))}
        </ul>
      </Card>
      <ConfirmDialog open={!!revoke} onClose={() => setRevoke(null)} title="Revoke admin access?" body="They'll lose access to the admin console immediately. This is audited." confirmLabel="Revoke" danger onConfirm={() => { const id = revoke!; setRevoke(null); void act(() => del(`/admin/admins/${id}`), "Access revoked").then(() => q.refetch()); }} />
    </div>
  );
}
