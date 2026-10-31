import { forwardRef, useEffect, useId, useRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from "react";
import { Icon } from "./Icon";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md" | "lg";

export const Button = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size; loading?: boolean; icon?: string }>(
  function Button({ variant = "primary", size = "md", loading, icon, className = "", children, disabled, ...rest }, ref) {
    const pad = size === "sm" ? "px-3 py-1.5 text-sm" : size === "lg" ? "px-6 py-3 text-base" : "px-4 py-2 text-[0.95rem]";
    return (
      <button ref={ref} className={`btn btn-${variant} ${pad} ${className}`} disabled={disabled || loading} aria-busy={loading || undefined} {...rest}>
        {loading ? <Spinner size={16} /> : icon ? <Icon name={icon} size={size === "sm" ? 16 : 18} /> : null}
        {children}
      </button>
    );
  },
);

export function IconButton({ icon, label, active, className = "", size = 20, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { icon: string; label: string; active?: boolean; size?: number }) {
  return (
    <button type="button" aria-label={label} title={label} className={`btn btn-ghost p-2 rounded-full ${active ? "text-accent" : ""} ${className}`} {...rest}>
      <Icon name={icon} size={size} />
    </button>
  );
}

export function Spinner({ size = 20, label }: { size?: number; label?: string }) {
  return (
    <span role={label ? "status" : undefined} className="inline-flex items-center gap-2">
      <svg className="spin" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" fill="none" />
        <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" fill="none" strokeLinecap="round" />
      </svg>
      {label ? <span className="sr-only">{label}</span> : null}
    </span>
  );
}

export function Field({ label, error, hint, children, id }: { label: string; error?: string; hint?: ReactNode; children: ReactNode; id?: string }) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-semibold">
        {label}
      </label>
      {children}
      {error ? (
        <p className="text-sm text-danger" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p className="text-xs text-muted">{hint}</p>
      ) : null}
    </div>
  );
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }>(function Input({ invalid, className = "", ...rest }, ref) {
  return <input ref={ref} className={`input ${className}`} aria-invalid={invalid || undefined} {...rest} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }>(function Textarea({ invalid, className = "", ...rest }, ref) {
  return <textarea ref={ref} className={`input resize-none ${className}`} aria-invalid={invalid || undefined} {...rest} />;
});

export function Toggle({ checked, onChange, label, description, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; description?: string; disabled?: boolean }) {
  const id = useId();
  return (
    <div className="flex items-start justify-between gap-4 py-2">
      <label htmlFor={id} className="min-w-0">
        <span className="block font-semibold">{label}</span>
        {description ? <span className="block text-sm text-muted">{description}</span> : null}
      </label>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`relative mt-1 h-6 w-11 shrink-0 rounded-full transition-colors ${checked ? "bg-accent" : "bg-surface2 border border-line"}`}
      >
        <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${checked ? "translate-x-5" : "translate-x-0.5"}`} />
      </button>
    </div>
  );
}

export function Card({ children, className = "", as: As = "div" }: { children: ReactNode; className?: string; as?: "div" | "section" | "article" | "aside" }) {
  return <As className={`card ${className}`}>{children}</As>;
}

export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`skeleton ${className}`} aria-hidden="true" />;
}

export function PostSkeleton() {
  return (
    <div className="flex gap-3 p-4" aria-hidden="true">
      <Skeleton className="h-11 w-11 rounded-full" />
      <div className="flex-1 space-y-2">
        <Skeleton className="h-3 w-40" />
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-2/3" />
      </div>
    </div>
  );
}

export function EmptyState({ icon = "sparkle", title, children, action }: { icon?: string; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-14 text-center">
      <div className="grid h-14 w-14 place-items-center rounded-full bg-surface2 text-accent">
        <Icon name={icon} size={26} />
      </div>
      <h3 className="text-lg font-bold">{title}</h3>
      {children ? <div className="max-w-sm text-sm text-muted">{children}</div> : null}
      {action}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const msg = error instanceof Error ? error.message : "Something went wrong.";
  return (
    <div role="alert" className="flex flex-col items-center gap-3 px-6 py-12 text-center">
      <div className="grid h-12 w-12 place-items-center rounded-full bg-surface2 text-danger">
        <Icon name="flag" size={22} />
      </div>
      <p className="max-w-sm text-sm text-muted">{msg}</p>
      {onRetry ? (
        <Button variant="secondary" size="sm" onClick={onRetry} icon="reset">
          Try again
        </Button>
      ) : null}
    </div>
  );
}

/** Accessible modal dialog with focus trap-lite, Escape to close and scroll lock. */
export function Dialog({ open, onClose, title, children, wide }: { open: boolean; onClose: () => void; title: string; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "Tab" && ref.current) {
        const f = ref.current.querySelectorAll<HTMLElement>('button, [href], input, textarea, select, [tabindex]:not([tabindex="-1"])');
        if (!f.length) return;
        const first = f[0]!;
        const last = f[f.length - 1]!;
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    setTimeout(() => ref.current?.querySelector<HTMLElement>("input, textarea, button:not([aria-label='Close'])")?.focus(), 10);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
      prev?.focus?.();
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/55 p-0 sm:items-center sm:p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby={titleId} className={`card animate-rise max-h-[92dvh] w-full overflow-y-auto rounded-b-none sm:rounded-b-[var(--t-radius-card)] ${wide ? "sm:max-w-2xl" : "sm:max-w-md"}`}>
        <div className="sticky top-0 z-10 flex items-center justify-between border-b divider bg-surface px-4 py-3">
          <h2 id={titleId} className="text-lg font-bold">
            {title}
          </h2>
          <IconButton icon="close" label="Close" onClick={onClose} />
        </div>
        <div className="p-4">{children}</div>
      </div>
    </div>
  );
}

export function ConfirmDialog({ open, title, body, confirmLabel = "Confirm", danger, busy, onConfirm, onClose }: { open: boolean; title: string; body: ReactNode; confirmLabel?: string; danger?: boolean; busy?: boolean; onConfirm: () => void; onClose: () => void }) {
  return (
    <Dialog open={open} onClose={onClose} title={title}>
      <div className="space-y-5">
        <div className="text-muted">{body}</div>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant={danger ? "danger" : "primary"} loading={busy} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange, label }: { tabs: { id: T; label: string; badge?: number }[]; value: T; onChange: (v: T) => void; label: string }) {
  return (
    <div role="tablist" aria-label={label} className="flex overflow-x-auto border-b divider scrollbar-none">
      {tabs.map((t) => (
        <button
          key={t.id}
          role="tab"
          type="button"
          aria-selected={value === t.id}
          onClick={() => onChange(t.id)}
          className={`relative flex-1 whitespace-nowrap px-4 py-3.5 text-sm font-semibold transition-colors hover:bg-surface2/60 ${value === t.id ? "text-fg" : "text-muted"}`}
        >
          {t.label}
          {t.badge ? <span className="chip ml-1.5">{t.badge}</span> : null}
          {value === t.id ? <span className="absolute inset-x-1/4 bottom-0 h-1 rounded-full bg-accent" /> : null}
        </button>
      ))}
    </div>
  );
}

export function PageHeader({ title, subtitle, back, actions }: { title: ReactNode; subtitle?: ReactNode; back?: () => void; actions?: ReactNode }) {
  return (
    <header className="sticky top-0 z-20 flex items-center gap-3 border-b divider bg-[color-mix(in_srgb,var(--c-bg)_80%,transparent)] px-4 py-2.5 backdrop-blur-md">
      {back ? <IconButton icon="back" label="Back" onClick={back} /> : null}
      <div className="min-w-0 flex-1">
        <h1 className="truncate text-xl font-extrabold">{title}</h1>
        {subtitle ? <p className="truncate text-xs text-muted">{subtitle}</p> : null}
      </div>
      {actions}
    </header>
  );
}

export function Slider({ value, min, max, step = 1, onChange, label, suffix = "", id }: { value: number; min: number; max: number; step?: number; onChange: (v: number) => void; label: string; suffix?: string; id?: string }) {
  const autoId = useId();
  const fid = id ?? autoId;
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-sm">
        <label htmlFor={fid} className="font-semibold">
          {label}
        </label>
        <output htmlFor={fid} className="tabular-nums text-muted">
          {value}
          {suffix}
        </output>
      </div>
      <input id={fid} type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} className="w-full accent-[var(--c-accent)]" />
    </div>
  );
}
