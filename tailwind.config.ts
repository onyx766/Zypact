import type { Config } from "tailwindcss";

/**
 * `content` is deliberately limited to the marketing page at app/page.tsx, its
 * components, and the founder console under app/admin. Utilities only apply
 * inside a `.v2-root` element (see `important` below), so an admin page opts in
 * by rendering inside AdminThemeRoot; admin pages that do not stay on their own
 * stylesheets. The remaining legacy pages (/scan, /report, /projects) are
 * styled by app/globals.css and must not be scanned.
 */
const config: Config = {
  darkMode: ["class"],
  /**
   * app/globals.css defines generic class names that collide head-on with
   * Tailwind utilities — `.container { padding: 116px 24px }` and
   * `.grid { margin-top: 56px }` at line 178. Both tie with Tailwind on
   * specificity (0-1-0) and win on source order, which silently inflated the
   * header to 233px and offset every grid by 56px.
   *
   * The `important` selector strategy prefixes every generated utility with
   * `.v2-root`, lifting them to 0-2-0 so they beat the legacy rules — while
   * keeping them scoped to this route tree. Do not remove without also
   * removing those legacy rules.
   */
  important: ".v2-root",
  content: [
    "./app/page.tsx",
    "./components/ui/**/*.{ts,tsx}",
    "./components/marketing/**/*.{ts,tsx}",
    "./app/admin/**/*.{ts,tsx}",
  ],
  corePlugins: {
    // Preflight is applied manually and scoped to .v2-root in app/tailwind.css
    // so it cannot leak into the legacy stylesheets loaded by the root layout.
    preflight: false,
  },
  theme: {
    /**
     * Tailwind's `container` is deliberately NOT used. It is emitted as a
     * *component*, and the `important` selector strategy only scopes
     * *utilities* — so `.container` would stay at 0-1-0 and keep losing to
     * `.container { padding: 116px 24px }` in app/globals.css. Use the
     * `.shell` class defined in app/tailwind.css instead.
     */
    extend: {
      colors: {
        /*
         * `<alpha-value>` lets opacity modifiers (`bg-success/10`) work on
         * the token colours. Without a modifier it resolves to 1, so every
         * existing class renders exactly as before.
         */
        border: "hsl(var(--border) / <alpha-value>)",
        input: "hsl(var(--input) / <alpha-value>)",
        ring: "hsl(var(--ring) / <alpha-value>)",
        background: "hsl(var(--background) / <alpha-value>)",
        foreground: "hsl(var(--foreground) / <alpha-value>)",
        primary: {
          DEFAULT: "hsl(var(--primary) / <alpha-value>)",
          foreground: "hsl(var(--primary-foreground) / <alpha-value>)",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary) / <alpha-value>)",
          foreground: "hsl(var(--secondary-foreground) / <alpha-value>)",
        },
        muted: {
          DEFAULT: "hsl(var(--muted) / <alpha-value>)",
          foreground: "hsl(var(--muted-foreground) / <alpha-value>)",
        },
        accent: {
          DEFAULT: "hsl(var(--accent) / <alpha-value>)",
          foreground: "hsl(var(--accent-foreground) / <alpha-value>)",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive) / <alpha-value>)",
          foreground: "hsl(var(--destructive-foreground) / <alpha-value>)",
        },
        card: {
          DEFAULT: "hsl(var(--card) / <alpha-value>)",
          foreground: "hsl(var(--card-foreground) / <alpha-value>)",
        },
        popover: {
          DEFAULT: "hsl(var(--popover) / <alpha-value>)",
          foreground: "hsl(var(--popover-foreground) / <alpha-value>)",
        },
        /* Status tokens, defined by the founder console theme only. */
        success: "hsl(var(--success) / <alpha-value>)",
        warning: "hsl(var(--warning) / <alpha-value>)",
        info: "hsl(var(--info) / <alpha-value>)",
        brand: {
          50: "#F2F8F5",
          100: "#E3F0EA",
          200: "#C6E1D5",
          300: "#96C7B2",
          400: "#5FA88C",
          500: "#2F8467",
          600: "#166B51",
          700: "#0E4A38",
          800: "#0A3527",
          900: "#07291E",
          950: "#041B14",
        },
        surface: {
          DEFAULT: "#FFFFFF",
          subtle: "#FAFBFA",
          muted: "#F5F8F6",
        },
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      fontFamily: {
        sans: [
          "Inter",
          "-apple-system",
          "BlinkMacSystemFont",
          "Segoe UI",
          "Roboto",
          "sans-serif",
        ],
      },
      letterSpacing: {
        tightest: "-0.045em",
      },
      boxShadow: {
        card: "0 1px 2px rgba(7, 41, 30, 0.04)",
        float: "0 24px 60px -20px rgba(7, 41, 30, 0.22)",
      },
      keyframes: {
        "accordion-down": {
          from: { height: "0" },
          to: { height: "var(--radix-accordion-content-height)" },
        },
        "accordion-up": {
          from: { height: "var(--radix-accordion-content-height)" },
          to: { height: "0" },
        },
      },
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
      },
    },
  },
  plugins: [require("tailwindcss-animate")],
};

export default config;
