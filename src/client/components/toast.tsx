import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import { Icon } from "./Icon";

interface Toast {
  id: number;
  kind: "success" | "error" | "info";
  text: string;
}

const Ctx = createContext<(text: string, kind?: Toast["kind"]) => void>(() => undefined);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((text: string, kind: Toast["kind"] = "success") => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-3), { id, kind, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === "error" ? 6000 : 3500);
  }, []);
  return (
    <Ctx.Provider value={push}>
      {children}
      <div aria-live="polite" role="status" className="pointer-events-none fixed inset-x-0 bottom-20 z-[60] flex flex-col items-center gap-2 px-4 lg:bottom-6">
        {toasts.map((t) => (
          <div key={t.id} className={`card animate-rise pointer-events-auto flex max-w-md items-center gap-2 px-4 py-3 text-sm font-semibold ${t.kind === "error" ? "text-danger" : ""}`}>
            <Icon name={t.kind === "error" ? "flag" : t.kind === "info" ? "sparkle" : "check"} size={18} className={t.kind === "success" ? "text-success" : undefined} />
            <span className="text-fg">{t.text}</span>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export const useToast = () => useContext(Ctx);
