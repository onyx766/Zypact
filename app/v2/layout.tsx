import type { Metadata } from "next";
import type { ReactNode } from "react";

import "./tailwind.css";

export const metadata: Metadata = {
  title: "Zypact — Evidence-backed buyer-question diagnostic",
  description:
    "Zypact records how Perplexity answers one commercially important buyer question, preserves the exact evidence, and retests the same question after one registered change.",
  robots: { index: false, follow: false },
};

export default function V2Layout({ children }: { children: ReactNode }) {
  return <div className="v2-root">{children}</div>;
}
