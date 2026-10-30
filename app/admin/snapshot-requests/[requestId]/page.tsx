import type { ReactNode } from "react";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import {
  Activity,
  ArrowLeft,
  ArrowUpRight,
  Building2,
  CalendarDays,
  ChartLine,
  ChartNoAxesColumn,
  ChevronDown,
  CircleCheck,
  Download,
  Eye,
  FileText,
  Hash,
  Info,
  Layers,
  ListChecks,
  Lock,
  Play,
  ShieldCheck,
  TriangleAlert,
  User,
} from "lucide-react";

import { getDb } from "@/lib/db";
import type { Protocol } from "@/lib/db/types";
import {
  requireFounderForPage,
} from "@/lib/auth/founder";
import { ApproveButton } from "../approve-button";
import { RejectButton } from "../reject-button";
import { SendReportButton } from "../send-report-button";
import { ReplaceReportPanel } from "../replace-report-panel";
import { ReviewPanel } from "../review-panel";
import { getReportServiceClient } from "@/lib/reports/service-client";
import { loadReviewState } from "@/lib/reports/review-actions";
import { toSnapshotReportPublicationState } from "@/lib/snapshot-requests/report-publication-state";
import {
  isProtocolReportPayload,
  type ProtocolReportPayload,
} from "@/lib/reports/protocol-report-types";
import { cn } from "@/lib/utils";
import { AdminThemeRoot, ThemeToggle } from "../../theme";
import { ADMIN_THEME_COOKIE, parseAdminTheme } from "../../theme-shared";
import {
  INTEGRITY_PRESENTATION,
  dotClass,
  humanize,
  requestStatusTone,
  toneClass,
  ui,
  type Tone,
} from "../../ui-classes";
import { CopyButton } from "./copy-button";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function formatDate(
  value: string | null
): string {
  if (!value) {
    return "—";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat(
    "en-US",
    {
      dateStyle: "medium",
      timeStyle: "short",
    }
  ).format(date);
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/**
 * Reads Δ_min out of `protocols.minimum_useful_change`, which is jsonb and
 * therefore `unknown` on the way in. Returns null rather than guessing when
 * the shape is not the one 0073 writes.
 */
function readMinimumUsefulChange(raw: unknown): number | null {
  if (typeof raw !== "object" || raw === null) return null;
  const value = (raw as { value?: unknown }).value;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * The sampling-power disclosure required by §5 of the signed-off
 * OUTCOME_COMPARISON_PROPOSAL.
 *
 * This states what the approved plan is capable of detecting *before* any run
 * happens. It is deliberately phrased as a limit rather than a capability: at
 * the five-run default the value is 0.60, equal to Δ_min, which means a real
 * change smaller than 60 points cannot be distinguished from noise no matter
 * what the runs return.
 */
function DetectableChangeDisclosure({
  protocol,
}: {
  protocol: Protocol | null;
}) {
  if (!protocol) {
    return <span className="text-muted-foreground">—</span>;
  }

  if (protocol.detectableChangeAtPlan === null) {
    return (
      <>
        <span className="text-muted-foreground">Not recorded</span>
        <p className="mt-1.5 text-xs text-muted-foreground">
          This protocol was approved before the disclosure existed
          (migration 0075). The value is not back-filled, because the
          honest statement about a past approval is that it was not
          disclosed — not a number computed after the fact.
        </p>
      </>
    );
  }

  const deltaMin = readMinimumUsefulChange(protocol.minimumUsefulChange);
  const atOrAboveDeltaMin =
    deltaMin !== null && protocol.detectableChangeAtPlan >= deltaMin;

  return (
    <>
      <span className={cn("font-medium", atOrAboveDeltaMin && "text-amber-500")}>
        {percent(protocol.detectableChangeAtPlan)}
      </span>{" "}
      <span className="text-muted-foreground">
        at {plural(protocol.plannedBaselineRuns, "planned run")}
      </span>
      <p className="mt-1.5 text-xs text-muted-foreground">
        The smallest change this sampling plan could detect at all. A real
        change smaller than this cannot be distinguished from noise at this
        sample size.
        {atOrAboveDeltaMin ? (
          <>
            {" "}
            <span className="text-amber-500">
              It is at or above Δ_min ({percent(deltaMin as number)}), so this
              plan can only detect a change at least as large as the one
              already agreed to be the minimum useful change.
            </span>
          </>
        ) : null}
      </p>
    </>
  );
}

/**
 * Stable monogram tint, derived from the domain rather than fetched from a
 * favicon service, which would hand a prospect's domain to a third party on
 * every page load.
 */
function avatarStyle(seed: string): React.CSSProperties {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) % 360;
  }

  return {
    background: `linear-gradient(145deg, hsl(${hash} 62% 52%), hsl(${(hash + 28) % 360} 58% 38%))`,
  };
}

function runStatusTone(status: string): Tone {
  if (/fail|error/i.test(status)) return "danger";
  if (/exclud/i.test(status)) return "warning";
  if (/complet|success/i.test(status)) return "success";
  return "neutral";
}

function IconTile({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: Tone;
}) {
  return (
    <span
      className={cn(
        "flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border",
        toneClass[tone]
      )}
    >
      {children}
    </span>
  );
}

function DetailRow({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className={cn(ui.subPanel, "min-w-0 px-4 py-3")}>
      <dt className={ui.label}>{label}</dt>
      <dd className="mt-1.5 text-sm text-foreground [overflow-wrap:anywhere]">
        {children}
      </dd>
    </div>
  );
}

function MetaItem({
  icon,
  label,
  children,
}: {
  icon: ReactNode;
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 items-start gap-3 bg-card px-6 py-4">
      <span className="mt-0.5 text-muted-foreground">{icon}</span>
      <div className="min-w-0">
        <dt className="text-xs text-muted-foreground">{label}</dt>
        <dd className="mt-1 text-sm font-medium text-foreground [overflow-wrap:anywhere]">
          {children}
        </dd>
      </div>
    </div>
  );
}

function Metric({
  icon,
  tone,
  label,
  value,
  hint,
  children,
}: {
  icon: ReactNode;
  tone: Tone;
  label: string;
  value: ReactNode;
  hint?: string;
  children?: ReactNode;
}) {
  return (
    <div className={cn(ui.panel, "flex items-start gap-4 p-5")}>
      <IconTile tone={tone}>{icon}</IconTile>
      <div className="min-w-0 flex-1">
        <p className="text-xs text-muted-foreground first-letter:uppercase">
          {label}
        </p>
        <p className="mt-2 text-2xl font-bold tracking-tight text-foreground">
          {value}
        </p>
        {hint ? (
          <p className="mt-1.5 text-xs text-muted-foreground">{hint}</p>
        ) : null}
        {children}
      </div>
    </div>
  );
}

/**
 * Collapsible section row. A native <details>, so it opens and closes without
 * any client JavaScript.
 */
function Disclosure({
  icon,
  title,
  description,
  badge,
  defaultOpen = false,
  children,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  badge?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  return (
    <details
      className={cn(ui.panel, "group mt-4 overflow-hidden")}
      open={defaultOpen}
    >
      <summary className="flex cursor-pointer list-none items-center gap-4 px-6 py-5 transition-colors hover:bg-muted/40 [&::-webkit-details-marker]:hidden">
        <IconTile>{icon}</IconTile>
        <span className="min-w-0 flex-1">
          <span className="block text-base font-semibold tracking-tight text-foreground">
            {title}
          </span>
          <span className="mt-0.5 block text-sm text-muted-foreground">
            {description}
          </span>
        </span>
        {badge}
        <ChevronDown
          size={18}
          className="shrink-0 text-muted-foreground transition-transform group-open:rotate-180"
        />
      </summary>
      <div className="border-t border-border px-6 py-5">{children}</div>
    </details>
  );
}

/**
 * Inline preview for one stored report artifact.
 *
 * Rendered as pre-formatted plain text, not as parsed Markdown. The
 * repository has no Markdown-rendering dependency installed, and adding one
 * is out of scope for this change, so the raw source is shown verbatim
 * inside a bounded scroll container. `dangerouslySetInnerHTML` is
 * deliberately not used: report content is model-generated and must never
 * reach the DOM as HTML.
 *
 * An empty artifact column renders an explicit neutral state rather than a
 * blank panel, so the founder can tell "no content" from "not loaded".
 */
function ReportPreview({
  heading,
  filename,
  markdown,
  downloadHref,
}: {
  heading: string;
  filename: string;
  markdown: string;
  downloadHref: string;
}) {
  const isEmpty =
    markdown.trim().length === 0;

  return (
    <section className={cn(ui.panel, "flex min-w-0 flex-col overflow-hidden")}>
      <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
        <div className="min-w-0">
          <h3 className="text-[15px] font-semibold tracking-tight text-foreground">
            {heading}
          </h3>
          <p className="mt-0.5 truncate font-mono text-[11.5px] text-muted-foreground">
            {filename}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <span className="rounded-full border border-border px-2.5 py-1 text-[11px] text-muted-foreground">
            {markdown.length.toLocaleString(
              "en-US"
            )}{" "}
            characters
          </span>
          {isEmpty ? null : (
            <CopyButton
              value={markdown}
              label={`Copy ${heading.toLowerCase()}`}
            />
          )}
          <a
            href={downloadHref}
            aria-label={`Download ${heading.toLowerCase()}`}
            title={`Download ${heading.toLowerCase()}`}
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-border bg-card text-muted-foreground transition-colors hover:text-foreground"
          >
            <Download size={14} strokeWidth={2} />
          </a>
        </div>
      </div>

      {isEmpty ? (
        <p className="px-5 py-10 text-center text-sm text-muted-foreground">
          This report is empty.
        </p>
      ) : (
        <div
          className="bg-muted/40 py-3 font-mono text-[12.5px] leading-6"
          style={{ maxHeight: 520, overflow: "auto" }}
        >
          {markdown.split("\n").map((line, index) => (
            <div key={index} className="flex gap-4 px-4">
              <span
                aria-hidden="true"
                className="w-8 shrink-0 select-none text-right text-muted-foreground/60"
              >
                {index + 1}
              </span>
              <span
                className="min-w-0 flex-1 text-foreground [overflow-wrap:anywhere]"
                style={{ whiteSpace: "pre-wrap" }}
              >
                {line || " "}
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/**
 * Plain-language summary of the stored payload. Every line is derived from
 * the payload's own counts, so it can never say more than the evidence does:
 * an empty result is called empty, not zero, and a reconciliation mismatch is
 * surfaced rather than smoothed over.
 */
function buildTakeaways(
  payload: ProtocolReportPayload
): { kind: "fact" | "caveat" | "alert"; text: string }[] {
  const { observation, reconciliation } = payload;
  const items: { kind: "fact" | "caveat" | "alert"; text: string }[] = [];

  items.push({
    kind: "fact",
    text: `${reconciliation.completed} of ${plural(
      reconciliation.attempted,
      "attempt"
    )} completed · ${reconciliation.failed} failed · ${reconciliation.excludedByReview} excluded after review.`,
  });

  if (observation.denominator === 0 || observation.rate === null) {
    items.push({
      kind: "caveat",
      text: "No run produced a readable provider result, so no rate is reported. This is an empty result, not a zero.",
    });
  } else {
    const interval = observation.interval
      ? `; 95% interval ${percent(observation.interval.low)} – ${percent(
          observation.interval.high
        )}`
      : "";
    items.push({
      kind: "fact",
      text: `The brand appeared in ${observation.numerator} of ${plural(
        observation.denominator,
        "readable run"
      )} (${percent(observation.rate)}${interval}).`,
    });
  }

  items.push({
    kind: "caveat",
    text: "Single surface, point-in-time: not a measure of how all AI assistants describe this brand.",
  });

  if (!reconciliation.accountedFor) {
    items.push({
      kind: "alert",
      text: "These counts do not reconcile and this report requires review.",
    });
  }

  return items;
}

export default async function SnapshotRequestDetailPage({
  params,
}: {
  params: Promise<{
    requestId: string;
  }>;
}) {
  const { requestId } = await params;

  if (!UUID_PATTERN.test(requestId)) {
    notFound();
  }

  const user = await requireFounderForPage(
    `/admin/snapshot-requests/${requestId}`
  );

  const db = getDb();

  const [
    request,
    artifact,
  ] = await Promise.all([
    db.getSnapshotRequest(requestId),
    db.getSnapshotReportArtifact(
      requestId
    ),
  ]);

  if (!request) {
    notFound();
  }

  // The approved baseline protocol, read only for the sampling-power
  // disclosure below. Best-effort for the same reason as the review panel: a
  // request that predates the protocol path has no protocol, and a read
  // failure must not take the page down.
  let protocol: Awaited<ReturnType<typeof db.getProtocol>> = null;
  if (request.protocolId && request.projectId) {
    try {
      protocol = await db.getProtocol(
        request.protocolId,
        request.projectId
      );
    } catch {
      protocol = null;
    }
  }

  // Best-effort: the review surface must never take the whole page down. A
  // request that predates the protocol path, or a transient read failure,
  // renders the page without the panel rather than a 500.
  let reviewState: Awaited<ReturnType<typeof loadReviewState>> | null = null;
  try {
    reviewState = await loadReviewState(
      getReportServiceClient(),
      requestId
    );
  } catch {
    reviewState = null;
  }

  const theme = parseAdminTheme(
    (await cookies()).get(ADMIN_THEME_COOKIE)?.value
  );

  // Protocol sections render only from a canonical V1 payload. Legacy
  // artifacts have none, and nothing here re-derives one from Markdown.
  const payload =
    artifact && isProtocolReportPayload(artifact.reportPayload)
      ? artifact.reportPayload
      : null;

  const publication = artifact
    ? toSnapshotReportPublicationState(artifact)
    : null;

  const integrity = artifact?.integrityStatus
    ? INTEGRITY_PRESENTATION[artifact.integrityStatus] ?? {
        label: humanize(artifact.integrityStatus),
        tone: "neutral" as Tone,
      }
    : null;

  // A blocked report is not readable by the client even with the link, so
  // the page does not offer a link that would only 404.
  const blocked = artifact?.integrityStatus === "blocked";

  const reconciliation = payload?.reconciliation ?? null;
  const observation = payload?.observation ?? null;
  const completedShare =
    reconciliation && reconciliation.planned > 0
      ? Math.min(100, (reconciliation.completed / reconciliation.planned) * 100)
      : 0;

  return (
    <AdminThemeRoot initialTheme={theme}>
      <div className="sticky top-0 z-30 border-b border-border bg-background/80 backdrop-blur">
        <div className="mx-auto flex h-16 w-full max-w-6xl items-center gap-8 px-6">
          <a
            href="/admin/snapshot-requests"
            className="text-lg font-bold tracking-tight text-foreground"
          >
            Zypact
          </a>
          <nav className="hidden items-center gap-6 text-sm sm:flex">
            <a
              href="/admin/snapshot-requests"
              className="font-medium text-foreground"
            >
              Snapshot requests
            </a>
          </nav>
          <div className="ml-auto flex items-center gap-3">
            <ThemeToggle />
            {user.email ? (
              <span className="hidden text-sm text-muted-foreground md:inline">
                {user.email}
              </span>
            ) : null}
            <a href="/auth/logout" className={cn(ui.btnOutline, ui.btnSm)}>
              Sign out
            </a>
          </div>
        </div>
      </div>

      <main className="mx-auto w-full max-w-6xl flex-1 px-6 pb-16 pt-6">
        <a
          href="/admin/snapshot-requests"
          className="inline-flex items-center gap-2 text-sm font-medium text-primary hover:underline"
        >
          <ArrowLeft size={16} strokeWidth={2} />
          Back to snapshot requests
        </a>

        {/* ---------------------------------------------------- header */}
        <div className="mt-6 flex flex-col gap-6 lg:flex-row lg:items-start lg:justify-between">
          <div className="flex min-w-0 items-start gap-5">
            <span
              aria-hidden="true"
              className="flex h-[72px] w-[72px] shrink-0 items-center justify-center rounded-2xl text-3xl font-bold uppercase text-white shadow-lg"
              style={avatarStyle(request.normalizedDomain)}
            >
              {request.companyName.trim().charAt(0) || "?"}
            </span>

            <div className="min-w-0">
              <h1 className="max-w-none text-[30px] font-bold leading-tight tracking-[-0.02em] text-foreground sm:text-[34px]">
                {request.companyName}
              </h1>
              <a
                href={request.websiteUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-1 inline-flex items-center gap-1.5 text-[15px] text-muted-foreground hover:text-foreground"
              >
                {request.normalizedDomain}
                <ArrowUpRight size={14} strokeWidth={2} />
              </a>
              <div className="mt-3 flex flex-wrap gap-2">
                <span
                  className={cn(ui.pill, toneClass[requestStatusTone(request.status)])}
                >
                  {humanize(request.status)}
                </span>
                {payload ? (
                  <span className={cn(ui.pill, toneClass.neutral)}>
                    AI answer snapshot
                  </span>
                ) : null}
                {integrity ? (
                  <span className={cn(ui.pill, toneClass[integrity.tone])}>
                    {integrity.label}
                  </span>
                ) : null}
              </div>
            </div>
          </div>

          {artifact && publication ? (
            <div className="flex flex-col items-start gap-2 lg:items-end">
              <div className="flex flex-wrap items-start gap-2 lg:justify-end">
                <SendReportButton
                  requestId={request.id}
                  recipientEmail={request.workEmail}
                  alreadyDelivered={Boolean(
                    artifact.deliveredAt
                  )}
                  expectedArtifactId={artifact.id}
                  expectedRevision={publication.revision}
                  deliveryClaimActive={
                    artifact.deliveryClaimActive
                  }
                  needsReview={
                    artifact.integrityStatus !== "integrity_passed"
                  }
                />

                <details className="group relative">
                  <summary
                    className={cn(
                      ui.btnOutline,
                      "cursor-pointer list-none [&::-webkit-details-marker]:hidden"
                    )}
                  >
                    Download report
                    <ChevronDown
                      size={16}
                      className="transition-transform group-open:rotate-180"
                    />
                  </summary>
                  <div className="absolute right-0 z-20 mt-2 w-72 overflow-hidden rounded-xl border border-border bg-popover p-1 shadow-xl">
                    <a
                      href={`/api/internal/snapshot-requests/${request.id}/reports/short`}
                      className="flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm text-foreground hover:bg-muted"
                    >
                      <FileText size={16} className="text-muted-foreground" />
                      <span className="min-w-0 flex-1">
                        <span className="block font-medium">Short report</span>
                        <span className="block truncate font-mono text-[11px] text-muted-foreground">
                          {artifact.shortReportFilename}
                        </span>
                      </span>
                    </a>
                    <a
                      href={`/api/internal/snapshot-requests/${request.id}/reports/full`}
                      className="flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm text-foreground hover:bg-muted"
                    >
                      <FileText size={16} className="text-muted-foreground" />
                      <span className="min-w-0 flex-1">
                        <span className="block font-medium">Full report</span>
                        <span className="block truncate font-mono text-[11px] text-muted-foreground">
                          {artifact.fullReportFilename}
                        </span>
                      </span>
                    </a>
                  </div>
                </details>

                {blocked ? (
                  <span
                    className={cn(ui.btnOutline, "pointer-events-none opacity-60")}
                    title="A blocked report is never readable by the client."
                  >
                    <Lock size={15} strokeWidth={2} />
                    Blocked — not viewable
                  </span>
                ) : (
                  <a
                    href={`/report/${artifact.publicToken}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={ui.btnPrimary}
                  >
                    Open client report
                    <ArrowUpRight size={16} strokeWidth={2.2} />
                  </a>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                Generated {formatDate(artifact.generatedAt)} · Delivered{" "}
                {artifact.deliveredAt ? formatDate(artifact.deliveredAt) : "No"}
              </p>
            </div>
          ) : null}
        </div>

        {/* ------------------------------------------ approval decision */}
        {request.status ===
        "pending_approval" ? (
          <section className={cn(ui.panel, "mt-6 p-6")}>
            <div className="flex items-start gap-4">
              <IconTile tone="warning">
                <ShieldCheck size={20} strokeWidth={1.9} />
              </IconTile>
              <div>
                <h2 className="max-w-none text-lg font-semibold leading-snug tracking-tight text-foreground">
                  Approval decision
                </h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  Review the question and competitor frame, then approve or
                  reject. Approving stores the frame and queues one baseline
                  job; rejecting means no AI scan runs.
                </p>
              </div>
            </div>

            <div className="mt-5 flex flex-col gap-6 md:flex-row md:items-end md:justify-between">
              <ApproveButton
                requestId={request.id}
                competitors={request.competitors}
                scannedCompany={request.companyName}
                scannedDomain={request.normalizedDomain}
              />

              <RejectButton
                requestId={request.id}
              />
            </div>
          </section>
        ) : null}

        {/* --------------------------------------------- buyer question */}
        <section className={cn(ui.panel, "mt-6 overflow-hidden")}>
          <div className="p-6 sm:p-7">
            <p className={ui.label}>Buyer question</p>
            <h2 className="mt-3 max-w-4xl text-2xl font-bold leading-snug tracking-[-0.015em] text-foreground sm:text-[28px]">
              {request.buyerCategory}
            </h2>
            {payload &&
            payload.question.text.trim() !== request.buyerCategory.trim() ? (
              <p className="mt-3 text-sm text-muted-foreground">
                Approved wording (version {payload.question.versionNumber}):{" "}
                <span className="text-foreground">{payload.question.text}</span>
              </p>
            ) : null}
          </div>

          <dl className="grid gap-px border-t border-border bg-border sm:grid-cols-2 lg:grid-cols-5">
            <MetaItem icon={<Building2 size={18} />} label="Company">
              {request.companyName}
            </MetaItem>
            <MetaItem icon={<User size={18} />} label="Contact">
              {request.contactName || "—"}
              <a
                href={`mailto:${request.workEmail}`}
                className="mt-0.5 block text-xs font-normal text-muted-foreground hover:text-foreground hover:underline"
              >
                {request.workEmail}
              </a>
            </MetaItem>
            <MetaItem icon={<CalendarDays size={18} />} label="Requested">
              {formatDate(
                request.createdAt
              )}
            </MetaItem>
            <MetaItem icon={<Activity size={18} />} label="Status">
              <span
                className={cn(ui.pill, "mt-0.5", toneClass[requestStatusTone(request.status)])}
              >
                {humanize(request.status)}
              </span>
            </MetaItem>
            <MetaItem icon={<Hash size={18} />} label="Report ID">
              {artifact ? (
                <span className="font-mono text-xs font-normal">
                  {artifact.id}
                </span>
              ) : (
                <span className="font-normal text-muted-foreground">
                  No report yet
                </span>
              )}
            </MetaItem>
          </dl>
        </section>

        {/* ------------------------------------------------- metrics */}
        {payload && reconciliation && observation ? (
          <>
            <section className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Metric
                icon={<Layers size={20} strokeWidth={1.9} />}
                tone="success"
                label="Runs completed"
                value={
                  <>
                    {reconciliation.completed}
                    <span className="ml-2 text-sm font-normal text-muted-foreground">
                      of {reconciliation.planned} planned
                    </span>
                  </>
                }
                hint={`${reconciliation.attempted} attempted · ${reconciliation.failed} failed · ${reconciliation.excludedByReview} excluded`}
              >
                <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-primary"
                    style={{ width: `${completedShare}%` }}
                  />
                </div>
              </Metric>
              <Metric
                icon={<Eye size={20} strokeWidth={1.9} />}
                tone="info"
                label="Readable results"
                value={observation.denominator}
                hint={
                  observation.denominator === 0
                    ? "No readable runs"
                    : `${observation.numerator} named the brand`
                }
              />
              <Metric
                icon={<ChartNoAxesColumn size={20} strokeWidth={2} />}
                tone="neutral"
                label={observation.metric.replace(/_/g, " ")}
                value={
                  observation.rate === null
                    ? "Not measured"
                    : percent(observation.rate)
                }
                hint={
                  observation.rate === null
                    ? "Rate not reported"
                    : `${observation.numerator} of ${plural(
                        observation.denominator,
                        "readable run"
                      )}`
                }
              />
              <Metric
                icon={<ChartLine size={20} strokeWidth={1.9} />}
                tone="neutral"
                label="95% confidence interval"
                value={
                  observation.interval
                    ? `${percent(observation.interval.low)} – ${percent(
                        observation.interval.high
                      )}`
                    : "Not available"
                }
                hint="Wilson, from this sample"
              />
            </section>

            {/* ------------------------------------ what this report is */}
            <section className={cn(ui.panel, "mt-4 flex flex-col gap-5 p-6 sm:flex-row")}>
              <IconTile>
                <FileText size={20} strokeWidth={1.9} />
              </IconTile>
              <div className="min-w-0 flex-1">
                <h2 className="max-w-none text-lg font-semibold leading-snug tracking-tight text-foreground">
                  What this report is
                </h2>
                <p className="mt-2 max-w-3xl text-[15px] leading-relaxed text-muted-foreground">
                  This records what {payload.protocol.provider} returned when
                  asked this buyer question,{" "}
                  {plural(reconciliation.attempted, "time")}. It is a
                  directional reading of one surface, not a measure of how all
                  AI assistants describe you.
                </p>
                <div className="mt-4 flex flex-wrap gap-2">
                  <span className={ui.chip}>
                    Surface: {payload.protocol.provider} ({payload.protocol.surface})
                  </span>
                  <span className={ui.chip}>Model: {payload.protocol.model}</span>
                  <span className={ui.chip}>
                    Methodology v{payload.protocol.methodologyVersion}
                  </span>
                  <span className={ui.chip}>
                    Generated {payload.generatedAt.slice(0, 10)}
                  </span>
                  <span className={ui.chip}>Single surface</span>
                  <span className={ui.chip}>Prompt-scoped</span>
                </div>
                <div className="mt-4 flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <p className={ui.label}>Prompt hash</p>
                    <p className="mt-1 break-all font-mono text-xs text-foreground">
                      {payload.question.hash}
                    </p>
                  </div>
                  <CopyButton value={payload.question.hash} label="Copy prompt hash" />
                </div>
              </div>
            </section>

            {/* ---------------------------------------- key takeaways */}
            <Disclosure
              defaultOpen
              icon={<ListChecks size={20} strokeWidth={1.9} />}
              title="Key takeaways"
              description="A quick summary of what this report shows and what it doesn't."
            >
              <ul className="space-y-3 rounded-xl border border-success/25 bg-success/5 p-5">
                {buildTakeaways(payload).map((item) => (
                  <li key={item.text} className="flex items-start gap-3 text-sm">
                    {item.kind === "fact" ? (
                      <CircleCheck size={17} className="mt-0.5 shrink-0 text-success" />
                    ) : item.kind === "alert" ? (
                      <TriangleAlert size={17} className="mt-0.5 shrink-0 text-destructive" />
                    ) : (
                      <Info size={17} className="mt-0.5 shrink-0 text-muted-foreground" />
                    )}
                    <span
                      className={cn(
                        "text-foreground",
                        item.kind === "alert" && "font-semibold text-destructive"
                      )}
                    >
                      {item.text}
                    </span>
                  </li>
                ))}
              </ul>
            </Disclosure>

            {/* ---------------------------------------------- run by run */}
            <Disclosure
              icon={<Play size={20} strokeWidth={1.9} />}
              title="Run by run"
              description="Details for each attempted run, including status and any exclusions."
              badge={
                <span className="rounded-full border border-border px-2.5 py-1 text-xs text-muted-foreground">
                  {plural(payload.runs.length, "run")}
                </span>
              }
            >
              <div className="overflow-x-auto rounded-xl border border-border">
                <table className="w-full min-w-[760px] border-collapse text-sm">
                  <thead>
                    <tr className="bg-muted/50 text-left">
                      {["Run", "Status", "Your brand", "Other brands named", "Sources", "Evidence"].map(
                        (heading) => (
                          <th
                            key={heading}
                            className="whitespace-nowrap border-b border-border px-4 py-3 text-[11px] font-semibold uppercase tracking-[0.1em] text-muted-foreground"
                          >
                            {heading}
                          </th>
                        )
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {payload.runs.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="px-4 py-6 text-center text-muted-foreground">
                          No runs recorded.
                        </td>
                      </tr>
                    ) : (
                      payload.runs.map((item, index) => (
                        <tr
                          key={`${item.ordinal}-${index}`}
                          className="border-b border-border align-top last:border-b-0"
                        >
                          <td className="px-4 py-3 text-foreground">
                            {item.ordinal}
                            {item.retryOfOrdinal !== null ? (
                              <span className="block text-xs text-muted-foreground">
                                retry of {item.retryOfOrdinal}
                              </span>
                            ) : null}
                          </td>
                          <td className="px-4 py-3">
                            <span className="flex items-start gap-2">
                              <span
                                className={cn(
                                  "mt-1.5 h-2 w-2 shrink-0 rounded-full",
                                  dotClass[runStatusTone(item.status)]
                                )}
                              />
                              <span className="text-foreground">
                                {humanize(item.status)}
                                {item.terminationReason ? (
                                  <span className="block text-xs text-muted-foreground [overflow-wrap:anywhere]">
                                    {item.terminationReason}
                                  </span>
                                ) : null}
                              </span>
                            </span>
                          </td>
                          <td
                            className={cn(
                              "px-4 py-3",
                              item.brandPresent ? "text-success" : "text-muted-foreground"
                            )}
                          >
                            {item.brandPresent === null
                              ? "No readable result"
                              : item.brandPresent
                                ? "Present"
                                : "Not present"}
                          </td>
                          <td className="px-4 py-3 text-foreground">
                            {item.competitors.length > 0
                              ? item.competitors.join(", ")
                              : "None"}
                          </td>
                          <td className="px-4 py-3 text-foreground">
                            {item.citedSourceCount}
                          </td>
                          <td
                            className="px-4 py-3 font-mono text-xs text-muted-foreground"
                            title={item.evidenceHash ?? undefined}
                          >
                            {item.evidenceHash
                              ? `${item.evidenceHash.slice(0, 12)}…`
                              : "—"}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>

              <p
                className={cn(
                  "mt-4 rounded-xl border px-4 py-3 text-sm",
                  reconciliation.accountedFor ? toneClass.warning : toneClass.danger
                )}
              >
                <strong className="font-semibold">Every attempt is accounted for.</strong>{" "}
                <span className="text-foreground">
                  {reconciliation.attempted} attempted · {reconciliation.completed}{" "}
                  completed · {reconciliation.failed} failed ·{" "}
                  {reconciliation.excludedByReview} excluded after review ·{" "}
                  {reconciliation.retried} retried · {reconciliation.excludedNoResult}{" "}
                  completed without a readable result.
                </span>
                {reconciliation.accountedFor ? null : (
                  <strong className="font-semibold">
                    {" "}
                    These counts do not reconcile and this report requires review.
                  </strong>
                )}
              </p>
            </Disclosure>
          </>
        ) : null}

        {/* ----------------------------------------- founder review */}
        {reviewState ? (
          <ReviewPanel
            requestId={requestId}
            state={reviewState}
          />
        ) : null}

        {/* ----------------------------------------- request details */}
        <section className={cn(ui.panel, "mt-4 p-6")}>
          <h2 className="max-w-none text-lg font-semibold leading-snug tracking-tight text-foreground">
            Request details
          </h2>
          <dl className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <DetailRow label="Website">
              <a
                href={request.websiteUrl}
                target="_blank"
                rel="noreferrer"
                className="text-primary hover:underline"
              >
                {request.websiteUrl}
              </a>
            </DetailRow>

            <DetailRow label="Progress">
              {request.progressStage
                ? humanize(
                    request.progressStage
                  )
                : "—"}
            </DetailRow>

            <DetailRow label="Updated">
              {formatDate(
                request.updatedAt
              )}
            </DetailRow>

            <DetailRow label="Approval">
              {request.approvedAt
                ? "Approved"
                : "Not approved yet"}
            </DetailRow>

            <DetailRow label="Approved at">
              {formatDate(
                request.approvedAt
              )}
            </DetailRow>

            {/*
              Founder-only review metadata. `approvedBy` is an internal auth
              user id and is deliberately not surfaced on the public report
              page — this detail page is gated by requireFounderForPage.
            */}
            <DetailRow label="Approved by">
              <span className="font-mono text-xs">
                {request.approvedBy || "—"}
              </span>
            </DetailRow>

            <DetailRow label="Baseline protocol">
              {request.protocolId
                ? `${request.protocolId} (one baseline job queued for the existing worker)`
                : "—"}
            </DetailRow>

            {/*
              §5 of the signed-off OUTCOME_COMPARISON_PROPOSAL: the sampling
              power of an approved plan must be visible at the point of
              approval, before any run exists. Stamped by approve_protocol
              (migration 0075); null for protocols approved before it.
            */}
            <DetailRow label="Detectable change at plan">
              <DetectableChangeDisclosure protocol={protocol} />
            </DetailRow>

            <DetailRow label="Project ID">
              <span className="font-mono text-xs">
                {request.projectId || "—"}
              </span>
            </DetailRow>

            <DetailRow label="Request ID">
              <span className="font-mono text-xs">{request.id}</span>
            </DetailRow>
          </dl>
        </section>

        {/* ------------------------------------------- stored report */}
        {artifact && publication ? (
          <>
            <ReplaceReportPanel
              requestId={request.id}
              state={publication}
            />

            <p className="mt-4 text-xs text-muted-foreground">
              Short report:{" "}
              {artifact.shortReportMarkdown.length.toLocaleString(
                "en-US"
              )}{" "}
              characters · Full report:{" "}
              {artifact.fullReportMarkdown.length.toLocaleString(
                "en-US"
              )}{" "}
              characters · Delivered:{" "}
              {artifact.deliveredAt
                ? formatDate(
                    artifact.deliveredAt
                  )
                : "No"}
            </p>

            <div className="mt-4 grid gap-4 xl:grid-cols-2">
              <ReportPreview
                heading="Short report"
                filename={
                  artifact.shortReportFilename
                }
                markdown={
                  artifact.shortReportMarkdown
                }
                downloadHref={`/api/internal/snapshot-requests/${request.id}/reports/short`}
              />

              <ReportPreview
                heading="Full report"
                filename={
                  artifact.fullReportFilename
                }
                markdown={
                  artifact.fullReportMarkdown
                }
                downloadHref={`/api/internal/snapshot-requests/${request.id}/reports/full`}
              />
            </div>
          </>
        ) : (
          <section className={cn(ui.panel, "mt-4 flex flex-col items-center px-6 py-12 text-center")}>
            <IconTile>
              <FileText size={20} strokeWidth={1.9} />
            </IconTile>
            <h2 className="mt-4 max-w-none text-lg font-semibold leading-snug tracking-tight text-foreground">
              Snapshot report
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              No persisted report is available yet.
            </p>
            {/* This used to say the report would appear once "the approved
                runner persists it". No deployed process builds a report: the
                worker image ships the protocol worker alone. Waiting on that
                sentence would wait forever, so it names the action instead. */}
            <p className="mt-1 text-sm text-muted-foreground">
              Once the scan has finished, click Regenerate report in the
              Founder review panel above to build it.
            </p>
          </section>
        )}
      </main>

      <footer className="border-t border-border">
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-3 px-6 py-5 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-2">
            <Info size={14} />
            Founder-only view. Clients read the report through its private
            link, never this page.
          </span>
          <span>Zypact · Founder operations</span>
        </div>
      </footer>
    </AdminThemeRoot>
  );
}
