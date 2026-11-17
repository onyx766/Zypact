"use client";

import { useState } from "react";
import { CircleCheck, CircleX, Clock, FlagOff, Rocket, TriangleAlert } from "lucide-react";

import { cn } from "@/lib/utils";
import { ui } from "../../ui-classes";

/**
 * Founder actions for one intervention. Offers only the moves the current
 * status allows; the routes and RPCs remain the authority and refuse anything
 * else, and their message is shown verbatim when they do.
 */

type Eligibility = { eligible: boolean; reason: string; label: string; authorizedEarly: boolean };

async function post(path: string, body: unknown): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    const res = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body ?? {}),
    });
    const payload = await res.json().catch(() => null);
    if (!res.ok || !payload?.ok) {
      const raw = payload?.message || payload?.error || `Request failed (${res.status}).`;
      if (payload?.error === "unauthorized" || /Fly rejected the access token/i.test(String(raw))) {
        return {
          ok: false,
          message: "Worker authentication failed. Check the production Fly token, worker app, and machine ID, then try again.",
        };
      }
      if (payload?.error === "not_found") {
        return {
          ok: false,
          message: "The configured Fly worker machine was not found. Check the production app and machine ID.",
        };
      }
      return { ok: false, message: String(raw) };
    }
    return { ok: true };
  } catch {
    return { ok: false, message: "Request failed. Check your connection and try again." };
  }
}

/** A button that expands into a required-reason form before it acts. */
function ReasonAction({
  label, icon, tone, warning, placeholder, onSubmit, disabled,
}: {
  label: string;
  icon: React.ReactNode;
  tone: "danger" | "outline";
  warning: string;
  placeholder: string;
  onSubmit: (reason: string) => Promise<{ ok: true } | { ok: false; message: string }>;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) {
    return (
      <button type="button" disabled={disabled} onClick={() => setOpen(true)}
        className={cn(tone === "danger" ? ui.btnDanger : ui.btnOutline, "w-full")}>
        {icon}{label}
      </button>
    );
  }

  return (
    <div className={cn(ui.subPanel, "flex flex-col gap-2 p-3")}>
      <p className="text-xs text-muted-foreground">{warning}</p>
      <textarea className={ui.input} rows={3} value={reason} placeholder={placeholder}
        onChange={(e) => setReason(e.target.value)} disabled={busy} />
      {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
      <div className="flex gap-2">
        <button type="button" className={cn(ui.btnOutline, ui.btnSm)} disabled={busy}
          onClick={() => { setOpen(false); setError(null); }}>Cancel</button>
        <button type="button" disabled={busy || reason.trim() === ""}
          className={cn(tone === "danger" ? ui.btnDanger : ui.btnPrimary, ui.btnSm, "flex-1")}
          onClick={async () => {
            setBusy(true); setError(null);
            const r = await onSubmit(reason.trim());
            if (r.ok) window.location.reload();
            else { setError(r.message); setBusy(false); }
          }}>
          {busy ? "Working…" : `Confirm ${label.toLowerCase()}`}
        </button>
      </div>
    </div>
  );
}

function ConfirmImplementation({ interventionId, disabled }: { interventionId: string; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [note, setNote] = useState("");
  const [sha, setSha] = useState("");
  const [deviations, setDeviations] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) {
    return (
      <button type="button" disabled={disabled} onClick={() => setOpen(true)} className={cn(ui.btnPrimary, "w-full")}>
        <Rocket size={16} /> Confirm implementation
      </button>
    );
  }

  const evidence: Record<string, string> = {};
  if (url.trim()) evidence.url = url.trim();
  if (note.trim()) evidence.note = note.trim();

  return (
    <div className={cn(ui.subPanel, "flex flex-col gap-2 p-3")}>
      <p className="text-xs text-muted-foreground">
        Verify it is actually live before confirming. This opens the observation window, and its closing
        date is fixed the moment you confirm.
      </p>
      <input className={ui.input} placeholder="Live URL" value={url} onChange={(e) => setUrl(e.target.value)} disabled={busy} />
      <textarea className={ui.input} rows={2} placeholder="What went live, and how you verified it"
        value={note} onChange={(e) => setNote(e.target.value)} disabled={busy} />
      <input className={cn(ui.input, "font-mono text-xs")} placeholder="Artifact SHA-256 (optional)"
        value={sha} onChange={(e) => setSha(e.target.value)} disabled={busy} />
      <textarea className={ui.input} rows={2} placeholder="Deviations from the approved intervention (optional)"
        value={deviations} onChange={(e) => setDeviations(e.target.value)} disabled={busy} />
      {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
      <div className="flex gap-2">
        <button type="button" className={cn(ui.btnOutline, ui.btnSm)} disabled={busy}
          onClick={() => { setOpen(false); setError(null); }}>Cancel</button>
        <button type="button" className={cn(ui.btnPrimary, ui.btnSm, "flex-1")}
          disabled={busy || Object.keys(evidence).length === 0}
          onClick={async () => {
            setBusy(true); setError(null);
            const r = await post(`/api/internal/interventions/${interventionId}/confirm-implementation`, {
              evidence, artifactSha256: sha.trim() || null, deviations: deviations.trim() || null,
            });
            if (r.ok) window.location.reload();
            else { setError(r.message); setBusy(false); }
          }}>
          {busy ? "Confirming…" : "Confirm — open the window"}
        </button>
      </div>
    </div>
  );
}

type RetestState = { protocolStatus: string; jobStatus: string | null; attempts: number } | null;

/** A single confirmed POST with inline error, for the retest steps. */
function ConfirmAction({
  label, busyLabel, icon, confirmText, path, disabled, primary = true,
}: {
  label: string; busyLabel: string; icon: React.ReactNode; confirmText: string;
  path: string; disabled: boolean; primary?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <button type="button" disabled={disabled || busy}
        className={cn(primary ? ui.btnPrimary : ui.btnOutline, "w-full")}
        onClick={async () => {
          if (!window.confirm(confirmText)) return;
          setBusy(true); setError(null);
          const r = await post(path, {});
          if (r.ok) window.location.reload();
          else { setError(r.message); setBusy(false); }
        }}>
        {icon} {busy ? busyLabel : label}
      </button>
      {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
    </>
  );
}

export function InterventionActionsPanel({
  interventionId, status, hasEvidence, hasObservationWindow, eligibility, retest = null, actionsEnabled,
}: {
  interventionId: string;
  status: string;
  hasEvidence: boolean;
  hasObservationWindow: boolean;
  eligibility: Eligibility;
  retest?: RetestState;
  actionsEnabled: boolean;
}) {
  const [approving, setApproving] = useState(false);
  const [approveError, setApproveError] = useState<string | null>(null);
  const base = `/api/internal/interventions/${interventionId}`;
  const off = !actionsEnabled;

  // Once an attempt exists, 0077 refuses abandonment outright. Offering the
  // button then would only produce a refusal, so it is replaced by the rule.
  const measuring = (retest?.attempts ?? 0) > 0 ||
    retest?.jobStatus === "claimed" || retest?.jobStatus === "running";

  const abandon = measuring ? (
    <p className="text-xs text-muted-foreground">
      The retest has started measuring, so this intervention can no longer be abandoned. Let it
      finish: an inconclusive result is an honest outcome.
    </p>
  ) : (
    <ReasonAction
      label="Abandon" icon={<FlagOff size={16} />} tone="danger" disabled={off}
      warning={
        retest?.jobStatus === "queued"
          ? "Permanent. Also cancels the queued retest job and takes the retest protocol down, so nothing runs."
          : "Permanent. Refused once the retest has started measuring — after that, let it finish and record deviations instead."
      }
      placeholder="Why this intervention is being abandoned"
      onSubmit={(reason) => post(`${base}/abandon`, { reason })}
    />
  );

  return (
    <section className={cn(ui.panel, "flex flex-col gap-3 p-5")}>
      <h2 className="text-base font-semibold">Actions</h2>

      {off ? (
        <p className="flex gap-2 text-xs text-warning">
          <TriangleAlert size={14} className="shrink-0" />
          Disabled on this deployment. Set INTERVENTION_ADMIN_ENABLED=true.
        </p>
      ) : null}

      {status === "proposed" ? (
        <>
          <button type="button" className={cn(ui.btnPrimary, "w-full")}
            disabled={off || approving || !hasEvidence}
            onClick={async () => {
              if (!window.confirm("Approve and freeze this claim? The hypothesis, mechanism, action, cited runs and decision threshold can't be edited afterwards.")) return;
              setApproving(true); setApproveError(null);
              const r = await post(`${base}/approve`, {});
              if (r.ok) window.location.reload();
              else { setApproveError(r.message); setApproving(false); }
            }}>
            <CircleCheck size={16} /> {approving ? "Approving…" : "Approve and freeze"}
          </button>
          {!hasEvidence ? (
            <p className="text-xs text-warning">Cite at least one supporting run before approving.</p>
          ) : null}
          {approveError ? <p role="alert" className="text-xs text-destructive">{approveError}</p> : null}
          <ReasonAction
            label="Reject" icon={<CircleX size={16} />} tone="outline" disabled={off}
            warning="Closes this proposal. Its baseline becomes free for another intervention."
            placeholder="Why this proposal is being rejected"
            onSubmit={(reason) => post(`${base}/reject`, { reason })}
          />
          {abandon}
        </>
      ) : null}

      {status === "approved" ? (
        <>
          {hasObservationWindow ? (
            <ConfirmImplementation interventionId={interventionId} disabled={off} />
          ) : (
            <p className="text-xs text-warning">
              No observation window was set at registration, so implementation cannot be confirmed. Abandon
              this intervention and register it again with a window.
            </p>
          )}
          {abandon}
        </>
      ) : null}

      {status === "implemented" ? (
        <>
          <p className={cn(ui.subPanel, "flex items-center gap-2 px-3 py-2 text-sm")}>
            <Clock size={15} className="shrink-0 text-muted-foreground" /> {eligibility.label}
          </p>
          {eligibility.eligible && !retest ? (
            <ConfirmAction
              label="Create retest protocol" busyLabel="Creating…" icon={<Rocket size={16} />}
              path={`${base}/create-retest`} disabled={off}
              confirmText={
                "Create the retest protocol?\n\nIt reuses this baseline's exact question, provider and sampling plan. " +
                "It queues nothing and spends nothing — running it is a separate step.\n\n" +
                "An intervention gets exactly one retest: once this one completes, it cannot be replaced."
              }
            />
          ) : null}
          {retest && retest.jobStatus === null && retest.protocolStatus !== "completed" ? (
            <>
              <ConfirmAction
                label="Queue retest run" busyLabel="Queueing…" icon={<Rocket size={16} />}
                path={`${base}/queue-retest`} disabled={off}
                confirmText={
                  "Queue the retest run?\n\nThis commits paid provider calls. Nothing runs yet: the job waits " +
                  "until you press Run retest now, which starts the worker for this job only.\n\n" +
                  "Until the first attempt lands you can still abandon the intervention, which cancels the job. " +
                  "After that, abandonment is refused and the retest must finish."
                }
              />
              <p className="text-xs text-muted-foreground">
                Commits spend: the job runs when you press Run retest now.
              </p>
            </>
          ) : null}
          {retest && retest.jobStatus !== null ? (
            <p className="text-xs text-muted-foreground">
              Retest job {retest.jobStatus.replace(/_/g, " ")} · {retest.attempts} attempt
              {retest.attempts === 1 ? "" : "s"} recorded.
            </p>
          ) : null}
          {/*
            A queued job runs only when the worker is started for it (D-052),
            and the worker stops again after one job. Without this the queue is visible and
            unreachable from the console, which is how a retest sat at
            "queued · 0 attempts" with nothing in the product able to move it.
          */}
          {retest && retest.jobStatus === "queued" ? (
            <ConfirmAction
              label="Run retest now" busyLabel="Starting…" icon={<Rocket size={16} />}
              path={`${base}/run-retest`} disabled={off}
              confirmText={
                "Start the worker to run this retest?\n\nIt runs only this retest: it makes the paid provider " +
                "calls the queued job describes, then stops. One start runs one job.\n\n" +
                "The result appears here when it finishes. Five runs usually take about 2 minutes."
              }
            />
          ) : null}
          {eligibility.reason === "OBSERVATION_WINDOW_OPEN" && !eligibility.authorizedEarly ? (
            <ReasonAction
              label="Authorize early retest" icon={<TriangleAlert size={16} />} tone="outline" disabled={off}
              warning="Records a permanent deviation: the retest may start before the window closes. The reason cannot be changed later and appears alongside the result."
              placeholder="Why the retest cannot wait for the window to close"
              onSubmit={(reason) => post(`${base}/authorize-early-retest`, { reason })}
            />
          ) : null}
          {abandon}
        </>
      ) : null}

      {status === "rejected" || status === "abandoned" ? (
        <p className="text-sm text-muted-foreground">
          Closed. This record is kept as it was; nothing further can be done to it.
        </p>
      ) : null}
    </section>
  );
}
