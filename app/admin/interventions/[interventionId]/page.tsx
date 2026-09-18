import type { ReactNode } from "react";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { ArrowLeft, Lock, TriangleAlert } from "lucide-react";

import { requireFounderForPage } from "@/lib/auth/founder";
import { getReportServiceClient } from "@/lib/reports/service-client";
import { readEligibility, readIntervention } from "@/lib/interventions/intervention-actions";
import { readBaselineContext, readCitedRuns } from "@/lib/interventions/admin-reads";
import { interventionAdminEnabled } from "@/lib/interventions/route-guard";
import { UUID_PATTERN } from "@/lib/interventions/validate";
import { cn } from "@/lib/utils";
import { AdminThemeRoot, ThemeToggle } from "../../theme";
import { ADMIN_THEME_COOKIE, parseAdminTheme } from "../../theme-shared";
import { toneClass, ui, type Tone } from "../../ui-classes";
import { ACTION_TYPE_LABELS, statusPresentation } from "../presentation";
import { InterventionActionsPanel } from "./intervention-actions-panel";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const STATUS_TONE: Record<string, Tone> = {
  proposed: "warning",
  approved: "success",
  implemented: "info",
  rejected: "danger",
  abandoned: "neutral",
};

const ELIGIBILITY_TONE: Record<string, Tone> = {
  ready: "success",
  deviation: "warning",
  waiting: "info",
  neutral: "neutral",
};

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(d) + " UTC";
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className={cn(ui.subPanel, "min-w-0 px-4 py-3")}>
      <dt className={ui.label}>{label}</dt>
      <dd className="mt-1.5 whitespace-pre-wrap text-sm text-foreground [overflow-wrap:anywhere]">{children}</dd>
    </div>
  );
}

function Muted({ children }: { children: ReactNode }) {
  return <span className="text-muted-foreground">{children}</span>;
}

function TimelineItem({ when, title, children, tone = "neutral" }: {
  when: string | null; title: string; children?: ReactNode; tone?: Tone;
}) {
  return (
    <li className="relative pl-6">
      <span className={cn("absolute left-0 top-1.5 h-2.5 w-2.5 rounded-full border", toneClass[tone])} />
      <p className="text-sm font-semibold text-foreground">{title}</p>
      <p className="text-xs text-muted-foreground">{formatDate(when)}</p>
      {children ? <div className="mt-1.5 text-sm text-foreground">{children}</div> : null}
    </li>
  );
}

export default async function InterventionDetailPage({
  params,
}: {
  params: Promise<{ interventionId: string }>;
}) {
  const { interventionId } = await params;
  if (!UUID_PATTERN.test(interventionId)) notFound();

  const user = await requireFounderForPage(`/admin/interventions/${interventionId}`);
  const client = getReportServiceClient();

  const iv = await readIntervention(client, interventionId);
  if (!iv) notFound();

  const [eligibility, baseline, citedRuns] = await Promise.all([
    readEligibility(client, iv),
    readBaselineContext(client, iv.protocolId),
    readCitedRuns(client, iv.supportingEvidence),
  ]);

  const theme = parseAdminTheme((await cookies()).get(ADMIN_THEME_COOKIE)?.value);
  const status = statusPresentation(iv.status);
  const frozen = iv.approvedAt !== null;
  const unresolved = citedRuns.filter((r) => r.ordinal === null && r.summary === null).length;

  return (
    <AdminThemeRoot initialTheme={theme}>
      <div className="sticky top-0 z-30 border-b border-border bg-background/80 backdrop-blur">
        <div className="mx-auto flex h-16 w-full max-w-6xl items-center gap-8 px-6">
          <a href="/admin/interventions" className="text-lg font-bold tracking-tight text-foreground">Zypact</a>
          <nav className="hidden items-center gap-6 text-sm sm:flex">
            <a href="/admin/snapshot-requests" className="text-muted-foreground hover:text-foreground">Snapshot requests</a>
            <a href="/admin/interventions" className="font-medium text-foreground">Interventions</a>
          </nav>
          <div className="ml-auto flex items-center gap-3">
            <ThemeToggle />
            {user.email ? <span className="hidden text-sm text-muted-foreground md:inline">{user.email}</span> : null}
            <a href="/auth/logout" className={cn(ui.btnOutline, ui.btnSm)}>Sign out</a>
          </div>
        </div>
      </div>

      <main className="mx-auto w-full max-w-6xl flex-1 px-6 pb-16 pt-6">
        <a href="/admin/interventions" className="inline-flex items-center gap-2 text-sm font-medium text-primary hover:underline">
          <ArrowLeft size={16} strokeWidth={2} />
          Back to interventions
        </a>

        {/* ------------------------------------------------------ header */}
        <div className="mt-6 flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className={cn(ui.pill, toneClass[STATUS_TONE[iv.status] ?? "neutral"])}>{status.label}</span>
            <span className={cn(ui.pill, toneClass[ELIGIBILITY_TONE[eligibility.tone] ?? "neutral"])}>
              {iv.status === "implemented" ? eligibility.label : status.note}
            </span>
          </div>
          <h1 className="max-w-4xl text-2xl font-bold leading-snug tracking-tight text-foreground">{iv.hypothesis}</h1>
          <p className="text-sm text-muted-foreground">
            {baseline.companyName ?? baseline.domain ?? "Unknown company"}
            {baseline.companyName && baseline.domain ? ` · ${baseline.domain}` : ""}
          </p>
        </div>

        <div className="mt-8 grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
          <div className="flex min-w-0 flex-col gap-6">
            {/* ------------------------------------------ registered claim */}
            <section className={cn(ui.panel, "p-6")}>
              <div className="mb-4 flex items-center justify-between gap-3">
                <h2 className="text-base font-semibold">Registered claim</h2>
                {frozen ? (
                  <span className={cn(ui.chip)}>
                    <Lock size={13} /> Frozen {formatDate(iv.approvedAt)}
                  </span>
                ) : (
                  <span className={cn(ui.chip)}>Editable until approval</span>
                )}
              </div>
              <dl className="grid gap-3 sm:grid-cols-2">
                <div className="sm:col-span-2"><Field label="Hypothesis">{iv.hypothesis}</Field></div>
                <div className="sm:col-span-2"><Field label="Expected mechanism">{iv.expectedMechanism}</Field></div>
                <Field label="Action type">{ACTION_TYPE_LABELS[iv.actionType] ?? iv.actionType}</Field>
                <Field label="Owner">{iv.owner}</Field>
                <div className="sm:col-span-2"><Field label="Action target">{iv.actionTarget}</Field></div>
                <div className="sm:col-span-2">
                  <Field label="Decision threshold">
                    {iv.decisionThresholdNote ?? <Muted>Not recorded. It can no longer be added once approved.</Muted>}
                  </Field>
                </div>
                <Field label="Observation window">
                  {iv.expectedObservationDays !== null
                    ? `${iv.expectedObservationDays} day${iv.expectedObservationDays === 1 ? "" : "s"}`
                    : <Muted>Not set — implementation cannot be confirmed</Muted>}
                </Field>
                <Field label="Implementation deadline">{iv.implementationDeadline ? formatDate(iv.implementationDeadline) : <Muted>None</Muted>}</Field>
                <Field label="Alternative explanations">{iv.alternativeExplanations ?? <Muted>None recorded</Muted>}</Field>
                <Field label="Confounders to monitor">{iv.confoundersToMonitor ?? <Muted>None recorded</Muted>}</Field>
              </dl>
            </section>

            {/* ------------------------------------------ supporting runs */}
            <section className={cn(ui.panel, "p-6")}>
              <h2 className="mb-1 text-base font-semibold">Supporting runs</h2>
              <p className="mb-4 text-sm text-muted-foreground">
                The baseline runs this hypothesis rests on. Only runs of the same question can be cited.
              </p>
              {citedRuns.length === 0 ? (
                <p className={cn(ui.subPanel, "px-4 py-3 text-sm text-warning")}>
                  No runs cited. This intervention cannot be approved until at least one is.
                </p>
              ) : (
                <ul className="flex flex-col gap-2">
                  {citedRuns.map((run) => (
                    <li key={run.attemptId} className={cn(ui.subPanel, "px-4 py-3 text-sm")}>
                      <p className="font-semibold">
                        Run {run.ordinal ?? "?"}{" "}
                        <span className="font-normal text-muted-foreground">
                          {run.brandPresent === null ? "no readable result" : run.brandPresent
                            ? `brand present${run.position ? ` · ${run.position}` : ""}` : "brand absent"}
                        </span>
                      </p>
                      {run.summary ? <p className="mt-1 text-muted-foreground">{run.summary}</p> : null}
                      <p className="mt-1 font-mono text-[11px] text-muted-foreground">{run.attemptId}</p>
                    </li>
                  ))}
                </ul>
              )}
              {unresolved > 0 ? (
                <p className="mt-3 flex items-center gap-2 text-sm text-warning">
                  <TriangleAlert size={15} />
                  {unresolved} cited id{unresolved === 1 ? "" : "s"} no longer resolve{unresolved === 1 ? "s" : ""} to a stored run.
                </p>
              ) : null}
            </section>

            {/* ------------------------------------------ baseline */}
            <section className={cn(ui.panel, "p-6")}>
              <h2 className="mb-4 text-base font-semibold">Baseline</h2>
              <dl className="grid gap-3 sm:grid-cols-2">
                <div className="sm:col-span-2"><Field label="Buyer question">{baseline.promptText ?? <Muted>Unavailable</Muted>}</Field></div>
                <Field label="Planned runs">{baseline.plannedRuns ?? "—"}</Field>
                <Field label="Protocol"><span className="font-mono text-xs">{iv.protocolId}</span></Field>
              </dl>
            </section>

            {/* ------------------------------------------ lifecycle */}
            <section className={cn(ui.panel, "p-6")}>
              <h2 className="mb-4 text-base font-semibold">Lifecycle</h2>
              <ol className="flex flex-col gap-5 border-l border-border pl-0">
                <TimelineItem when={iv.createdAt} title="Registered as proposed" />
                {iv.approvedAt ? <TimelineItem when={iv.approvedAt} title="Approved — claim frozen" tone="success" /> : null}
                {iv.rejectedAt ? (
                  <TimelineItem when={iv.rejectedAt} title="Rejected" tone="danger">{iv.rejectedReason}</TimelineItem>
                ) : null}
                {iv.implementedAt ? (
                  <TimelineItem when={iv.implementedAt} title="Implementation confirmed — window opened" tone="info">
                    {iv.implementationEvidence ? (
                      <dl className="grid gap-1 text-sm">
                        {Object.entries(iv.implementationEvidence).map(([k, v]) => (
                          <div key={k} className="flex gap-2">
                            <dt className="text-muted-foreground">{k}</dt>
                            <dd className="[overflow-wrap:anywhere]">{typeof v === "string" ? v : JSON.stringify(v)}</dd>
                          </div>
                        ))}
                      </dl>
                    ) : null}
                    {iv.artifactSha256 ? <p className="mt-1 font-mono text-[11px] text-muted-foreground">sha256 {iv.artifactSha256}</p> : null}
                    {iv.protocolDeviations ? <p className="mt-1 text-warning">Deviations: {iv.protocolDeviations}</p> : null}
                  </TimelineItem>
                ) : null}
                {iv.observationWindowClosesAt ? (
                  <TimelineItem when={iv.observationWindowClosesAt} title="Observation window closes (frozen)" tone="info" />
                ) : null}
                {iv.earlyRetestAuthorizedAt ? (
                  <TimelineItem when={iv.earlyRetestAuthorizedAt} title="Early retest authorized — recorded deviation" tone="warning">
                    {iv.earlyRetestReason}
                  </TimelineItem>
                ) : null}
                {iv.abandonedAt ? (
                  <TimelineItem when={iv.abandonedAt} title="Abandoned" tone="neutral">{iv.abandonedReason}</TimelineItem>
                ) : null}
              </ol>
            </section>
          </div>

          {/* -------------------------------------------- actions */}
          <aside className="flex flex-col gap-6">
            <InterventionActionsPanel
              interventionId={iv.id}
              status={iv.status}
              hasEvidence={iv.supportingEvidence.length > 0}
              hasObservationWindow={iv.expectedObservationDays !== null}
              eligibility={{
                eligible: eligibility.eligible,
                reason: eligibility.reason,
                label: eligibility.label,
                authorizedEarly: eligibility.authorizedEarly,
              }}
              actionsEnabled={interventionAdminEnabled()}
            />
          </aside>
        </div>
      </main>
    </AdminThemeRoot>
  );
}
