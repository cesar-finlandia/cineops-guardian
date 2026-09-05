// CineOps Guardian — prominent dark/light toggle (visual identity §3, §8.1).
// Persists to localStorage "cineops-theme", defaults to "cineops-dark".
// Operates purely on documentElement data-theme; never touches chassis theme.ts.
import type { JSX } from "react";
import { useCallback, useEffect, useState } from "react";

export type CineOpsTheme = "cineops-dark" | "cineops-light";

const STORAGE_KEY = "cineops-theme";

export function getInitialTheme(): CineOpsTheme {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === "cineops-light" || stored === "cineops-dark") return stored;
  } catch {
    /* storage unavailable — fall through to default */
  }
  return "cineops-dark";
}

export function applyTheme(theme: CineOpsTheme): void {
  document.documentElement.setAttribute("data-theme", theme);
  try {
    window.localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    /* ignore */
  }
}

function SunIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </svg>
  );
}

function MoonIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
      <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
    </svg>
  );
}

export function ThemeToggle(): JSX.Element {
  const [theme, setTheme] = useState<CineOpsTheme>("cineops-dark");

  useEffect(() => {
    setTheme(getInitialTheme());
  }, []);

  const toggle = useCallback(() => {
    setTheme((prev) => {
      const next: CineOpsTheme = prev === "cineops-dark" ? "cineops-light" : "cineops-dark";
      applyTheme(next);
      return next;
    });
  }, []);

  const isDark = theme === "cineops-dark";
  return (
    <button
      type="button"
      className="cg-theme-toggle"
      data-testid="theme-toggle"
      aria-pressed={isDark ? "false" : "true"}
      aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
      title={isDark ? "Switch to Dailies Daylight" : "Switch to Cutting-Room Noir"}
      onClick={toggle}
    >
      <span className="cg-theme-toggle-track">
        <span className="cg-theme-toggle-thumb">{isDark ? <MoonIcon /> : <SunIcon />}</span>
        <span className="cg-theme-toggle-label">{isDark ? "Noir" : "Daylight"}</span>
      </span>
    </button>
  );
}
