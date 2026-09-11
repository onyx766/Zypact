"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * Copies a stored value (report text, a hash) to the clipboard.
 *
 * The value is always rendered on the page as well; copying is a convenience,
 * never the only way to read it.
 */
export function CopyButton({
  value,
  label,
}: {
  value: string;
  label: string;
}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard access can be refused (insecure context, permissions).
      // The value is still on screen to select by hand.
    }
  }

  return (
    <button
      type="button"
      onClick={copy}
      aria-label={copied ? "Copied" : label}
      title={copied ? "Copied" : label}
      className={cn(
        "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border bg-card text-muted-foreground transition-colors hover:text-foreground",
        copied && "text-success hover:text-success"
      )}
    >
      {copied ? (
        <Check size={14} strokeWidth={2.4} />
      ) : (
        <Copy size={14} strokeWidth={2} />
      )}
    </button>
  );
}
