import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import "./landing-v1.css";
/**
 * Tailwind for the marketing page and the founder console. Every utility is
 * scoped under `.v2-root` by the `important` strategy in tailwind.config.ts, so
 * loading it here cannot restyle /scan, /report or /projects. It lives in the
 * root layout rather than app/page.tsx so the page module stays importable by
 * scripts/test-landing-page.ts, which cannot require a stylesheet.
 */
import "./tailwind.css";
/**
 * The landing page's own stylesheets. Imported here, not from the page, for
 * the same reason as tailwind.css above; every selector in them is scoped
 * under `.lx`, which only app/page.tsx renders, so no other route is touched.
 */
import "@/components/landing/styles/base.css";
import "@/components/landing/styles/hero.css";
import "@/components/landing/styles/story.css";
import "@/components/landing/styles/evidence.css";
import "@/components/landing/styles/outcomes.css";
import "@/components/landing/styles/chrome.css";

import { Newsreader } from "next/font/google";

import { CANONICAL_SITE_URL } from "@/lib/seo/site";

/**
 * Display serif for the landing headlines, self-hosted by next/font. It only
 * defines `--font-display` on <html>; nothing reads that variable outside the
 * `.lx` landing scope, so other routes render exactly as before.
 */
const display = Newsreader({
  subsets: ["latin"],
  style: ["normal"],
  variable: "--font-display",
  display: "swap",
});

/**
 * Site-wide defaults for every page that does not state its own.
 *
 * `metadataBase` is what lets a page write `canonical: "/scan"` and have it
 * resolve to the one canonical origin, so no page can accidentally emit a
 * canonical on the wrong host.
 *
 * `alternates` is deliberately NOT set here. Metadata is inherited by child
 * routes, so a canonical declared at the root would tell Google that every
 * un-overridden page — including private ones — is really the homepage.
 * Canonicals belong to the individual public pages (`/`, `/scan`).
 *
 * The title template gives untitled internal routes a real name instead of
 * shipping with none. Pages that own their full title set `title.absolute`.
 */
export const metadata: Metadata = {
  metadataBase: new URL(CANONICAL_SITE_URL),
  title: {
    default:
      "Zypact — Evidence-backed buyer-question diagnostic for B2B SaaS",
    template: "%s — Zypact",
  },
  description:
    "Zypact fixes one commercially important buyer question and a bounded Perplexity protocol before any paid call, preserves the exact evidence, and retests the same question after one registered change.",
  applicationName: "Zypact",
  openGraph: {
    siteName: "Zypact",
    type: "website",
    url: CANONICAL_SITE_URL,
  },
  robots: {
    index: true,
    follow: true,
    googleBot: { index: true, follow: true },
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={display.variable}>
      <body>{children}</body>
    </html>
  );
}
