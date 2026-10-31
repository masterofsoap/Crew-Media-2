import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { FONTS, THEMES, themeCssVars, type ThemeDef } from "../../shared/themes";
import { errorMessage } from "../lib/api";
import { useActive, useSession } from "../lib/session";
import { applyTheme } from "../lib/theme";
import { saveTheme } from "./Onboarding";
import { Button, PageHeader } from "../components/ui";
import { Icon } from "../components/Icon";
import { useToast } from "../components/toast";

/** A live miniature of a theme: rendered with that theme's own tokens, independent of the page theme. */
export function ThemeCard({ theme, selected, onSelect }: { theme: ThemeDef; selected: boolean; onSelect: () => void }) {
  const vars = themeCssVars(theme) as React.CSSProperties;
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      aria-label={`${theme.name} theme`}
      style={vars}
      className={`group relative overflow-hidden rounded-2xl border-2 text-left transition-transform hover:-translate-y-0.5 ${selected ? "border-[var(--c-accent)]" : "border-transparent"}`}
    >
      <div className="relative h-36 overflow-hidden" style={{ backgroundColor: theme.tokens.bg, backgroundImage: "var(--t-backdrop)", backgroundSize: "var(--t-backdrop-size)" }} data-surface={theme.surfaceEffect}>
        <div className="absolute inset-x-3 top-3 space-y-2">
          <div className="card flex items-center gap-2 p-2" data-surface={theme.surfaceEffect}>
            <span className="h-6 w-6 rounded-full" style={{ background: `linear-gradient(135deg, ${theme.tokens.accent}, ${theme.tokens.accent2})` }} />
            <span className="flex-1 space-y-1">
              <span className="block h-1.5 w-16 rounded" style={{ background: theme.tokens.text, opacity: 0.85 }} />
              <span className="block h-1.5 w-10 rounded" style={{ background: theme.tokens.muted }} />
            </span>
          </div>
          <div className="flex gap-1.5">
            <span className="btn btn-primary px-2.5 py-1 text-[10px]">Follow</span>
            <span className="btn btn-secondary px-2.5 py-1 text-[10px]">Message</span>
          </div>
        </div>
      </div>
      <div className="space-y-0.5 p-3" style={{ background: theme.tokens.surface, color: theme.tokens.text }}>
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-sm font-bold" style={{ fontFamily: FONTS[theme.headingFont].stack, letterSpacing: theme.headingTracking, textTransform: theme.headingCase }}>
            {theme.name}
          </span>
          {selected ? <Icon name="check" size={16} style={{ color: theme.tokens.accent }} /> : null}
        </div>
        <span className="line-clamp-2 block text-[11px]" style={{ color: theme.tokens.muted }}>
          {theme.description}
        </span>
      </div>
    </button>
  );
}

export function ThemesPage() {
  const active = useActive();
  const { refresh } = useSession();
  const nav = useNavigate();
  const toast = useToast();
  const [picked, setPicked] = useState(active.themeId);
  const [busy, setBusy] = useState(false);
  return (
    <div>
      <PageHeader
        title="Themes"
        subtitle={`20 themes · applies to @${active.handle} only`}
        back={() => nav(-1)}
        actions={
          <Button
            size="sm"
            disabled={picked === active.themeId}
            loading={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await saveTheme(active.handle, picked);
                await refresh();
                toast("Theme saved");
              } catch (e) {
                toast(errorMessage(e), "error");
              } finally {
                setBusy(false);
              }
            }}
          >
            Apply
          </Button>
        }
      />
      <p className="px-4 pt-3 text-sm text-muted">
        Preview any theme instantly — it's applied across the app while you browse. For deeper control, open the{" "}
        <Link to="/studio" className="text-accent">
          Customize studio
        </Link>
        .
      </p>
      <div className="grid grid-cols-2 gap-3 p-4 sm:grid-cols-3">
        {THEMES.map((t) => (
          <ThemeCard
            key={t.id}
            theme={t}
            selected={picked === t.id}
            onSelect={() => {
              setPicked(t.id);
              applyTheme(t.id);
            }}
          />
        ))}
      </div>
    </div>
  );
}
