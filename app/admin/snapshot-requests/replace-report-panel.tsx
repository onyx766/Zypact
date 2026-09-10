"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { ChevronDown, Paperclip, Pencil } from "lucide-react";
import {
  buildReplacePayload,
  classifyReplaceResponse,
  replacementAvailability,
} from "@/lib/snapshot-requests/report-replacement-ui";
import type { SnapshotReportPublicationState } from "@/lib/snapshot-requests/report-publication-state";
import { cn } from "@/lib/utils";
import { toneClass, ui } from "../ui-classes";

/**
 * Founder review and replacement of the stored report artifact.
 *
 * Shows exactly what is persisted — never a re-render from Gap Map or Fix
 * Brief — because this is publication review of the artifact that may later
 * reach a customer. The stored text itself is shown in full by the Short and
 * Full report previews on the same page; this panel carries the artifact's
 * identity, delivery state, and the edit path.
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

  const [expanded, setExpanded] = useState(false);
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
    <section className={cn(ui.panel, "mt-4 overflow-hidden")}>
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        className="flex w-full items-center gap-4 px-6 py-5 text-left transition-colors hover:bg-muted/40"
      >
        <span
          className={cn(
            "flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border",
            toneClass.neutral
          )}
        >
          <Paperclip size={20} strokeWidth={1.9} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-base font-semibold tracking-tight text-foreground">
            Stored report artifact
          </span>
          <span className="mt-0.5 block text-sm text-muted-foreground">
            The exact report text stored for this request, with its revision
            and delivery state.
          </span>
        </span>
        <span className="hidden rounded-full border border-border px-2.5 py-1 font-mono text-xs text-muted-foreground sm:inline">
          rev {shortId(state.revision)}
        </span>
        <ChevronDown
          size={18}
          className={cn(
            "shrink-0 text-muted-foreground transition-transform",
            expanded && "rotate-180"
          )}
        />
      </button>

      {expanded ? (
        <div className="border-t border-border px-6 py-5">
          <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
            <div className={cn(ui.subPanel, "px-4 py-3")}>
              <dt className={ui.label}>Artifact</dt>
              <dd className="mt-1.5 font-mono text-foreground">{shortId(state.artifactId)}</dd>
            </div>
            <div className={cn(ui.subPanel, "px-4 py-3")}>
              <dt className={ui.label}>Revision</dt>
              <dd className="mt-1.5 font-mono text-foreground">{shortId(state.revision)}</dd>
            </div>
            <div className={cn(ui.subPanel, "px-4 py-3")}>
              <dt className={ui.label}>Delivery</dt>
              <dd className="mt-1.5 text-foreground">
                {state.deliveredAt
                  ? "Delivered"
                  : state.deliveryClaimActive
                    ? "Delivery locked"
                    : "Undelivered"}
              </dd>
            </div>
            <div className={cn(ui.subPanel, "px-4 py-3")}>
              <dt className={ui.label}>
                {state.deliveredAt ? "Delivered at" : "Claimed at"}
              </dt>
              <dd className="mt-1.5 text-foreground [overflow-wrap:anywhere]">
                {state.deliveredAt ?? state.deliveryClaimedAt ?? "—"}
              </dd>
            </div>
          </dl>

          {!availability.canReplace && (
            <p className={cn("mt-4 rounded-lg border px-3.5 py-2.5 text-sm", toneClass.warning)}>
              {availability.message}
            </p>
          )}

          {notice && (
            <p
              className={cn(
                "mt-4 rounded-lg border px-3.5 py-2.5 text-sm",
                notice.tone === "ok"
                  ? toneClass.success
                  : notice.tone === "warn"
                    ? toneClass.warning
                    : toneClass.danger
              )}
            >
              {notice.text}
              {notice.tone !== "ok" && (
                <button
                  type="button"
                  onClick={() => router.refresh()}
                  className="ml-2 font-semibold underline"
                >
                  Refresh
                </button>
              )}
            </p>
          )}

          {!editing ? (
            availability.canReplace && (
              <button
                type="button"
                onClick={() => {
                  setFull(state.fullReportMarkdown);
                  setShort(state.shortReportMarkdown);
                  setNotice(null);
                  setEditing(true);
                }}
                className={cn(ui.btnOutline, "mt-4")}
              >
                <Pencil size={15} strokeWidth={2.2} />
                Edit report
              </button>
            )
          ) : (
            <div className="mt-4 space-y-4">
              <label className="block text-sm">
                <span className="text-muted-foreground">Full report markdown</span>
                <textarea
                  value={full}
                  onChange={(e) => setFull(e.target.value)}
                  rows={12}
                  className={cn(ui.input, "mt-1.5 font-mono text-xs leading-5")}
                />
              </label>
              <label className="block text-sm">
                <span className="text-muted-foreground">Short report markdown</span>
                <textarea
                  value={short}
                  onChange={(e) => setShort(e.target.value)}
                  rows={10}
                  className={cn(ui.input, "mt-1.5 font-mono text-xs leading-5")}
                />
              </label>

              <div className="flex flex-wrap gap-2.5">
                <button
                  type="button"
                  onClick={replaceReport}
                  disabled={pending || !availability.canReplace}
                  className={ui.btnPrimary}
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
                  className={ui.btnOutline}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      ) : null}
    </section>
  );
}
