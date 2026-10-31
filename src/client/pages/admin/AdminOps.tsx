import { useEffect, useState } from "react";
import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import type { ProfileSummary } from "../../../shared/types";
import { get, patch, post, put } from "../../lib/api";
import { bytes, fullDate, timeAgo, timeLeft } from "../../lib/format";
import { Avatar } from "../../components/Avatar";
import { NameLine, RichText } from "../../components/RichText";
import { Button, Card, EmptyState, ErrorState, Input, Spinner, Tabs, Toggle } from "../../components/ui";
import { Stat, useAdminAction } from "./Admin";

type Config = Record<string, Record<string, unknown>>;

function NumberField({ label, value, onChange, step = 1 }: { label: string; value: number; onChange: (v: number) => void; step?: number }) {
  return (
    <label className="block space-y-1 text-sm">
      <span className="font-semibold">{label}</span>
      <Input type="number" step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
    </label>
  );
}

const AI_NUMBERS: [string, string][] = [
  ["initialPopulation", "Initial persona population"], ["maxActivePersonas", "Max active personas"], ["intensity", "Activity intensity (×)"],
  ["agentsPerTick", "Agents woken per 5-min tick"], ["maxRepliesPerHour", "Max AI replies / hour"],
  ["maxLikesPerHour", "Max AI likes / hour"], ["perAgentDailyActions", "Per-agent actions / day"], ["perAgentDailyGenerations", "Per-agent generations / day"],
  ["perHumanDailyAiReplies", "AI replies a person can receive / day"], ["perPostMaxAiReplies", "AI replies per post"], ["perPostMaxAiLikes", "AI likes per post"],
  ["maxThreadAiTurns", "AI turns per thread"], ["perConversationDailyAiMessages", "AI DMs per conversation / day"], ["dailyCallBudget", "Daily model-call budget"],
  ["dailyTokenBudget", "Daily token budget"], ["callTimeoutMs", "Model call timeout (ms)"],
];

export function AdminAi() {
  const q = useQuery({ queryKey: ["admin", "ai"], queryFn: () => get<{ agents: { profile?: ProfileSummary; archetype: string; activity: string; enabled: boolean; state: string; lastActiveAt: number | null; actionsToday: number; generationsToday: number; followers: number }[]; usage: { day: string; model: string; task: string; calls: number; errors: number; input_tokens: number; output_tokens: number }[]; jobs: { kind: string; status: string; n: number }[]; errors: { id: string; level: string; source: string; message: string; created_at: number }[]; failedJobs: { kind: string; dedupe_key: string; status: string; attempts: number; last_error: string | null; updated_at: number }[]; seeded: boolean }>("/admin/ai/overview"), refetchInterval: 30_000 });
  const settings = useQuery({ queryKey: ["admin", "settings"], queryFn: () => get<{ config: Config }>("/admin/settings") });
  const act = useAdminAction();
  const [cfg, setCfg] = useState<Config | null>(null);
  const [audience, setAudience] = useState(500);
  useEffect(() => { if (settings.data) setCfg(settings.data.config); }, [settings.data]);
  if (q.isLoading || !cfg) return <Spinner />;
  if (q.isError) return <ErrorState error={q.error} />;
  const d = q.data!;
  const ai = cfg.ai as Record<string, unknown>;
  const setAi = (k: string, v: unknown) => setCfg({ ...cfg, ai: { ...ai, [k]: v } });
  const setSec = (sec: string, k: string, v: unknown) => setCfg({ ...cfg, [sec]: { ...cfg[sec], [k]: v } });
  const models = ai.models as Record<string, string>;
  return (
    <div className="space-y-4">
      <Card className="flex flex-wrap items-center gap-3 p-5">
        <div className="flex-1">
          <h2 className="text-lg font-extrabold">AI generation is {ai.paused ? <span className="text-danger">PAUSED</span> : <span className="text-success">running</span>}</h2>
          <p className="text-sm text-muted">Pausing stops all AI posts, replies, DMs, likes and follows immediately. The social network keeps working.</p>
        </div>
        <Button variant={ai.paused ? "primary" : "danger"} onClick={() => void act(() => post(`/admin/ai/${ai.paused ? "resume" : "pause"}`), ai.paused ? "AI resumed" : "AI paused").then(() => settings.refetch())}>{ai.paused ? "Resume AI" : "Emergency pause"}</Button>
      </Card>
      <Card className="space-y-4 p-5">
        <h2 className="text-lg font-extrabold">Configuration</h2>
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="block space-y-1 text-sm"><span className="font-semibold">Provider</span>
            <select className="input" value={String(ai.provider)} onChange={(e) => setAi("provider", e.target.value)}><option value="workers-ai">Cloudflare Workers AI</option><option value="openai-compatible">OpenAI-compatible (AI_OPENAI_BASE_URL)</option></select>
          </label>
          {(["dialogue", "evaluate", "moderation"] as const).map((k) => (
            <label key={k} className="block space-y-1 text-sm"><span className="font-semibold">{k} model</span><Input value={models[k]} onChange={(e) => setAi("models", { ...models, [k]: e.target.value })} /></label>
          ))}
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          {AI_NUMBERS.map(([k, label]) => <NumberField key={k} label={label} value={Number(ai[k])} step={k === "intensity" ? 0.1 : 1} onChange={(v) => setAi(k, v)} />)}
        </div>
        <Toggle checked={!!ai.moderateOutputs} onChange={(v) => setAi("moderateOutputs", v)} label="Moderate AI outputs before publishing" />
        <Toggle checked={!!ai.evaluateHumanPosts} onChange={(v) => setAi("evaluateHumanPosts", v)} label="Model-assisted quality/topic evaluation of human posts" />
        <h3 className="pt-2 font-extrabold">Ranking weights</h3>
        <div className="grid gap-3 sm:grid-cols-4">
          {Object.entries(cfg.ranking!).map(([k, v]) => <NumberField key={k} label={k} value={Number(v)} step={0.01} onChange={(x) => setSec("ranking", k, x)} />)}
        </div>
        <h3 className="pt-2 font-extrabold">Earned growth</h3>
        <div className="grid gap-3 sm:grid-cols-4">
          {Object.entries(cfg.growth!).filter(([k]) => k !== "enabled").map(([k, v]) => <NumberField key={k} label={k} value={Number(v)} step={k === "minGrowthScore" ? 0.01 : 1} onChange={(x) => setSec("growth", k, x)} />)}
        </div>
        <Toggle checked={!!cfg.growth!.enabled} onChange={(v) => setSec("growth", "enabled", v)} label="AI follower growth enabled" />
        <h3 className="pt-2 font-extrabold">Rate limits</h3>
        <div className="grid gap-3 sm:grid-cols-5">
          {Object.entries(cfg.limits!).map(([k, v]) => <NumberField key={k} label={k} value={Number(v)} onChange={(x) => setSec("limits", k, x)} />)}
        </div>
        <Button onClick={() => void act(() => put("/admin/settings", cfg), "Settings saved").then(() => settings.refetch())}>Save configuration</Button>
      </Card>
      <Card className="flex flex-wrap items-end gap-3 p-5">
        <div className="flex-1">
          <h2 className="text-lg font-extrabold">Population</h2>
          <p className="text-sm text-muted">{d.seeded ? "Initial personas are seeded." : "Not seeded yet — seeding runs automatically on the first sign-up or cron tick."} Audience accounts are lightweight, clearly-labeled AI profiles that only follow and like through the earned-growth system (no text generation), so large follower counts are backed by real rows.</p>
        </div>
        {!d.seeded ? <Button variant="secondary" onClick={() => void act(() => post("/admin/ai/seed"), "Seeding queued")}>Seed now</Button> : null}
        <Input type="number" value={audience} min={1} max={1100000} onChange={(e) => setAudience(Number(e.target.value))} className="!w-28" aria-label="Audience accounts to add" />
        <Button variant="secondary" onClick={() => void act(() => post("/admin/ai/audience", { count: audience }), "Audience expansion queued")}>Add audience accounts</Button>
      </Card>
      <Card className="overflow-x-auto p-0">
        <h2 className="p-4 pb-2 text-lg font-extrabold">Personas ({d.agents.length})</h2>
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase text-muted"><tr><th className="p-3">Account</th><th>Archetype</th><th>Activity</th><th>State</th><th>Today</th><th>Last active</th><th /></tr></thead>
          <tbody>
            {d.agents.map((a) => a.profile ? (
              <tr key={a.profile.id} className="border-t divider">
                <td className="p-3"><Link to={`/admin/accounts/${a.profile.id}`} className="flex items-center gap-2"><Avatar profile={a.profile} size={24} /><NameLine p={a.profile} linked={false} size="sm" showHandle={false} /></Link></td>
                <td>{a.archetype}</td><td>{a.activity}</td><td>{a.state}</td><td>{a.actionsToday} / {a.generationsToday} gen</td>
                <td className="text-muted">{a.lastActiveAt ? timeAgo(a.lastActiveAt) : "never"}</td>
                <td><Button size="sm" variant="ghost" onClick={() => void act(() => patch(`/admin/ai/agents/${a.profile!.id}`, { enabled: !a.enabled }), a.enabled ? "Disabled" : "Enabled").then(() => q.refetch())}>{a.enabled ? "Disable" : "Enable"}</Button></td>
              </tr>
            ) : null)}
          </tbody>
        </table>
      </Card>
      <div className="grid gap-4 lg:grid-cols-2 [&>*]:min-w-0">
        <Card className="p-4">
          <h2 className="mb-2 font-extrabold">Model usage (7 days)</h2>
          {d.usage.length ? <ul className="space-y-1 text-xs">{d.usage.map((u, i) => <li key={i}>{u.day} · {u.task} · <span className="font-mono">{u.model}</span> · {u.calls} calls · {u.errors} errors · {u.input_tokens + u.output_tokens} tokens</li>)}</ul> : <p className="text-sm text-muted">No model calls yet.</p>}
        </Card>
        <Card className="p-4">
          <h2 className="mb-2 font-extrabold">AI jobs (24h)</h2>
          <div className="flex flex-wrap gap-1.5">{d.jobs.map((j, i) => <span key={i} className="chip">{j.kind} · {j.status} · {j.n}</span>)}</div>
          {d.failedJobs.length ? <><h3 className="mt-3 text-sm font-bold">Failed / dead-lettered</h3><ul className="text-xs">{d.failedJobs.map((j) => <li key={j.dedupe_key}>{j.kind} · {j.status} · {j.attempts} attempts · {j.last_error}</li>)}</ul></> : null}
        </Card>
      </div>
      <Card className="p-4">
        <h2 className="mb-2 font-extrabold">AI errors & events</h2>
        {d.errors.length ? <ul className="space-y-1 text-xs">{d.errors.map((e) => <li key={e.id}><span className={e.level === "error" ? "text-danger" : ""}>[{e.level}]</span> {e.source}: {e.message} · {timeAgo(e.created_at)}</li>)}</ul> : <p className="text-sm text-muted">No AI errors recorded.</p>}
      </Card>
    </div>
  );
}

export function AdminMedia() {
  const q = useQuery({ queryKey: ["admin", "media"], queryFn: () => get<{ now: number; upcoming: { id: string; kind: string; size_bytes: number; expires_at: number }[]; failed: { id: string; status: string; delete_attempts: number; last_error: string | null }[]; recentExpired: { id: string; kind: string; size_bytes: number; removed_at: number }[]; byStatus: { status: string; purpose: string; n: number; bytes: number }[]; lastRun: { at: number; queued: number; orphans: number; requeued: number } | null }>("/admin/media"), refetchInterval: 30_000 });
  const act = useAdminAction();
  if (q.isLoading) return <Spinner />;
  if (q.isError) return <ErrorState error={q.error} />;
  const d = q.data!;
  return (
    <div className="space-y-4">
      <Card className="p-5 text-sm text-muted">
        Post and message media expires 7 days after upload. Serving checks the expiry on every request, so expired files are never delivered even if physical deletion is delayed. An hourly sweep queues R2 deletions; failures retry up to 5 times and then appear below. Copies outside the platform (downloads, screenshots, provider backups) can't be erased by Crew Plus.
      </Card>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Last cleanup run" value={d.lastRun ? timeAgo(d.lastRun.at) : "never"} hint={d.lastRun ? `${d.lastRun.queued} expired · ${d.lastRun.orphans} orphans · ${d.lastRun.requeued} re-queued` : undefined} />
        {d.byStatus.map((s) => <Stat key={`${s.status}${s.purpose}`} label={`${s.purpose} · ${s.status}`} value={s.n} hint={bytes(s.bytes)} />)}
      </div>
      <div className="flex gap-2">
        <Button variant="secondary" onClick={() => void act(() => post("/admin/maintenance/media-cleanup"), "Cleanup ran").then(() => q.refetch())}>Run cleanup now</Button>
        <Button variant="secondary" disabled={!d.failed.length} onClick={() => void act(() => post("/admin/media/retry-failed"), "Retry queued").then(() => q.refetch())}>Retry failed deletions</Button>
      </div>
      <div className="grid gap-4 lg:grid-cols-3 [&>*]:min-w-0">
        <Card className="p-4"><h2 className="mb-2 font-extrabold">Expiring next</h2><ul className="space-y-1 text-xs">{d.upcoming.map((m) => <li key={m.id}>{m.kind} · {bytes(m.size_bytes)} · {timeLeft(m.expires_at, d.now)}</li>)}</ul>{!d.upcoming.length ? <p className="text-sm text-muted">Nothing pending.</p> : null}</Card>
        <Card className="p-4"><h2 className="mb-2 font-extrabold">Failures</h2><ul className="space-y-1 text-xs">{d.failed.map((m) => <li key={m.id} className="text-danger">{m.id} · {m.status} · {m.delete_attempts} attempts · {m.last_error}</li>)}</ul>{!d.failed.length ? <p className="text-sm text-muted">No failed deletions.</p> : null}</Card>
        <Card className="p-4"><h2 className="mb-2 font-extrabold">Recently expired</h2><ul className="space-y-1 text-xs">{d.recentExpired.map((m) => <li key={m.id}>{m.kind} · {bytes(m.size_bytes)} · removed {m.removed_at ? timeAgo(m.removed_at) : "—"}</li>)}</ul></Card>
      </div>
    </div>
  );
}

export function AdminReports() {
  const [status, setStatus] = useState<"open" | "actioned" | "dismissed">("open");
  const q = useQuery({ queryKey: ["admin", "reports", status], queryFn: () => get<{ items: { id: string; target_type: string; target_id: string; reason: string; details: string; status: string; resolution: string | null; created_at: number; reporter: ProfileSummary | null; target: Record<string, unknown> | null }[] }>(`/admin/reports?status=${status}`) });
  const act = useAdminAction();
  return (
    <div className="space-y-3">
      <Tabs label="Report status" value={status} onChange={setStatus} tabs={[{ id: "open", label: "Open" }, { id: "actioned", label: "Actioned" }, { id: "dismissed", label: "Dismissed" }]} />
      {q.isError ? <ErrorState error={q.error} /> : null}
      {q.isSuccess && !q.data.items.length ? <EmptyState icon="flag" title="No reports here" /> : null}
      {(q.data?.items ?? []).map((r) => (
        <Card key={r.id} className="space-y-2 p-4">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="chip">{r.target_type}</span><span className="chip !text-danger">{r.reason}</span>
            <span className="text-muted">reported by @{r.reporter?.handle ?? "unknown"} · {fullDate(r.created_at)}</span>
          </div>
          {r.details ? <p className="text-sm">“{r.details}”</p> : null}
          <div className="rounded-xl bg-surface2 p-3 text-sm">
            {r.target_type === "post" && r.target ? <><b>@{String((r.target.author as ProfileSummary)?.handle ?? "")}</b><RichText text={String(r.target.text ?? "") || "(deleted)"} /><Link to={`/post/${r.target_id}`} className="text-xs text-accent">Open post</Link></>
              : r.target_type === "profile" && r.target ? <Link to={`/admin/accounts/${r.target_id}`} className="text-accent">@{String(r.target.handle)}</Link>
              : r.target_type === "message" && r.target ? <p>{String(r.target.text ?? "(deleted)")}</p>
              : <p className="text-muted">{r.target_id}</p>}
          </div>
          {r.status === "open" ? (
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="secondary" onClick={() => void act(() => post(`/admin/reports/${r.id}/resolve`, { action: "dismiss" }), "Dismissed").then(() => q.refetch())}>Dismiss</Button>
              {r.target_type !== "profile" ? <Button size="sm" variant="danger" onClick={() => void act(() => post(`/admin/reports/${r.id}/resolve`, { action: "remove_content" }), "Content removed").then(() => q.refetch())}>Remove content</Button> : null}
              <Button size="sm" variant="danger" onClick={() => void act(() => post(`/admin/reports/${r.id}/resolve`, { action: "suspend_profile" }), "Profile suspended").then(() => q.refetch())}>Suspend author</Button>
            </div>
          ) : <p className="text-xs text-muted">Resolution: {r.resolution}</p>}
        </Card>
      ))}
    </div>
  );
}

export function AdminLogs() {
  const audit = useQuery({ queryKey: ["admin", "audit"], queryFn: () => get<{ items: { id: string; actor_identity_id: string; action: string; target_type: string | null; target_id: string | null; before_json: string | null; after_json: string | null; created_at: number }[] }>("/admin/audit") });
  const errors = useQuery({ queryKey: ["admin", "errors"], queryFn: () => get<{ items: { id: string; level: string; source: string; message: string; data_json: string; created_at: number }[] }>("/admin/errors") });
  return (
    <div className="grid gap-4 lg:grid-cols-2 [&>*]:min-w-0">
      <Card className="p-4">
        <h2 className="mb-2 font-extrabold">Audit log</h2>
        <ul className="space-y-2 text-xs">
          {(audit.data?.items ?? []).map((a) => (
            <li key={a.id} className="border-b divider pb-2">
              <span className="font-mono font-bold">{a.action}</span> on {a.target_type}:{a.target_id} · {fullDate(a.created_at)}
              <span className="block text-muted">by identity {a.actor_identity_id}</span>
              {a.after_json ? <span className="block break-all text-muted">{a.before_json ? `${a.before_json.slice(0, 120)} → ` : ""}{a.after_json.slice(0, 160)}</span> : null}
            </li>
          ))}
        </ul>
      </Card>
      <Card className="p-4">
        <h2 className="mb-2 font-extrabold">Operational log</h2>
        <ul className="space-y-2 text-xs">
          {(errors.data?.items ?? []).map((e) => (
            <li key={e.id} className="border-b divider pb-2"><span className={e.level === "error" ? "font-bold text-danger" : "font-bold"}>[{e.level}]</span> {e.source}: {e.message} · {fullDate(e.created_at)}<span className="block break-all text-muted">{e.data_json.slice(0, 200)}</span></li>
          ))}
        </ul>
        {errors.isSuccess && !errors.data.items.length ? <p className="text-sm text-muted">No warnings or errors logged.</p> : null}
      </Card>
    </div>
  );
}
