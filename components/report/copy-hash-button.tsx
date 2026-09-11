"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";

/**
 * Copies the prompt hash so a reader can compare it against a retest.
 *
 * The full hash is always printed beside this button; copying is a
 * convenience, never the only way to read the value.
 */
export function CopyHashButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard access can be refused (insecure context, permissions).
      // The hash is still on screen to select by hand.
    }
  }

  return (
    <button
      type="button"
      className={`zpr-copy${copied ? " is-done" : ""}`}
      onClick={copy}
      aria-label={copied ? "Prompt hash copied" : "Copy prompt hash"}
      title={copied ? "Copied" : "Copy prompt hash"}
    >
      {copied ? (
        <Check size={15} strokeWidth={2.2} />
      ) : (
        <Copy size={15} strokeWidth={1.9} />
      )}
    </button>
  );
}
