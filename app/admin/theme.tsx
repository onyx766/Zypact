"use client";

import {
  createContext,
  useContext,
  useState,
  type ReactNode,
} from "react";
import { Moon, Sun } from "lucide-react";

import { cn } from "@/lib/utils";
import { ADMIN_THEME_COOKIE, type AdminTheme } from "./theme-shared";

import "../tailwind.css";
import "./admin-theme.css";

/**
 * Tailwind + light/dark theme root for founder console pages.
 *
 * The outer `.v2-root` is what Tailwind's `important` selector strategy keys
 * on, so utilities only exist beneath it. The inner `.zp-admin` carries the
 * theme tokens. The choice is persisted in a cookie the server page reads, so
 * a reload renders the chosen theme on first paint instead of flashing.
 */

const ThemeContext = createContext<{
  theme: AdminTheme;
  toggle: () => void;
} | null>(null);

export function AdminThemeRoot({
  initialTheme,
  children,
}: {
  initialTheme: AdminTheme;
  children: ReactNode;
}) {
  const [theme, setTheme] = useState<AdminTheme>(initialTheme);

  function toggle() {
    const next: AdminTheme = theme === "dark" ? "light" : "dark";
    setTheme(next);
    document.cookie = `${ADMIN_THEME_COOKIE}=${next}; path=/admin; max-age=31536000; samesite=lax`;
  }

  return (
    <ThemeContext.Provider value={{ theme, toggle }}>
      <div className="v2-root">
        <div
          className={cn(
            "zp-admin flex min-h-screen flex-col bg-background text-foreground antialiased",
            theme === "dark" && "dark"
          )}
        >
          {children}
        </div>
      </div>
    </ThemeContext.Provider>
  );
}

export function ThemeToggle() {
  const context = useContext(ThemeContext);
  if (!context) return null;

  const dark = context.theme === "dark";
  const label = dark ? "Switch to light theme" : "Switch to dark theme";

  return (
    <button
      type="button"
      onClick={context.toggle}
      aria-label={label}
      title={label}
      className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-border bg-card text-muted-foreground transition-colors hover:text-foreground"
    >
      {dark ? <Sun size={16} strokeWidth={2} /> : <Moon size={16} strokeWidth={2} />}
    </button>
  );
}
