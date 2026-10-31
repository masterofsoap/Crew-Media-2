import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { AFFILIATION_TYPES, BIO_MAX_CHARS, BUSINESS_CATEGORIES, DISPLAY_NAME_MAX } from "../../shared/constants";
import { isValidHandle } from "../../shared/text";
import type { AffiliationView, ProfileSummary, SessionInfo } from "../../shared/types";
import { del, errorMessage, get, post } from "../lib/api";
import { compactNumber, timeAgo } from "../lib/format";
import { useActive, useSession } from "../lib/session";
import { Avatar } from "../components/Avatar";
import { NameLine } from "../components/RichText";
import { Button, Card, EmptyState, ErrorState, Field, Input, PageHeader, Spinner, Textarea } from "../components/ui";
import { useToast } from "../components/toast";

export function BusinessNew() {
  const { setSession } = useSession();
  const nav = useNavigate();
  const [f, setF] = useState({ name: "", handle: "", category: BUSINESS_CATEGORIES[0] as string, website: "", description: "" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div>
      <PageHeader title="Create a business profile" back={() => nav(-1)} />
      <form
        className="space-y-4 p-4"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!isValidHandle(f.handle)) return setError("Handles are 3–20 letters, numbers or underscores.");
          setBusy(true);
          setError(null);
          try {
            const r = await post<{ session: SessionInfo }>("/business", { ...f, switchTo: true });
            setSession(r.session);
            nav("/business");
          } catch (err) {
            setError(errorMessage(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        <p className="text-muted">Business profiles are separate identities you can switch to anytime — no extra login. You can invite family members as managers.</p>
        <Field label="Business name" id="bn"><Input id="bn" maxLength={DISPLAY_NAME_MAX} required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Handle" id="bh"><Input id="bh" maxLength={20} required value={f.handle} onChange={(e) => setF({ ...f, handle: e.target.value.replace(/[^A-Za-z0-9_]/g, "") })} /></Field>
        <Field label="Category" id="bc">
          <select id="bc" className="input" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>
            {BUSINESS_CATEGORIES.map((c) => <option key={c}>{c}</option>)}
          </select>
        </Field>
        <Field label="Website" id="bw"><Input id="bw" type="url" placeholder="https://" value={f.website} onChange={(e) => setF({ ...f, website: e.target.value })} /></Field>
        <Field label="Description" id="bd" hint={`${f.description.length}/${BIO_MAX_CHARS}`}><Textarea id="bd" rows={3} maxLength={BIO_MAX_CHARS} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
        {error ? <p role="alert" className="text-sm text-danger">{error}</p> : null}
        <Button type="submit" loading={busy} disabled={!f.name || !f.handle}>Create business</Button>
      </form>
    </div>
  );
}

interface Dashboard {
  category: string;
  website: string;
  followers: number;
  following: number;
  posts: number;
  last7Days: { newFollowers: number; posts: number; likes: number; replies: number; reposts: number };
  topPosts: { id: string; text: string; likes: number; replies: number; reposts: number; createdAt: number }[];
  recentFollowers: ProfileSummary[];
  affiliations: AffiliationView[];
}

function Managers() {
  const toast = useToast();
  const [handle, setHandle] = useState("");
  const q = useQuery({ queryKey: ["managers"], queryFn: () => get<{ items: { identityId: string; role: string; since: number; profile: ProfileSummary | null; isYou: boolean }[]; canManage: boolean }>("/business/managers") });
  return (
    <Card className="space-y-3 p-5">
      <h2 className="text-lg font-extrabold">Managers</h2>
      <p className="text-sm text-muted">Managers can post and reply as this business from their own login. Only the owner can add or remove managers.</p>
      <ul className="space-y-2">
        {(q.data?.items ?? []).map((m) => (
          <li key={m.identityId} className="flex items-center gap-3">
            {m.profile ? <Avatar profile={m.profile} size={32} /> : null}
            <span className="min-w-0 flex-1">{m.profile ? <NameLine p={m.profile} /> : "Unknown"}</span>
            <span className="chip capitalize">{m.role}{m.isYou ? " · you" : ""}</span>
            {m.role === "manager" && (q.data?.canManage || m.isYou) ? (
              <Button size="sm" variant="ghost" onClick={async () => { try { await del(`/business/managers/${m.identityId}`); toast("Manager removed"); void q.refetch(); } catch (e) { toast(errorMessage(e), "error"); } }}>Remove</Button>
            ) : null}
          </li>
        ))}
      </ul>
      {q.data?.canManage ? (
        <form className="flex gap-2" onSubmit={async (e) => { e.preventDefault(); try { await post("/business/managers", { handle }); setHandle(""); toast("Manager added"); void q.refetch(); } catch (err) { toast(errorMessage(err), "error"); } }}>
          <Input value={handle} onChange={(e) => setHandle(e.target.value.replace(/^@/, ""))} placeholder="Their personal @handle" aria-label="Manager handle" />
          <Button type="submit" disabled={!handle}>Add</Button>
        </form>
      ) : null}
    </Card>
  );
}

export function BusinessDashboard() {
  const active = useActive();
  const nav = useNavigate();
  const q = useQuery({ queryKey: ["business-dashboard", active.id], enabled: active.kind === "business", queryFn: () => get<Dashboard>("/business/dashboard") });
  if (active.kind !== "business")
    return (
      <div>
        <PageHeader title="Business" back={() => nav(-1)} />
        <EmptyState icon="briefcase" title="Switch to a business profile" action={<Link to="/business/new"><Button icon="plus">Create a business profile</Button></Link>}>
          Business dashboards are available when you're acting as a business profile.
        </EmptyState>
      </div>
    );
  if (q.isLoading) return <div className="flex justify-center py-16"><Spinner /></div>;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const d = q.data!;
  const stats: [string, number][] = [["Followers", d.followers], ["New followers (7d)", d.last7Days.newFollowers], ["Posts (7d)", d.last7Days.posts], ["Likes received (7d)", d.last7Days.likes], ["Replies received (7d)", d.last7Days.replies], ["Reposts (7d)", d.last7Days.reposts]];
  return (
    <div>
      <PageHeader title="Business dashboard" subtitle={`@${active.handle} · ${d.category}`} back={() => nav(-1)} actions={<Link to="/business/affiliates"><Button size="sm" variant="secondary">Affiliates</Button></Link>} />
      <div className="space-y-4 p-4">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {stats.map(([k, v]) => (
            <Card key={k} className="p-4">
              <p className="heading text-2xl font-extrabold">{compactNumber(v)}</p>
              <p className="text-xs text-muted">{k}</p>
            </Card>
          ))}
        </div>
        <p className="text-xs text-muted">All figures are counted from real activity on Crew Plus. Advertising, payments and paid analytics aren't part of Crew Plus.</p>
        <Card className="p-5">
          <h2 className="mb-2 text-lg font-extrabold">Top posts</h2>
          {d.topPosts.length ? (
            <ul className="divide-y divide-[var(--c-border)]">
              {d.topPosts.map((p) => (
                <li key={p.id}>
                  <Link to={`/post/${p.id}`} className="block py-2 hover:underline">
                    <span className="line-clamp-2">{p.text || "(media post)"}</span>
                    <span className="text-xs text-muted">{p.likes} likes · {p.replies} replies · {p.reposts} reposts · {timeAgo(p.createdAt)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted">No posts yet.</p>
          )}
        </Card>
        <Card className="p-5">
          <h2 className="mb-2 text-lg font-extrabold">Recent followers</h2>
          <div className="flex flex-wrap gap-2">
            {d.recentFollowers.length ? d.recentFollowers.map((p) => <Link key={p.id} to={`/@${p.handle}`} title={p.displayName}><Avatar profile={p} size={40} /></Link>) : <p className="text-sm text-muted">No followers yet.</p>}
          </div>
        </Card>
        <Managers />
      </div>
    </div>
  );
}

export function Affiliates() {
  const active = useActive();
  const nav = useNavigate();
  const toast = useToast();
  const q = useQuery({ queryKey: ["affiliations", active.id], queryFn: () => get<{ items: AffiliationView[]; actingId: string }>("/affiliations") });
  const [search, setSearch] = useState("");
  const [rel, setRel] = useState<string>(AFFILIATION_TYPES[2].value);
  const results = useQuery({ queryKey: ["affil-eligible", search], enabled: search.trim().length >= 1 && active.kind === "business", queryFn: () => get<{ items: ProfileSummary[] }>(`/affiliations/eligible?q=${encodeURIComponent(search)}`) });
  const items = q.data?.items ?? [];
  const act = async (fn: () => Promise<unknown>, msg: string) => {
    try {
      await fn();
      toast(msg);
      void q.refetch();
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };
  return (
    <div>
      <PageHeader title="Affiliates" subtitle={`@${active.handle}`} back={() => nav(-1)} />
      <div className="space-y-4 p-4">
        <Card className="p-4 text-sm text-muted">
          Affiliations link profiles with an explicit relationship (partner, brand, subsidiary…). The invited profile must accept before anything is shown — nobody can be listed without consent. Affiliation is not business verification.
        </Card>
        {active.kind === "business" ? (
          <Card className="space-y-3 p-5">
            <h2 className="text-lg font-extrabold">Invite an affiliate</h2>
            <div className="flex flex-wrap gap-2">
              {AFFILIATION_TYPES.map((t) => (
                <button key={t.value} type="button" aria-pressed={rel === t.value} onClick={() => setRel(t.value)} className={`rounded-full border px-3 py-1 text-xs font-semibold ${rel === t.value ? "border-accent bg-accent text-on-accent" : "divider bg-surface2"}`}>{t.label}</button>
              ))}
            </div>
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search people and businesses" aria-label="Search eligible profiles" />
            <ul>
              {(results.data?.items ?? []).map((p) => (
                <li key={p.id} className="flex items-center gap-3 py-2">
                  <Avatar profile={p} size={36} />
                  <span className="min-w-0 flex-1"><NameLine p={p} linked={false} /></span>
                  <Button size="sm" onClick={() => void act(() => post("/affiliations", { targetId: p.id, relationType: rel }), "Invitation sent")}>Invite</Button>
                </li>
              ))}
            </ul>
          </Card>
        ) : null}
        <Card className="p-5">
          <h2 className="mb-2 text-lg font-extrabold">Affiliations</h2>
          {q.isLoading ? <Spinner /> : !items.length ? <p className="text-sm text-muted">No affiliations yet.</p> : null}
          <ul className="divide-y divide-[var(--c-border)]">
            {items.map((af) => {
              const other = af.business.id === active.id ? af.affiliate : af.business;
              const incoming = af.status === "pending" && af.requestedBy !== active.id;
              return (
                <li key={af.id} className="flex flex-wrap items-center gap-3 py-3">
                  <Avatar profile={other} size={36} />
                  <span className="min-w-0 flex-1">
                    <NameLine p={other} />
                    <span className="text-xs text-muted">{AFFILIATION_TYPES.find((t) => t.value === af.relationType)?.label} · {af.status === "pending" ? (incoming ? "invited you" : "awaiting response") : "confirmed"}</span>
                  </span>
                  {incoming ? (
                    <>
                      <Button size="sm" onClick={() => void act(() => post(`/affiliations/${af.id}/respond`, { accept: true }), "Affiliation accepted")}>Accept</Button>
                      <Button size="sm" variant="secondary" onClick={() => void act(() => post(`/affiliations/${af.id}/respond`, { accept: false }), "Declined")}>Decline</Button>
                    </>
                  ) : (
                    <Button size="sm" variant="ghost" onClick={() => void act(() => del(`/affiliations/${af.id}`), "Affiliation removed")}>{af.status === "pending" ? "Cancel" : "Remove"}</Button>
                  )}
                </li>
              );
            })}
          </ul>
        </Card>
      </div>
    </div>
  );
}
