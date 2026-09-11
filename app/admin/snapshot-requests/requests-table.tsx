"use client";

import { useMemo, useState } from "react";
import {
  CircleCheck,
  Clock,
  Mail,
  ScrollText,
  Search,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";

import type { PipelineRowState } from "@/lib/reports/pipeline-row-state";
import { RunPipelineButton } from "./run-pipeline-button";

/**
 * The founder request list: counts, filters, search, sort and paging.
 *
 * All of it runs against the rows the server already loaded (capped at 100 by
 * the page query), so filtering never re-queries and never re-reads evidence.
 * Dates arrive pre-formatted from the server — formatting them here would
 * render a different string on the client than in the SSR pass.
 */

export interface RequestRow {
  id: string;
  companyName: string;
  normalizedDomain: string;
  websiteUrl: string;
  contactName: string | null;
  workEmail: string;
  buyerQuestion: string;
  status: string;
  progressStage: string | null;
  createdAt: string;
  createdDate: string;
  createdTime: string;
  pipeline: PipelineRowState;
}

const PAGE_SIZE = 10;

type FilterKey =
  | "all"
  | "approved"
  | "pending_verification"
  | "delivered"
  | "rejected";

type SortKey = "newest" | "oldest" | "company";

type Tone = "green" | "amber" | "blue" | "red" | "neutral";

const STATUS_PRESENTATION: Record<
  string,
  { label: string; note?: string; tone: Tone }
> = {
  pending_verification: {
    label: "Pending",
    note: "Verification required",
    tone: "amber",
  },
  verified: { label: "Verified", note: "Awaiting review", tone: "blue" },
  pending_approval: {
    label: "Pending",
    note: "Approval required",
    tone: "amber",
  },
  approved: { label: "Approved", tone: "green" },
  queued: { label: "Queued", tone: "blue" },
  running: { label: "Running", tone: "blue" },
  quality_review: { label: "Quality review", tone: "amber" },
  needs_founder_review: {
    label: "Needs review",
    note: "Founder review",
    tone: "amber",
  },
  report_ready: { label: "Report ready", tone: "green" },
  qa_failed: { label: "QA failed", tone: "red" },
  failed: { label: "Failed", tone: "red" },
  rejected: { label: "Rejected", tone: "red" },
  expired: { label: "Expired", tone: "neutral" },
};

function humanize(value: string): string {
  return value
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

/**
 * Stable monogram tint. Derived from the domain rather than fetched from a
 * favicon service, which would hand a prospect's domain to a third party on
 * every page load.
 */
function avatarStyle(seed: string): React.CSSProperties {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) % 360;
  }

  return {
    background: `hsl(${hash} 42% 17%)`,
    borderColor: `hsl(${hash} 40% 26%)`,
    color: `hsl(${hash} 68% 70%)`,
  };
}

function StatusPill({ status }: { status: string }) {
  const presentation = STATUS_PRESENTATION[status] ?? {
    label: humanize(status),
    tone: "neutral" as Tone,
  };

  const icon =
    presentation.tone === "green" ? (
      <CircleCheck size={14} strokeWidth={2} />
    ) : presentation.tone === "amber" ? (
      <Clock size={14} strokeWidth={2} />
    ) : null;

  return (
    <span className={`zpa-pill tone-${presentation.tone}`}>
      {icon}
      <span className="zpa-pill-label">
        {presentation.label}
        {presentation.note ? (
          <span className="zpa-pill-note">{presentation.note}</span>
        ) : null}
      </span>
    </span>
  );
}

function matchesFilter(row: RequestRow, filter: FilterKey): boolean {
  switch (filter) {
    case "all":
      return true;
    case "approved":
      return row.status === "approved";
    case "pending_verification":
      return row.status === "pending_verification";
    case "delivered":
      return row.pipeline.delivered;
    case "rejected":
      return row.status === "rejected";
  }
}

export function RequestsTable({ rows }: { rows: RequestRow[] }) {
  const [filter, setFilter] = useState<FilterKey>("all");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortKey>("newest");
  const [page, setPage] = useState(1);

  const counts = useMemo(
    () => ({
      all: rows.length,
      approved: rows.filter((row) => row.status === "approved").length,
      pending_verification: rows.filter(
        (row) => row.status === "pending_verification"
      ).length,
      delivered: rows.filter((row) => row.pipeline.delivered).length,
      rejected: rows.filter((row) => row.status === "rejected").length,
    }),
    [rows]
  );

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();

    const matched = rows.filter((row) => {
      if (!matchesFilter(row, filter)) return false;
      if (needle === "") return true;

      return [
        row.companyName,
        row.normalizedDomain,
        row.workEmail,
        row.contactName ?? "",
        row.buyerQuestion,
      ].some((field) => field.toLowerCase().includes(needle));
    });

    const sorted = [...matched];

    sorted.sort((a, b) => {
      if (sort === "company") {
        return a.companyName.localeCompare(b.companyName);
      }

      const order = a.createdAt.localeCompare(b.createdAt);
      return sort === "oldest" ? order : -order;
    });

    return sorted;
  }, [rows, filter, query, sort]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const start = (currentPage - 1) * PAGE_SIZE;
  const visible = filtered.slice(start, start + PAGE_SIZE);

  function apply<T>(setter: (value: T) => void) {
    return (value: T) => {
      setter(value);
      setPage(1);
    };
  }

  const tabs: { key: FilterKey; label: string }[] = [
    { key: "all", label: "All" },
    { key: "approved", label: "Approved" },
    { key: "pending_verification", label: "Pending verification" },
    { key: "delivered", label: "Delivered" },
    { key: "rejected", label: "Rejected" },
  ];

  return (
    <>
      <div className="zpa-stats">
        <div className="zpa-stat">
          <div>
            <p className="zpa-stat-value">{counts.all}</p>
            <p className="zpa-stat-label">Total requests</p>
          </div>
          <span className="zpa-stat-icon">
            <ScrollText size={19} strokeWidth={1.8} />
          </span>
        </div>

        <div className="zpa-stat tone-green">
          <div>
            <p className="zpa-stat-value">{counts.approved}</p>
            <p className="zpa-stat-label">Approved</p>
          </div>
          <span className="zpa-stat-icon">
            <CircleCheck size={19} strokeWidth={1.8} />
          </span>
        </div>

        <div className="zpa-stat tone-amber">
          <div>
            <p className="zpa-stat-value">
              {counts.pending_verification}
            </p>
            <p className="zpa-stat-label">Pending verification</p>
          </div>
          <span className="zpa-stat-icon">
            <Clock size={19} strokeWidth={1.8} />
          </span>
        </div>

        <div className="zpa-stat tone-blue">
          <div>
            <p className="zpa-stat-value">{counts.delivered}</p>
            <p className="zpa-stat-label">Reports delivered</p>
          </div>
          <span className="zpa-stat-icon">
            <Mail size={19} strokeWidth={1.8} />
          </span>
        </div>
      </div>

      <div className="zpa-toolbar">
        <div className="zpa-tabs">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              type="button"
              className={`zpa-tab${
                filter === tab.key ? " is-active" : ""
              }`}
              onClick={() => apply(setFilter)(tab.key)}
            >
              {tab.label} ({counts[tab.key]})
            </button>
          ))}
        </div>

        <div className="zpa-toolbar-right">
          <label className="zpa-search">
            <Search size={16} strokeWidth={1.9} />
            <input
              type="search"
              value={query}
              onChange={(event) =>
                apply(setQuery)(event.target.value)
              }
              placeholder="Search companies, emails, or questions…"
              aria-label="Search requests"
            />
          </label>

          <select
            className="zpa-select"
            value={sort}
            onChange={(event) =>
              apply(setSort)(event.target.value as SortKey)
            }
            aria-label="Sort requests"
          >
            <option value="newest">Newest first</option>
            <option value="oldest">Oldest first</option>
            <option value="company">Company A–Z</option>
          </select>
        </div>
      </div>

      <div className="zpa-card">
        {visible.length === 0 ? (
          <div className="zpa-empty">
            <p className="zpa-empty-title">No requests match</p>
            <p>
              {rows.length === 0
                ? "No snapshot requests have been submitted yet."
                : "Try another filter or clear the search."}
            </p>
          </div>
        ) : (
          <div className="zpa-table-scroll">
            <table className="zpa-table">
              <thead>
                <tr>
                  <th>Company</th>
                  <th>Contact</th>
                  <th>Buyer question</th>
                  <th>Status</th>
                  <th>Progress</th>
                  <th>Requested</th>
                  <th>Actions</th>
                </tr>
              </thead>

              <tbody>
                {visible.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <div className="zpa-company">
                        <span
                          className="zpa-avatar"
                          style={avatarStyle(row.normalizedDomain)}
                          aria-hidden="true"
                        >
                          {row.companyName.trim().charAt(0) || "?"}
                        </span>
                        <div>
                          <p className="zpa-company-name">
                            {row.companyName}
                          </p>
                          <a
                            className="zpa-company-domain"
                            href={row.websiteUrl}
                            target="_blank"
                            rel="noreferrer"
                          >
                            {row.normalizedDomain}
                          </a>
                        </div>
                      </div>
                    </td>

                    <td>
                      {row.contactName ? (
                        <div className="zpa-contact-name">
                          {row.contactName}
                        </div>
                      ) : null}
                      <a
                        className="zpa-contact-email"
                        href={`mailto:${row.workEmail}`}
                      >
                        {row.workEmail}
                      </a>
                    </td>

                    <td className="zpa-question">
                      {row.buyerQuestion}
                    </td>

                    <td>
                      <StatusPill status={row.status} />
                    </td>

                    <td className="zpa-muted">
                      {row.progressStage
                        ? humanize(row.progressStage)
                        : "—"}
                    </td>

                    <td className="zpa-date">
                      {row.createdDate}
                      <span>{row.createdTime}</span>
                    </td>

                    <td>
                      <div className="zpa-actions">
                        <a
                          className="zpa-btn zpa-btn-sm"
                          href={`/admin/snapshot-requests/${row.id}`}
                        >
                          View
                        </a>

                        {row.status === "approved" ? (
                          <RunPipelineButton
                            requestId={row.id}
                            state={row.pipeline}
                          />
                        ) : null}

                        {/* Approval happens on the detail page, which is the
                            only place the founder can review and supply the
                            competitor frame. Approving from a table row would
                            mean approving without that context. */}
                        {row.status === "pending_approval" ? (
                          <a
                            className="zpa-btn zpa-btn-sm zpa-btn-primary"
                            href={`/admin/snapshot-requests/${row.id}`}
                          >
                            Review
                          </a>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="zpa-table-foot">
        <span>
          {filtered.length === 0
            ? "No requests to show"
            : `Showing ${start + 1}–${
                start + visible.length
              } of ${filtered.length} request${
                filtered.length === 1 ? "" : "s"
              }`}
        </span>

        <div className="zpa-pager">
          <button
            type="button"
            className="zpa-pager-btn"
            onClick={() => setPage(currentPage - 1)}
            disabled={currentPage <= 1}
            aria-label="Previous page"
          >
            <ChevronLeft size={16} strokeWidth={2} />
          </button>

          {Array.from({ length: pageCount }, (_, index) => index + 1).map(
            (number) => (
              <button
                key={number}
                type="button"
                className={`zpa-pager-btn${
                  number === currentPage ? " is-active" : ""
                }`}
                onClick={() => setPage(number)}
                aria-current={
                  number === currentPage ? "page" : undefined
                }
              >
                {number}
              </button>
            )
          )}

          <button
            type="button"
            className="zpa-pager-btn"
            onClick={() => setPage(currentPage + 1)}
            disabled={currentPage >= pageCount}
            aria-label="Next page"
          >
            <ChevronRight size={16} strokeWidth={2} />
          </button>
        </div>
      </div>
    </>
  );
}
