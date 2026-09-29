import type { Config } from "tailwindcss";
import tailwindcssAnimate from "tailwindcss-animate";

/**
 * `content` covers the whole app and component tree so that UI copied in from
 * the 21st.dev registry generates its utilities wherever it is dropped. Before,
 * only four paths were scanned, so a pasted component outside them rendered
 * completely unstyled — the utilities were never emitted.
 *
 * Widening is safe *because* of the `important` strategy below: every generated
 * utility is prefixed with `.v2-root`, so scanning a legacy file cannot restyle
 * it. Utilities only take effect inside a `.v2-root` element, which a page opts
 * into by rendering inside `ThemeRoot` (components/theme-root.tsx) or
 * `AdminThemeRoot`. The remaining legacy pages (/report, /projects and the
 * other app/globals.css routes) render outside one and keep that styling
 * untouched.
 *
 * The only cost of the wider globs is a larger generated stylesheet.
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
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./lib/**/*.{ts,tsx}",
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
        /* Status tokens. Declared globally in app/tailwind.css. */
        success: "hsl(var(--success) / <alpha-value>)",
        warning: "hsl(var(--warning) / <alpha-value>)",
        info: "hsl(var(--info) / <alpha-value>)",
        /*
         * Chart and sidebar tokens complete the standard shadcn contract.
         * Registry chart components read `chart-1..5` and registry dashboard /
         * sidebar blocks read `sidebar-*` by name, so a paste fails without
         * them. See the dataviz guidance before using the chart ramp for a real
         * visualization — these are a starting palette, not a validated one.
         */
        chart: {
          1: "hsl(var(--chart-1) / <alpha-value>)",
          2: "hsl(var(--chart-2) / <alpha-value>)",
          3: "hsl(var(--chart-3) / <alpha-value>)",
          4: "hsl(var(--chart-4) / <alpha-value>)",
          5: "hsl(var(--chart-5) / <alpha-value>)",
        },
        sidebar: {
          DEFAULT: "hsl(var(--sidebar) / <alpha-value>)",
          foreground: "hsl(var(--sidebar-foreground) / <alpha-value>)",
          primary: "hsl(var(--sidebar-primary) / <alpha-value>)",
          "primary-foreground":
            "hsl(var(--sidebar-primary-foreground) / <alpha-value>)",
          accent: "hsl(var(--sidebar-accent) / <alpha-value>)",
          "accent-foreground":
            "hsl(var(--sidebar-accent-foreground) / <alpha-value>)",
          border: "hsl(var(--sidebar-border) / <alpha-value>)",
          ring: "hsl(var(--sidebar-ring) / <alpha-value>)",
        },
        /*
         * Inverted panels (hero side panel, final CTA). Previously written as
         * fixed `bg-brand-800` / `bg-brand-900`, which stayed the same colour in
         * dark mode and collapsed into the background.
         */
        panel: {
          DEFAULT: "hsl(var(--panel) / <alpha-value>)",
          foreground: "hsl(var(--panel-foreground) / <alpha-value>)",
          muted: "hsl(var(--panel-muted) / <alpha-value>)",
        },
        /*
         * The brand ramp stays a set of fixed hexes on purpose: it is the
         * Zypact identity scale, not a theme surface, and is referenced by the
         * logo and by brand-specific accents. Theme-following surfaces use the
         * `surface`, `panel` and shadcn tokens instead.
         */
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
        /*
         * Variable-driven rather than the previous fixed hexes, so every
         * existing `bg-surface-subtle` / `bg-surface-muted` in the marketing
         * pages follows the active theme with no markup change.
         */
        surface: {
          DEFAULT: "hsl(var(--surface) / <alpha-value>)",
          subtle: "hsl(var(--surface-subtle) / <alpha-value>)",
          muted: "hsl(var(--surface-muted) / <alpha-value>)",
        },
      },
      /*
       * `xl` and `2xl` are added because registry components routinely use
       * `rounded-xl` / `rounded-2xl` and expect them to scale with `--radius`
       * rather than sit at Tailwind's fixed defaults.
       */
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
        xl: "calc(var(--radius) + 4px)",
        "2xl": "calc(var(--radius) + 8px)",
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
  plugins: [tailwindcssAnimate],
};

export default config;
