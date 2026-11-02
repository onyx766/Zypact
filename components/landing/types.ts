import type { LucideIcon } from "lucide-react";

import type { OutcomeStatus } from "@/lib/reports/compare-protocols";

/**
 * Prop shapes shared by the landing sections. Copy lives in app/page.tsx,
 * where the landing guard test can read it; components only lay it out.
 */

export interface LandingLink {
  label: string;
  href: string;
}

/** A titled line of copy with an icon: feature cards, steps, columns. */
export interface IconCopy {
  title: string;
  copy: string;
  icon: LucideIcon;
}

export interface SectionCopy {
  /** Anchor id. Several are guarded by scripts/test-landing-page.ts. */
  id: string;
  eyebrow: string;
  title: string;
  lede: string;
}

export interface OutcomeCopy {
  /** Display label, e.g. "Increase observed". Guarded verbatim. */
  label: string;
  /** The Outcome Card enum value it maps to. */
  code: OutcomeStatus;
  /** Front face: what the result means. */
  copy: string;
  /** Back face: how the implemented rule decides it. Detail, not disclosure. */
  rule: string;
  icon: LucideIcon;
}

export interface ScopeNote {
  label: string;
  title: string;
  copy: string;
}

export interface ContactPerson {
  name: string;
  role: string;
  email: string;
}

export interface FooterColumn {
  heading: string;
  links: readonly LandingLink[];
}
