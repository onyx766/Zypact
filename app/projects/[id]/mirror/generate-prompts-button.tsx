"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

interface Props {
  projectId: string;
  /** True when at least one generated prompt is already stored for this project. */
  hasExistingPrompts: boolean;
}

export function GeneratePromptsButton({ projectId, hasExistingPrompts }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onClick() {
    setError(null);
    setBusy(true);
    try {
      const res = await fetch("/api/projects/generate-buyer-prompts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId }),
      });
      const json = (await res.json()) as { ok: boolean; error?: string };
      if (!json.ok) {
        setError(json.error ?? "Unknown error");
        setBusy(false);
        return;
      }
      router.push(`/projects/${projectId}/prompts`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <div style={{ marginTop: 8 }}>
      <button type="button" onClick={onClick} disabled={busy}>
        {busy
          ? "Generating 50 buyer prompts…"
          : hasExistingPrompts
            ? "Regenerate Buyer Prompts"
            : "Generate Buyer Prompts"}
      </button>
      {hasExistingPrompts && (
        <>
          {" "}
          <a href={`/projects/${projectId}/prompts`}>View existing prompts →</a>
        </>
      )}
      {error && (
        <p className="error" style={{ marginTop: 8 }}>
          Error: {error}
        </p>
      )}
    </div>
  );
}
