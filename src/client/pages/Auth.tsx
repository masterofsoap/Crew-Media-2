import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { DISPLAY_NAME_MAX, PIN_MAX, PIN_MIN } from "../../shared/constants";
import { isValidHandle } from "../../shared/text";
import type { SessionInfo } from "../../shared/types";
import { ApiError, errorMessage, post } from "../lib/api";
import { useSession } from "../lib/session";
import { Button, Field, Input } from "../components/ui";
import { Icon } from "../components/Icon";
import { LogoMark } from "../components/Logo";

declare global {
  interface Window {
    turnstile?: { render: (el: HTMLElement, opts: { sitekey: string; callback: (t: string) => void; "expired-callback"?: () => void }) => string; reset: (id?: string) => void };
  }
}

/** Renders Cloudflare Turnstile only when the deployment configured a site key. */
function Turnstile({ siteKey, onToken }: { siteKey: string | null; onToken: (t: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!siteKey || !ref.current) return;
    const el = ref.current;
    const render = () => window.turnstile?.render(el, { sitekey: siteKey, callback: onToken, "expired-callback": () => onToken("") });
    if (window.turnstile) {
      render();
      return;
    }
    const s = document.createElement("script");
    s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    s.async = true;
    s.onload = render;
    document.head.appendChild(s);
  }, [siteKey, onToken]);
  if (!siteKey) return null;
  return <div ref={ref} className="min-h-[65px]" />;
}

function AuthShell({ title, subtitle, children, footer }: { title: string; subtitle: string; children: ReactNode; footer: ReactNode }) {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center px-5 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center gap-4 text-center">
          <LogoMark size={64} />
          <div>
            <h1 className="text-2xl font-extrabold">{title}</h1>
            {subtitle ? <p className="mt-1 text-sm text-muted">{subtitle}</p> : null}
          </div>
        </div>
        <div className="card space-y-5 p-6">{children}</div>
        {footer ? <div className="mt-5 text-center text-sm text-muted">{footer}</div> : null}
      </div>
    </main>
  );
}

function PinInput({ id, value, onChange, invalid, autoComplete }: { id: string; value: string; onChange: (v: string) => void; invalid?: boolean; autoComplete: string }) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <Input
        id={id}
        type={show ? "text" : "password"}
        inputMode="numeric"
        pattern="[0-9]*"
        autoComplete={autoComplete}
        maxLength={PIN_MAX}
        value={value}
        invalid={invalid}
        onChange={(e) => onChange(e.target.value.replace(/\D/g, ""))}
        className="pr-12 tracking-[0.35em]"
      />
      <button type="button" onClick={() => setShow((s) => !s)} className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1.5 text-muted hover:text-fg" aria-label={show ? "Hide PIN" : "Show PIN"}>
        <Icon name="eye" size={18} />
      </button>
    </div>
  );
}

function RecoveryCodeNotice({ code, onContinue }: { code: string; onContinue: () => void }) {
  const [saved, setSaved] = useState(false);
  return (
    <div className="space-y-4">
      <div className="card space-y-3 p-4">
        <p className="font-semibold">Save your recovery code</p>
        <p className="text-sm text-muted">If you forget your PIN, this code is the only way to recover your account yourself. It's shown once — store it somewhere safe (a password manager or a note in a secure place).</p>
        <code className="block select-all rounded-lg bg-surface2 p-3 text-center font-mono text-lg font-bold tracking-wider">{code}</code>
        <Button
          variant="secondary"
          size="sm"
          icon="link"
          onClick={() => {
            void navigator.clipboard?.writeText(code);
            setSaved(true);
          }}
        >
          Copy code
        </Button>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} className="accent-[var(--c-accent)]" />
        I've saved my recovery code
      </label>
      <Button className="w-full" size="lg" disabled={!saved} onClick={onContinue}>
        Continue
      </Button>
    </div>
  );
}

export function SignUp() {
  const { setSession, turnstileSiteKey } = useSession();
  const nav = useNavigate();
  const [displayName, setDisplayName] = useState("");
  const [handle, setHandle] = useState("");
  const [pin, setPin] = useState("");
  const [pin2, setPin2] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [recovery, setRecovery] = useState<{ code: string; session: SessionInfo } | null>(null);

  const validate = () => {
    const e: Record<string, string> = {};
    if (!displayName.trim()) e.displayName = "Enter your name.";
    if (!isValidHandle(handle)) e.handle = "3–20 letters, numbers or underscores.";
    if (pin.length < PIN_MIN) e.pin = `Use at least ${PIN_MIN} digits.`;
    if (pin !== pin2) e.pin2 = "PINs don't match.";
    setErrors(e);
    return !Object.keys(e).length;
  };

  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    if (!validate()) return;
    setBusy(true);
    try {
      const r = await post<{ session: SessionInfo; recoveryCode: string }>("/auth/register", { displayName: displayName.trim(), handle: handle.trim(), pin, turnstileToken: token || undefined });
      setRecovery({ code: r.recoveryCode, session: r.session });
    } catch (e) {
      if (e instanceof ApiError && e.code === "HANDLE_TAKEN") setErrors({ handle: e.message });
      else if (e instanceof ApiError && e.fields) setErrors(Object.fromEntries(Object.entries(e.fields).map(([k, v]) => [k, v])));
      else setErrors({ form: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  if (recovery)
    return (
      <AuthShell title="Welcome to Crew Plus" subtitle={`You're @${handle}. One important step first.`} footer={null}>
        <RecoveryCodeNotice
          code={recovery.code}
          onContinue={() => {
            setSession(recovery.session);
            nav("/onboarding");
          }}
        />
      </AuthShell>
    );

  return (
    <AuthShell title="Create your account" subtitle="Just a name, a handle and a PIN." footer={<>Already have an account? <Link to="/" className="font-semibold text-accent">Sign in</Link></>}>
      <form onSubmit={submit} className="space-y-4" noValidate>
        <Field label="Display name" id="dn" error={errors.displayName}>
          <Input id="dn" autoComplete="name" maxLength={DISPLAY_NAME_MAX} value={displayName} onChange={(e) => setDisplayName(e.target.value)} invalid={!!errors.displayName} />
        </Field>
        <Field label="Handle" id="h" error={errors.handle} hint="This is your unique @name. You can make more profiles later.">
          <div className="relative">
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted">@</span>
            <Input id="h" autoComplete="username" autoCapitalize="none" spellCheck={false} maxLength={20} value={handle} onChange={(e) => setHandle(e.target.value.replace(/[^A-Za-z0-9_]/g, ""))} className="pl-7" invalid={!!errors.handle} />
          </div>
        </Field>
        <Field label="PIN" id="pin" error={errors.pin} hint={`${PIN_MIN}–${PIN_MAX} digits. Avoid birthdays, repeats and sequences.`}>
          <PinInput id="pin" value={pin} onChange={setPin} invalid={!!errors.pin} autoComplete="new-password" />
        </Field>
        <Field label="Confirm PIN" id="pin2" error={errors.pin2}>
          <PinInput id="pin2" value={pin2} onChange={setPin2} invalid={!!errors.pin2} autoComplete="new-password" />
        </Field>
        <Turnstile siteKey={turnstileSiteKey} onToken={setToken} />
        {errors.form ? <p role="alert" className="text-sm text-danger">{errors.form}</p> : null}
        <Button type="submit" size="lg" className="w-full" loading={busy}>
          Create account
        </Button>
      </form>
    </AuthShell>
  );
}

export function SignIn() {
  const { setSession, turnstileSiteKey } = useSession();
  const nav = useNavigate();
  const [params] = useSearchParams();
  const [handle, setHandle] = useState("");
  const [pin, setPin] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    if (!handle || !pin) return setError("Enter your handle and PIN.");
    setBusy(true);
    setError(null);
    try {
      const r = await post<{ session: SessionInfo }>("/auth/login", { handle: handle.trim(), pin, turnstileToken: token || undefined });
      setSession(r.session);
      const next = params.get("next");
      nav(next && next.startsWith("/") && !next.startsWith("//") ? next : "/home", { replace: true });
    } catch (e) {
      setError(errorMessage(e));
      setPin("");
    } finally {
      setBusy(false);
    }
  };
  return (
    <AuthShell title="Sign in to Crew Plus" subtitle="Welcome back to your crew." footer={<>New here? <Link to="/signup" className="font-semibold text-accent">Create an account</Link></>}>
      <form onSubmit={submit} className="space-y-4" noValidate>
        <Field label="Handle" id="h">
          <div className="relative">
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted">@</span>
            <Input id="h" autoComplete="username" autoCapitalize="none" spellCheck={false} value={handle} onChange={(e) => setHandle(e.target.value)} className="pl-7" />
          </div>
        </Field>
        <Field label="PIN" id="pin">
          <PinInput id="pin" value={pin} onChange={setPin} autoComplete="current-password" invalid={!!error} />
        </Field>
        <Turnstile siteKey={turnstileSiteKey} onToken={setToken} />
        {error ? <p role="alert" className="text-sm text-danger">{error}</p> : null}
        <Button type="submit" size="lg" className="w-full" loading={busy}>
          Sign in
        </Button>
        <p className="text-center text-sm">
          <Link to="/recover" className="text-accent">Forgot your PIN?</Link>
        </p>
      </form>
    </AuthShell>
  );
}

export function Recover() {
  const { setSession, turnstileSiteKey } = useSession();
  const nav = useNavigate();
  const [handle, setHandle] = useState("");
  const [code, setCode] = useState("");
  const [pin, setPin] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ code: string; session: SessionInfo } | null>(null);
  if (done)
    return (
      <AuthShell title="You're back in" subtitle="Your PIN was reset and all other sessions were signed out. Here's your new recovery code." footer={null}>
        <RecoveryCodeNotice code={done.code} onContinue={() => (setSession(done.session), nav("/home"))} />
      </AuthShell>
    );
  return (
    <AuthShell
      title="Recover your account"
      subtitle="Use the recovery code you saved at sign-up, or a one-time reset code from a Crew Plus administrator."
      footer={<Link to="/" className="font-semibold text-accent">Back to sign in</Link>}
    >
      <form
        className="space-y-4"
        noValidate
        onSubmit={async (ev) => {
          ev.preventDefault();
          setBusy(true);
          setError(null);
          try {
            const r = await post<{ session: SessionInfo; recoveryCode: string }>("/auth/recover", { handle: handle.trim(), code: code.trim(), newPin: pin, turnstileToken: token || undefined });
            setDone({ code: r.recoveryCode, session: r.session });
          } catch (e) {
            setError(errorMessage(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field label="Handle" id="h">
          <Input id="h" autoCapitalize="none" value={handle} onChange={(e) => setHandle(e.target.value)} />
        </Field>
        <Field label="Recovery or reset code" id="c" hint="Looks like ABCDE-FGHJK-LMNPQ-RSTUV">
          <Input id="c" autoCapitalize="characters" spellCheck={false} value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} className="font-mono" />
        </Field>
        <Field label="New PIN" id="p" hint={`${PIN_MIN}–${PIN_MAX} digits`}>
          <PinInput id="p" value={pin} onChange={setPin} autoComplete="new-password" />
        </Field>
        <Turnstile siteKey={turnstileSiteKey} onToken={setToken} />
        {error ? <p role="alert" className="text-sm text-danger">{error}</p> : null}
        <Button type="submit" size="lg" className="w-full" loading={busy}>
          Reset PIN
        </Button>
        <p className="text-xs text-muted">Lost your code too? Ask a Crew Plus administrator to verify you in person and issue a one-time reset code. Nobody can recover an account with just a name or handle.</p>
      </form>
    </AuthShell>
  );
}
