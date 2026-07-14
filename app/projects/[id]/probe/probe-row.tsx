"use client";

import { useState } from "react";
import type {
  ProbeAnalysisOutput,
  Platform,
} from "@/lib/schemas/probe-analysis.schema";

interface Props {
  projectId: string;
  generatedPromptId: string;
  prompt: string;
  intentType: string;
  priority: number;
}

const PLATFORMS: Platform[] = ["perplexity", "chatgpt", "gemini"];

export function ProbeRow({
  projectId,
  generatedPromptId,
  prompt,
  intentType,
  priority,
}: Props) {
  const [platform, setPlatform] = useState<Platform>("perplexity");
  const [rawResponse, setRawResponse] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ProbeAnalysisOutput | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await fetch("/api/projects/analyze-probe-response", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectId,
          generatedPromptId,
          prompt,
          platform,
          rawResponse,
        }),
      });
      const json = (await res.json()) as {
        ok: boolean;
        error?: string;
        result?: { verdict: string } & Record<string, unknown>;
      };
      if (!json.ok || !json.result) {
        setError(json.error ?? "Unknown error");
        setBusy(false);
        return;
      }
      const r = json.result as unknown as {
        prompt: string;
        platform: Platform;
        clientMentioned: boolean;
        clientPosition: ProbeAnalysisOutput["clientPosition"];
        competitorsMentioned: ProbeAnalysisOutput["competitorsMentioned"];
        sourcesCited: ProbeAnalysisOutput["sourcesCited"];
        answerSummary: string;
        verdict: ProbeAnalysisOutput["verdict"];
        whyClientLost: string;
      };
      setResult({
        prompt: r.prompt,
        platform: r.platform,
        clientMentioned: r.clientMentioned,
        clientPosition: r.clientPosition,
        competitorsMentioned: r.competitorsMentioned,
        sourcesCited: r.sourcesCited,
        answerSummary: r.answerSummary,
        verdict: r.verdict,
        whyClientLost: r.whyClientLost,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="section" style={{ marginTop: 12 }}>
      <div style={{ marginBottom: 8 }}>
        <span className="badge">{intentType}</span>{" "}
        <span className="badge">priority {priority}</span>
        <div style={{ marginTop: 4 }}>
          <strong>Prompt:</strong> {prompt}
        </div>
      </div>

      <form onSubmit={onSubmit}>
        <label>Platform</label>
        <select
          value={platform}
          onChange={(e) => setPlatform(e.target.value as Platform)}
          style={{ padding: 6, font: "inherit" }}
        >
          {PLATFORMS.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>

        <label style={{ marginTop: 8 }}>Raw AI answer</label>
        <textarea
          value={rawResponse}
          onChange={(e) => setRawResponse(e.target.value)}
          rows={8}
          placeholder="Paste the AI answer here…"
          style={{
            width: "100%",
            padding: 8,
            font: "inherit",
            border: "1px solid #999",
            background: "white",
          }}
        />
        <button type="submit" disabled={busy || rawResponse.trim().length === 0}>
          {busy ? "Analyzing…" : "Analyze Response"}
        </button>
      </form>

      {error && (
        <p className="error" style={{ marginTop: 8 }}>
          Error: {error}
        </p>
      )}

      {result && <ResultBlock result={result} />}
    </div>
  );
}

function verdictBadge(verdict: ProbeAnalysisOutput["verdict"]): {
  bg: string;
  fg: string;
} {
  switch (verdict) {
    case "won":
      return { bg: "#dff5df", fg: "#155724" };
    case "partial":
      return { bg: "#fff3cd", fg: "#664d03" };
    case "lost":
      return { bg: "#f8d7da", fg: "#721c24" };
    case "not_relevant":
      return { bg: "#e9ecef", fg: "#495057" };
  }
}

function ResultBlock({ result }: { result: ProbeAnalysisOutput }) {
  const style = verdictBadge(result.verdict);
  return (
    <div style={{ marginTop: 12, borderTop: "1px dashed #ccc", paddingTop: 12 }}>
      <div>
        <strong>Verdict:</strong>{" "}
        <span
          style={{
            background: style.bg,
            color: style.fg,
            padding: "2px 8px",
            fontWeight: 700,
          }}
        >
          {result.verdict}
        </span>
      </div>
      <div>
        <strong>Client mentioned:</strong> {result.clientMentioned ? "yes" : "no"}{" "}
        <span className="badge">position: {result.clientPosition}</span>
      </div>

      <div style={{ marginTop: 6 }}>
        <strong>Competitors mentioned ({result.competitorsMentioned.length}):</strong>
        {result.competitorsMentioned.length === 0 ? (
          <span className="muted"> —</span>
        ) : (
          <ol>
            {result.competitorsMentioned.map((c, i) => (
              <li key={i}>
                <strong>{c.name}</strong>{" "}
                <span className="muted">(position {c.position})</span>{" "}
                {c.context && <em style={{ color: "#555" }}>“{c.context}”</em>}
              </li>
            ))}
          </ol>
        )}
      </div>

      <div style={{ marginTop: 6 }}>
        <strong>Sources cited ({result.sourcesCited.length}):</strong>
        {result.sourcesCited.length === 0 ? (
          <span className="muted"> —</span>
        ) : (
          <ul>
            {result.sourcesCited.map((s, i) => (
              <li key={i}>
                <span className="badge">{s.type}</span> {s.source}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div style={{ marginTop: 6 }}>
        <strong>Answer summary:</strong>{" "}
        {result.answerSummary || <span className="muted">—</span>}
      </div>

      {result.whyClientLost && (
        <div style={{ marginTop: 6 }}>
          <strong>Why client lost:</strong> {result.whyClientLost}
        </div>
      )}
    </div>
  );
}
