"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  buildReplacePayload,
  classifyReplaceResponse,
  replacementAvailability,
} from "@/lib/snapshot-requests/report-replacement-ui";
import type { SnapshotReportPublicationState } from "@/lib/snapshot-requests/report-publication-state";

/**
 * Founder review and replacement of the stored report artifact.
 *
 * Shows exactly what is persisted — never a re-render from Gap Map or Fix
 * Brief — because this is publication review of the artifact that may later
 * reach a customer.
 *
 * Replacement posts through the founder-authenticated server route; the
 * browser never touches a privileged RPC, and the raw delivery claim token is
 * not part of the state this component receives.
 */
export function ReplaceReportPanel({
  requestId,
  state,
}: {
  requestId: string;
  state: SnapshotReportPublicationState;
}) {
  const router = useRouter();
  const availability = replacementAvailability(state);

  const [editing, setEditing] = useState(false);
  const [full, setFull] = useState(state.fullReportMarkdown);
  const [short, setShort] = useState(state.shortReportMarkdown);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<
    { tone: "ok" | "warn" | "error"; text: string } | null
  >(null);

  const shortId = (v: string) => `${v.slice(0, 8)}…`;

  async function replaceReport() {
    if (!availability.canReplace) return;

    const confirmed = window.confirm(
      "Replace the stored report?\n\n" +
        "Both the Full and Short reports will be replaced. The report will NOT be sent automatically."
    );
    if (!confirmed) return;

    setPending(true);
    setNotice(null);

    try {
      const res = await fetch(
        `/api/internal/snapshot-requests/${requestId}/replace-report`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(
            buildReplacePayload(state, {
              fullReportMarkdown: full,
              shortReportMarkdown: short,
            })
          ),
        }
      );

      let body: { error?: unknown } | null = null;
      try {
        body = await res.json();
      } catch {
        body = null;
      }

      const outcome = classifyReplaceResponse(res.status, body);

      if (outcome.kind === "success") {
        setEditing(false);
        setNotice({ tone: "ok", text: "Stored report replaced. It has not been sent." });
        // Authoritative state comes from the server, not from the response echo.
        router.refresh();
        return;
      }

      // Every non-success path stops here. Edits stay in the textareas so the
      // founder can decide after refreshing; nothing is retried for them.
      setNotice({
        tone: outcome.kind === "stale" ? "warn" : "error",
        text: outcome.message,
      });
    } catch {
      setNotice({
        tone: "error",
        text: "Report replacement failed. Refresh and check the stored report before trying again.",
      });
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="founder-replacement-panel mt-8 rounded-lg border border-slate-200 p-4">
      <h2 className="text-base font-semibold">Stored report artifact</h2>

      <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-4">
        <div>
          <dt className="text-slate-500">Artifact</dt>
          <dd className="font-mono">{shortId(state.artifactId)}</dd>
        </div>
        <div>
          <dt className="text-slate-500">Revision</dt>
          <dd className="font-mono">{shortId(state.revision)}</dd>
        </div>
        <div>
          <dt className="text-slate-500">Delivery</dt>
          <dd>
            {state.deliveredAt
              ? "Delivered"
              : state.deliveryClaimActive
                ? "Delivery locked"
                : "Undelivered"}
          </dd>
        </div>
        <div>
          <dt className="text-slate-500">
            {state.deliveredAt ? "Delivered at" : "Claimed at"}
          </dt>
          <dd>{state.deliveredAt ?? state.deliveryClaimedAt ?? "—"}</dd>
        </div>
      </dl>

      {!availability.canReplace && (
        <p className="mt-3 rounded bg-amber-50 p-2 text-sm text-amber-900">
          {availability.message}
        </p>
      )}

      {notice && (
        <p
          className={`mt-3 rounded p-2 text-sm ${
            notice.tone === "ok"
              ? "bg-emerald-50 text-emerald-900"
              : notice.tone === "warn"
                ? "bg-amber-50 text-amber-900"
                : "bg-red-50 text-red-900"
          }`}
        >
          {notice.text}
          {notice.tone !== "ok" && (
            <button
              type="button"
              onClick={() => router.refresh()}
              className="ml-2 underline"
            >
              Refresh
            </button>
          )}
        </p>
      )}

      {!editing ? (
        <div className="mt-4">
          <details className="text-sm">
            <summary className="cursor-pointer text-slate-600">
              Full report ({state.fullReportMarkdown.length} chars)
            </summary>
            <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap rounded bg-slate-50 p-3 text-xs">
              {state.fullReportMarkdown}
            </pre>
          </details>
          <details className="mt-2 text-sm">
            <summary className="cursor-pointer text-slate-600">
              Short report ({state.shortReportMarkdown.length} chars)
            </summary>
            <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap rounded bg-slate-50 p-3 text-xs">
              {state.shortReportMarkdown}
            </pre>
          </details>

          {availability.canReplace && (
            <button
              type="button"
              onClick={() => {
                setFull(state.fullReportMarkdown);
                setShort(state.shortReportMarkdown);
                setNotice(null);
                setEditing(true);
              }}
              className="mt-4 rounded border border-slate-300 px-3 py-1.5 text-sm"
            >
              Edit report
            </button>
          )}
        </div>
      ) : (
        <div className="mt-4 space-y-3">
          <label className="block text-sm">
            <span className="text-slate-600">Full report markdown</span>
            <textarea
              value={full}
              onChange={(e) => setFull(e.target.value)}
              rows={12}
              className="mt-1 w-full rounded border border-slate-300 p-2 font-mono text-xs"
            />
          </label>
          <label className="block text-sm">
            <span className="text-slate-600">Short report markdown</span>
            <textarea
              value={short}
              onChange={(e) => setShort(e.target.value)}
              rows={10}
              className="mt-1 w-full rounded border border-slate-300 p-2 font-mono text-xs"
            />
          </label>

          <div className="flex gap-2">
            <button
              type="button"
              onClick={replaceReport}
              disabled={pending || !availability.canReplace}
              className="rounded bg-slate-900 px-3 py-1.5 text-sm text-white disabled:opacity-50"
            >
              {pending ? "Replacing…" : "Replace stored report"}
            </button>
            <button
              type="button"
              onClick={() => {
                // Discards local edits only; nothing was persisted.
                setEditing(false);
                setNotice(null);
              }}
              disabled={pending}
              className="rounded border border-slate-300 px-3 py-1.5 text-sm"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
