import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MESSAGE_MAX_CHARS } from "../../shared/constants";
import type { ConversationView, MediaView, MessageView, ProfileSummary } from "../../shared/types";
import { del, errorMessage, get, patch, post, uploadMedia } from "../lib/api";
import { fullDate, timeAgo } from "../lib/format";
import { useActive } from "../lib/session";
import { useRealtime } from "../lib/realtime";
import { useCursorList, LoadMore } from "../components/Feed";
import { Avatar } from "../components/Avatar";
import { Icon } from "../components/Icon";
import { MediaGrid } from "../components/MediaGrid";
import { KindChip, NameLine, RichText } from "../components/RichText";
import { Button, Dialog, EmptyState, ErrorState, IconButton, Input, PageHeader, Spinner, Textarea } from "../components/ui";
import { useToast } from "../components/toast";
import { validateFile } from "../components/Composer";
import { ReportDialog } from "../components/ReportDialog";

function convTitle(c: ConversationView, me: string) {
  if (c.title) return c.title;
  const others = c.members.filter((m) => m.id !== me);
  return others.map((m) => m.displayName).join(", ") || "Just you";
}

function NewConversation({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<ProfileSummary[]>([]);
  const [title, setTitle] = useState("");
  const nav = useNavigate();
  const toast = useToast();
  const results = useQuery({
    queryKey: ["dm-search", q],
    enabled: q.trim().length >= 1,
    queryFn: ({ signal }) => get<{ profiles: ProfileSummary[] }>(`/search?q=${encodeURIComponent(q)}&type=top`, signal),
  });
  const create = useMutation({
    mutationFn: () => post<ConversationView>("/conversations", { memberIds: picked.map((p) => p.id), title: picked.length > 1 && title ? title : undefined }),
    onSuccess: (c) => {
      onClose();
      setPicked([]);
      nav(`/messages/${c.id}`);
    },
    onError: (e) => toast(errorMessage(e), "error"),
  });
  return (
    <Dialog open={open} onClose={onClose} title="New message">
      <div className="space-y-3">
        {picked.length ? (
          <div className="flex flex-wrap gap-2">
            {picked.map((p) => (
              <button key={p.id} type="button" className="chip !py-1" onClick={() => setPicked((x) => x.filter((y) => y.id !== p.id))} aria-label={`Remove ${p.displayName}`}>
                {p.displayName} <Icon name="close" size={12} />
              </button>
            ))}
          </div>
        ) : null}
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search people" aria-label="Search people" autoFocus />
        <div className="max-h-64 overflow-y-auto">
          {(results.data?.profiles ?? [])
            .filter((p) => !picked.some((x) => x.id === p.id))
            .map((p) => (
              <button key={p.id} type="button" className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left hover:bg-surface2" onClick={() => picked.length < 8 && setPicked((x) => [...x, p])}>
                <Avatar profile={p} size={36} />
                <NameLine p={p} linked={false} stacked />
              </button>
            ))}
        </div>
        {picked.length > 1 ? <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Group name (optional)" maxLength={60} aria-label="Group name" /> : null}
        <p className="text-xs text-muted">People can limit who may message them. AI accounts reply only if you allow AI messages in AI preferences.</p>
        <Button className="w-full" disabled={!picked.length} loading={create.isPending} onClick={() => create.mutate()}>
          {picked.length > 1 ? "Start group" : "Start chat"}
        </Button>
      </div>
    </Dialog>
  );
}

function ConversationList({ activeId }: { activeId?: string }) {
  const me = useActive();
  const q = useCursorList<ConversationView>(["conversations"], "/conversations");
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];
  if (q.isLoading) return <div className="flex justify-center py-10"><Spinner label="Loading conversations" /></div>;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  if (!items.length) return <EmptyState icon="mail" title="No messages yet">Start a private conversation with family, friends or an AI account.</EmptyState>;
  return (
    <ul>
      {items.map((c) => {
        const others = c.members.filter((m) => m.id !== me.id);
        const lead = others[0] ?? c.members[0]!;
        return (
          <li key={c.id}>
            <Link to={`/messages/${c.id}`} className={`flex items-center gap-3 px-4 py-3 transition-colors hover:bg-surface2/40 ${activeId === c.id ? "bg-surface2/60" : ""}`}>
              <div className="relative">
                <Avatar profile={lead} size={48} />
                {others.length > 1 ? <span className="absolute -bottom-1 -right-1 rounded-full bg-surface2 px-1.5 text-[10px] font-bold">+{others.length - 1}</span> : null}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className={`truncate ${c.unread ? "font-extrabold" : "font-semibold"}`}>{convTitle(c, me.id)}</span>
                  {others.length === 1 ? <KindChip kind={lead.kind} /> : null}
                  {c.muted ? <Icon name="mute" size={14} className="text-muted" /> : null}
                  <span className="ml-auto shrink-0 text-xs text-muted">{c.lastMessage ? timeAgo(c.lastMessage.createdAt) : ""}</span>
                </div>
                <p className={`truncate text-sm ${c.unread ? "text-fg" : "text-muted"}`}>
                  {c.lastMessage ? (c.lastMessage.deleted ? "Message deleted" : c.lastMessage.text ?? (c.lastMessage.hasMedia ? "Sent an attachment" : "")) : "No messages yet"}
                </p>
              </div>
              {c.unread ? <span className="chip">{c.unread}</span> : null}
            </Link>
          </li>
        );
      })}
      <LoadMore hasNext={!!q.hasNextPage} loading={q.isFetchingNextPage} onLoad={() => void q.fetchNextPage()} />
    </ul>
  );
}

function SearchMessages() {
  const [q, setQ] = useState("");
  const r = useQuery({ queryKey: ["msg-search", q], enabled: q.trim().length >= 2, queryFn: () => get<{ items: { id: string; conversationId: string; sender: ProfileSummary | null; text: string; createdAt: number }[] }>(`/conversations/search?q=${encodeURIComponent(q)}`) });
  return (
    <div className="border-b divider px-4 py-3">
      <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search your messages" aria-label="Search your messages" />
      {q.trim().length >= 2 ? (
        <ul className="mt-2 max-h-60 overflow-y-auto">
          {(r.data?.items ?? []).map((m) => (
            <li key={m.id}>
              <Link to={`/messages/${m.conversationId}`} className="block rounded-lg px-2 py-2 hover:bg-surface2">
                <span className="text-xs text-muted">{m.sender?.displayName} · {timeAgo(m.createdAt)}</span>
                <span className="block truncate text-sm">{m.text}</span>
              </Link>
            </li>
          ))}
          {r.isSuccess && !r.data.items.length ? <li className="px-2 py-2 text-sm text-muted">No matches.</li> : null}
        </ul>
      ) : null}
    </div>
  );
}

export function Inbox() {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <PageHeader title="Messages" actions={<IconButton icon="plus" label="New message" onClick={() => setOpen(true)} />} />
      <SearchMessages />
      <ConversationList />
      <NewConversation open={open} onClose={() => setOpen(false)} />
    </div>
  );
}

function MessageBubble({ m, mine, convId, showSender }: { m: MessageView; mine: boolean; convId: string; showSender: boolean }) {
  const [menu, setMenu] = useState(false);
  const [report, setReport] = useState(false);
  const qc = useQueryClient();
  const toast = useToast();
  const remove = async (scope: "me" | "everyone") => {
    setMenu(false);
    try {
      await del(`/conversations/${convId}/messages/${m.id}?scope=${scope}`);
      void qc.invalidateQueries({ queryKey: ["messages", convId] });
      toast(scope === "me" ? "Deleted for you" : "Deleted for everyone");
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };
  return (
    <div className={`group flex gap-2 ${mine ? "flex-row-reverse" : ""}`}>
      {!mine ? <Avatar profile={m.sender} size={28} className={showSender ? "" : "invisible"} /> : null}
      <div className={`max-w-[78%] space-y-1 ${mine ? "items-end text-right" : ""} flex flex-col`}>
        {showSender && !mine ? <span className="px-1 text-xs text-muted">{m.sender.displayName}{m.aiGenerated ? " · AI" : ""}</span> : null}
        {m.deleted ? (
          <div className="rounded-2xl border divider px-3 py-2 text-sm italic text-muted">Message deleted</div>
        ) : (
          <>
            {m.media.length ? <div className="w-64 max-w-full"><MediaGrid media={m.media} compact /></div> : null}
            {m.text ? (
              <div className={`rounded-2xl px-3.5 py-2 text-left ${mine ? "rounded-br-md bg-accent text-on-accent" : "rounded-bl-md bg-surface2"}`}>
                <RichText text={m.text} />
              </div>
            ) : null}
          </>
        )}
        <span className="px-1 text-[11px] text-muted" title={fullDate(m.createdAt)}>{timeAgo(m.createdAt)}</span>
      </div>
      {!m.deleted ? (
        <div className="relative self-center opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          <IconButton icon="more" label="Message options" size={16} onClick={() => setMenu((x) => !x)} />
          {menu ? (
            <div role="menu" className={`card absolute top-8 z-20 w-48 py-1 text-sm ${mine ? "right-0" : "left-0"}`} onMouseLeave={() => setMenu(false)}>
              <button role="menuitem" className="w-full px-3 py-2 text-left hover:bg-surface2" onClick={() => void remove("me")}>Delete for me</button>
              {mine ? <button role="menuitem" className="w-full px-3 py-2 text-left text-danger hover:bg-surface2" onClick={() => void remove("everyone")}>Delete for everyone</button> : null}
              {!mine ? <button role="menuitem" className="w-full px-3 py-2 text-left hover:bg-surface2" onClick={() => (setMenu(false), setReport(true))}>Report message</button> : null}
            </div>
          ) : null}
        </div>
      ) : null}
      <ReportDialog open={report} onClose={() => setReport(false)} targetType="message" targetId={m.id} />
    </div>
  );
}

export function Conversation() {
  const { id = "" } = useParams();
  const me = useActive();
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const { typing } = useRealtime();
  const conv = useQuery({ queryKey: ["conversation", id], queryFn: ({ signal }) => get<ConversationView>(`/conversations/${id}`, signal) });
  const msgs = useCursorList<MessageView>(["messages", id], `/conversations/${id}/messages`, conv.isSuccess);
  const [text, setText] = useState("");
  const [attach, setAttach] = useState<{ file: File; progress: number; media?: MediaView; error?: string } | null>(null);
  const [sending, setSending] = useState(false);
  const lastTyping = useRef(0);
  const bottom = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const items = useMemo(() => (msgs.data?.pages.flatMap((p) => p.items) ?? []).slice().reverse(), [msgs.data]);
  const newestId = items[items.length - 1]?.id;

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
    if (newestId) {
      void post(`/conversations/${id}/read`).then(() => qc.invalidateQueries({ queryKey: ["session"] })).catch(() => undefined);
      void qc.invalidateQueries({ queryKey: ["conversations"] });
    }
  }, [newestId, id, qc]);

  const typers = (typing[id] ?? []).filter((t) => t.profileId !== me.id).map((t) => conv.data?.members.find((m) => m.id === t.profileId)?.displayName).filter(Boolean);

  const send = async () => {
    if (sending || (!text.trim() && !attach?.media)) return;
    setSending(true);
    try {
      const m = await post<MessageView>(`/conversations/${id}/messages`, { text, mediaIds: attach?.media ? [attach.media.id] : [] });
      qc.setQueryData<{ pages: { items: MessageView[]; cursor: string | null }[]; pageParams: unknown[] }>(["messages", id], (old) => {
        if (!old?.pages[0]) return old;
        if (old.pages[0].items.some((x) => x.id === m.id)) return old;
        return { ...old, pages: [{ ...old.pages[0], items: [m, ...old.pages[0].items] }, ...old.pages.slice(1)] };
      });
      setText("");
      setAttach(null);
      void qc.invalidateQueries({ queryKey: ["conversations"] });
    } catch (e) {
      toast(errorMessage(e), "error");
    } finally {
      setSending(false);
    }
  };

  const others = conv.data?.members.filter((m) => m.id !== me.id) ?? [];
  const lead = others[0];

  return (
    <div className="flex h-[calc(100dvh-57px)] flex-col md:h-dvh">
      <PageHeader
        back={() => nav("/messages")}
        title={conv.data ? convTitle(conv.data, me.id) : "Conversation"}
        subtitle={lead && others.length === 1 ? `@${lead.handle}${lead.kind === "ai" ? " · AI account" : ""}` : others.length > 1 ? `${others.length + 1} members` : undefined}
        actions={
          conv.data ? (
            <div className="flex">
              <IconButton
                icon="mute"
                label={conv.data.muted ? "Unmute conversation" : "Mute conversation"}
                active={conv.data.muted}
                onClick={async () => {
                  await patch(`/conversations/${id}`, { muted: !conv.data!.muted });
                  void conv.refetch();
                  toast(conv.data!.muted ? "Unmuted" : "Muted");
                }}
              />
              {conv.data.kind === "group" ? (
                <IconButton
                  icon="logout"
                  label="Leave group"
                  onClick={async () => {
                    await patch(`/conversations/${id}`, { leave: true });
                    nav("/messages");
                  }}
                />
              ) : lead ? (
                <Link to={`/@${lead.handle}`} aria-label="View profile" className="btn btn-ghost rounded-full p-2"><Icon name="user" /></Link>
              ) : null}
            </div>
          ) : null
        }
      />
      {conv.isError ? (
        <ErrorState error={conv.error} />
      ) : (
        <div className="flex-1 space-y-3 overflow-y-auto px-4 py-4" aria-live="polite" aria-label="Messages">
          <LoadMore hasNext={!!msgs.hasNextPage} loading={msgs.isFetchingNextPage} onLoad={() => void msgs.fetchNextPage()} />
          {lead?.kind === "ai" ? <p className="mx-auto max-w-sm rounded-xl bg-surface2 px-3 py-2 text-center text-xs text-muted">You're chatting with an AI-operated account. It only sees this conversation, not your other messages. Messages aren't end-to-end encrypted.</p> : null}
          {msgs.isLoading ? <div className="flex justify-center"><Spinner /></div> : null}
          {items.map((m, i) => (
            <MessageBubble key={m.id} m={m} mine={m.sender.id === me.id} convId={id} showSender={items[i - 1]?.sender.id !== m.sender.id} />
          ))}
          {typers.length ? <p className="text-xs italic text-muted">{typers.join(", ")} {typers.length > 1 ? "are" : "is"} typing…</p> : null}
          <div ref={bottom} />
        </div>
      )}
      <form
        className="border-t divider p-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))]"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        {attach ? (
          <div className="mb-2 flex items-center gap-2 rounded-xl bg-surface2 px-3 py-2 text-sm">
            <Icon name={attach.file.type.startsWith("video") ? "video" : "image"} size={16} />
            <span className="truncate">{attach.file.name}</span>
            <span className="ml-auto text-xs text-muted">{attach.error ?? (attach.media ? "Ready · expires in 7 days" : `${Math.round(attach.progress * 100)}%`)}</span>
            <IconButton icon="close" label="Remove attachment" size={14} onClick={() => setAttach(null)} />
          </div>
        ) : null}
        <div className="flex items-end gap-2">
          <input
            ref={fileRef}
            type="file"
            hidden
            accept="image/jpeg,image/png,image/gif,image/webp,video/mp4,video/webm,video/quicktime"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (!f) return;
              const problem = validateFile(f);
              if (problem) return setAttach({ file: f, progress: 0, error: problem });
              setAttach({ file: f, progress: 0 });
              uploadMedia(f, "message", (p) => setAttach((a) => (a ? { ...a, progress: p } : a)))
                .promise.then((media) => setAttach((a) => (a ? { ...a, media } : a)))
                .catch((err) => setAttach((a) => (a ? { ...a, error: errorMessage(err) } : a)));
            }}
          />
          <IconButton icon="image" label="Attach photo or video" onClick={() => fileRef.current?.click()} />
          <Textarea
            rows={1}
            value={text}
            maxLength={MESSAGE_MAX_CHARS}
            onChange={(e) => {
              setText(e.target.value);
              if (Date.now() - lastTyping.current > 3000) {
                lastTyping.current = Date.now();
                void post(`/conversations/${id}/typing`).catch(() => undefined);
              }
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            placeholder={`Message as @${me.handle}`}
            aria-label="Message"
            className="max-h-36 flex-1"
          />
          <Button type="submit" size="sm" icon="send" loading={sending} disabled={!text.trim() && !attach?.media} aria-label="Send">
            <span className="sr-only">Send</span>
          </Button>
        </div>
      </form>
    </div>
  );
}
