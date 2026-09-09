import type { Config } from "tailwindcss";

/**
 * `content` is deliberately limited to the v2 route tree and its components.
 * The legacy pages (/, /admin, /scan, /report, /projects) are styled by
 * app/globals.css and app/landing-v1.css and must not be scanned or reset.
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
    "./app/v2/**/*.{ts,tsx}",
    "./components/ui/**/*.{ts,tsx}",
    "./components/v2/**/*.{ts,tsx}",
  ],
  corePlugins: {
    // Preflight is applied manually and scoped to .v2-root in app/v2/tailwind.css
    // so it cannot leak into the legacy stylesheets loaded by the root layout.
    preflight: false,
  },
  theme: {
    /**
     * Tailwind's `container` is deliberately NOT used. It is emitted as a
     * *component*, and the `important` selector strategy only scopes
     * *utilities* — so `.container` would stay at 0-1-0 and keep losing to
     * `.container { padding: 116px 24px }` in app/globals.css. Use the
     * `.shell` class defined in app/v2/tailwind.css instead.
     */
    extend: {
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
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
