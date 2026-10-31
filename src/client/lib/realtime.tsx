import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { MessageView, Page, RealtimeEvent } from "../../shared/types";
import { useSession } from "./session";

interface RealtimeCtx {
  connected: boolean;
  typing: Record<string, { profileId: string; at: number }[]>;
}

const Ctx = createContext<RealtimeCtx>({ connected: false, typing: {} });

/**
 * One WebSocket per active profile (reconnects on profile switch). Events only ever trigger cache
 * updates or refetches through the authenticated HTTP API; the socket carries no authority.
 */
export function RealtimeProvider({ children }: { children: ReactNode }) {
  const { session } = useSession();
  const qc = useQueryClient();
  const [connected, setConnected] = useState(false);
  const [typing, setTyping] = useState<RealtimeCtx["typing"]>({});
  const retry = useRef(0);
  const profileId = session?.activeProfileId;

  useEffect(() => {
    if (!profileId) return;
    let ws: WebSocket | null = null;
    let closed = false;
    let ping: ReturnType<typeof setInterval> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const connect = () => {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      ws = new WebSocket(`${proto}://${location.host}/api/realtime`);
      ws.onopen = () => {
        retry.current = 0;
        setConnected(true);
        ping = setInterval(() => ws?.readyState === WebSocket.OPEN && ws.send("ping"), 25_000);
      };
      ws.onmessage = (e) => {
        if (e.data === "pong") return;
        let ev: RealtimeEvent;
        try {
          ev = JSON.parse(String(e.data)) as RealtimeEvent;
        } catch {
          return;
        }
        if (ev.type === "notification") {
          void qc.invalidateQueries({ queryKey: ["notifications"] });
          void qc.invalidateQueries({ queryKey: ["session"] });
        } else if (ev.type === "message" && ev.conversationId) {
          const msg = ev.payload as MessageView;
          qc.setQueryData<{ pages: Page<MessageView>[]; pageParams: unknown[] }>(["messages", ev.conversationId], (old) => {
            if (!old || !old.pages[0]) return old;
            if (old.pages.some((p) => p.items.some((m) => m.id === msg.id))) return old;
            const [first, ...rest] = old.pages;
            return { ...old, pages: [{ ...first, items: [msg, ...first.items] }, ...rest] };
          });
          setTyping((t) => ({ ...t, [ev.conversationId!]: (t[ev.conversationId!] ?? []).filter((x) => x.profileId !== msg.sender.id) }));
          void qc.invalidateQueries({ queryKey: ["conversations"] });
          void qc.invalidateQueries({ queryKey: ["session"] });
        } else if (ev.type === "message_deleted" && ev.conversationId) {
          void qc.invalidateQueries({ queryKey: ["messages", ev.conversationId] });
        } else if (ev.type === "read" && ev.conversationId) {
          void qc.invalidateQueries({ queryKey: ["conversation", ev.conversationId] });
        } else if (ev.type === "typing" && ev.conversationId && ev.profileId) {
          const cid = ev.conversationId;
          const pid = ev.profileId;
          setTyping((t) => ({ ...t, [cid]: [...(t[cid] ?? []).filter((x) => x.profileId !== pid), { profileId: pid, at: Date.now() }] }));
        }
      };
      ws.onclose = () => {
        setConnected(false);
        if (ping) clearInterval(ping);
        if (closed) return;
        const delay = Math.min(30_000, 1000 * 2 ** retry.current++);
        timer = setTimeout(connect, delay);
      };
    };
    connect();
    // Expire stale typing indicators.
    const sweep = setInterval(() => {
      setTyping((t) => {
        const now = Date.now();
        const next: RealtimeCtx["typing"] = {};
        for (const [k, v] of Object.entries(t)) {
          const live = v.filter((x) => now - x.at < 6000);
          if (live.length) next[k] = live;
        }
        return next;
      });
    }, 2000);
    return () => {
      closed = true;
      if (timer) clearTimeout(timer);
      if (ping) clearInterval(ping);
      clearInterval(sweep);
      ws?.close();
    };
  }, [profileId, qc]);

  return <Ctx.Provider value={{ connected, typing }}>{children}</Ctx.Provider>;
}

export const useRealtime = () => useContext(Ctx);
