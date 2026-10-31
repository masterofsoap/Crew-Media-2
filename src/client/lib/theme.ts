import { getTheme, themeCssVars } from "../../shared/themes";

/** Apply a theme's tokens to <html>. Components only consume the resulting CSS variables. */
export function applyTheme(themeId: string | null | undefined, motion: "full" | "reduced" = getMotionPref()) {
  const t = getTheme(themeId);
  const root = document.documentElement;
  for (const [k, v] of Object.entries(themeCssVars(t))) root.style.setProperty(k, v);
  root.dataset.surface = t.surfaceEffect;
  root.dataset.ambient = t.ambient ?? "none";
  root.dataset.motion = motion;
  root.style.colorScheme = t.mode;
}

export function getMotionPref(): "full" | "reduced" {
  try {
    return localStorage.getItem("crew:motion") === "reduced" ? "reduced" : "full";
  } catch {
    return "full";
  }
}

export function setMotionPref(v: "full" | "reduced") {
  localStorage.setItem("crew:motion", v);
  document.documentElement.dataset.motion = v;
}
