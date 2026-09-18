"use client";

import { useMemo, useState } from "react";
import {
  CircleCheck,
  CircleDot,
  Clock,
  FlaskConical,
  Plus,
  Search,
  TriangleAlert,
} from "lucide-react";

import type { RegistrableBaseline } from "@/lib/interventions/admin-reads";
import { INTERVENTION_STATUSES } from "@/lib/interventions/types";
import {
  ACTION_TYPE_LABELS,
  ELIGIBILITY_DOT,
  nonImplementedEligibilityLabel,
  statusPresentation,
} from "./presentation";
import { RegisterDrawer } from "./register-drawer";

export interface InterventionRow {
  id: string;
  status: string;
  hypothesis: string;
  actionType: string;
  actionTarget: string;
  companyName: string | null;
  domain: string | null;
  evidenceCount: number;
  createdAt: string;
  created: { date: string; time: string } | null;
  implemented: { date: string; time: string } | null;
  eligibility: {
    label: string;
    tone: "neutral" | "waiting" | "ready" | "deviation";
    eligible: boolean;
    windowClosesAt: string | null;
  } | null;
}

type Filter = "all" | (typeof INTERVENTION_STATUSES)[number];
type SortKey = "newest" | "oldest" | "company";

export function InterventionsTable({
  rows,
  baselines,
  actionsEnabled,
}: {
  rows: InterventionRow[];
  baselines: RegistrableBaseline[];
  actionsEnabled: boolean;
}) {
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortKey>("newest");
  const [drawerOpen, setDrawerOpen] = useState(false);

  const counts = useMemo(() => {
    const c: Record<Filter, number> = {
      all: rows.length, proposed: 0, approved: 0, implemented: 0, rejected: 0, abandoned: 0,
    };
    for (const r of rows) if (r.status in c) c[r.status as Filter] += 1;
    return c;
  }, [rows]);

  const ready = rows.filter((r) => r.eligibility?.eligible).length;

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = rows.filter(
      (r) =>
        (filter === "all" || r.status === filter) &&
        (!q ||
          [r.hypothesis, r.companyName, r.domain, r.actionTarget]
            .filter(Boolean)
            .some((v) => (v as string).toLowerCase().includes(q)))
    );
    return [...list].sort((a, b) => {
      if (sort === "company") return (a.companyName ?? a.domain ?? "").localeCompare(b.companyName ?? b.domain ?? "");
      const diff = a.createdAt.localeCompare(b.createdAt);
      return sort === "oldest" ? diff : -diff;
    });
  }, [rows, filter, query, sort]);

  const tabs: Filter[] = ["all", ...INTERVENTION_STATUSES];

  return (
    <>
      <div className="zpa-page-head">
        <div>
          <p className="zpa-eyebrow">Registered retest</p>
          <h1 className="zpa-title">Interventions</h1>
          <p className="zpa-subtitle">
            Register an intervention before it goes live, so the retest measures a
            claim that was fixed in advance.
          </p>
        </div>
        <button
          type="button"
          className="zpa-btn zpa-btn-primary"
          onClick={() => setDrawerOpen(true)}
          disabled={!actionsEnabled}
          title={actionsEnabled ? undefined : "Intervention actions are disabled on this deployment"}
        >
          <Plus size={16} strokeWidth={2.2} />
          Register intervention
        </button>
      </div>

      {!actionsEnabled ? (
        <div className="zpi-banner" role="status">
          <TriangleAlert size={16} strokeWidth={2} />
          <span>
            Intervention actions are disabled on this deployment. Set{" "}
            <code>INTERVENTION_ADMIN_ENABLED=true</code> to register, approve or
            change interventions. This list is read-only until then.
          </span>
        </div>
      ) : null}

      <div className="zpa-stats">
        <div className="zpa-stat">
          <div>
            <p className="zpa-stat-value">{counts.all}</p>
            <p className="zpa-stat-label">Total interventions</p>
          </div>
          <span className="zpa-stat-icon"><FlaskConical size={19} strokeWidth={1.8} /></span>
        </div>
        <div className="zpa-stat tone-amber">
          <div>
            <p className="zpa-stat-value">{counts.proposed}</p>
            <p className="zpa-stat-label">Awaiting approval</p>
          </div>
          <span className="zpa-stat-icon"><Clock size={19} strokeWidth={1.8} /></span>
        </div>
        <div className="zpa-stat tone-blue">
          <div>
            <p className="zpa-stat-value">{counts.implemented}</p>
            <p className="zpa-stat-label">Implemented</p>
          </div>
          <span className="zpa-stat-icon"><CircleDot size={19} strokeWidth={1.8} /></span>
        </div>
        <div className="zpa-stat tone-green">
          <div>
            <p className="zpa-stat-value">{ready}</p>
            <p className="zpa-stat-label">Retest ready</p>
          </div>
          <span className="zpa-stat-icon"><CircleCheck size={19} strokeWidth={1.8} /></span>
        </div>
      </div>

      <div className="zpa-toolbar">
        <div className="zpa-tabs">
          {tabs.map((tab) => (
            <button
              key={tab}
              type="button"
              className={`zpa-tab${filter === tab ? " is-active" : ""}`}
              onClick={() => setFilter(tab)}
            >
              {tab === "all" ? "All" : statusPresentation(tab).label} ({counts[tab]})
            </button>
          ))}
        </div>
        <div className="zpa-toolbar-right">
          <label className="zpa-search">
            <Search size={16} strokeWidth={1.9} />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search hypotheses, companies, targets…"
              aria-label="Search interventions"
            />
          </label>
          <select
            className="zpa-select"
            value={sort}
            onChange={(e) => setSort(e.target.value as SortKey)}
            aria-label="Sort interventions"
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
            <p className="zpa-empty-title">
              {rows.length === 0 ? "No interventions yet" : "No interventions match"}
            </p>
            <p>
              {rows.length === 0
                ? "Register one against an approved baseline once its evidence suggests a change worth testing."
                : "Try another filter or clear the search."}
            </p>
          </div>
        ) : (
          <div className="zpa-table-scroll">
            <table className="zpa-table">
              <thead>
                <tr>
                  <th>Intervention</th>
                  <th>Company</th>
                  <th>Action</th>
                  <th>Status</th>
                  <th>Implemented</th>
                  <th>Retest</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {visible.map((row) => {
                  const status = statusPresentation(row.status);
                  return (
                    <tr key={row.id}>
                      <td>
                        <a href={`/admin/interventions/${row.id}`} className="zpi-hypothesis">
                          {row.hypothesis}
                        </a>
                        <p className="zpa-muted zpi-sub">
                          {row.evidenceCount === 0
                            ? "No supporting runs cited"
                            : `${row.evidenceCount} supporting run${row.evidenceCount === 1 ? "" : "s"}`}
                        </p>
                      </td>
                      <td>
                        <div className="zpa-company">
                          <p className="zpa-company-name">{row.companyName ?? row.domain ?? "—"}</p>
                          {row.companyName && row.domain ? (
                            <p className="zpa-company-domain">{row.domain}</p>
                          ) : null}
                        </div>
                      </td>
                      <td>
                        <span className="zpi-chip">{ACTION_TYPE_LABELS[row.actionType] ?? row.actionType}</span>
                      </td>
                      <td>
                        <span className={`zpa-pill${status.tone === "neutral" ? "" : ` tone-${status.tone}`}`}>
                          <span className="zpa-pill-label">{status.label}</span>
                        </span>
                      </td>
                      <td className="zpa-date">
                        {row.implemented ? (
                          <>
                            <span>{row.implemented.date}</span>
                            <span className="zpa-muted">{row.implemented.time}</span>
                          </>
                        ) : (
                          <span className="zpa-muted">—</span>
                        )}
                      </td>
                      <td>
                        {row.eligibility ? (
                          <span className="zpi-elig">
                            <span className="zpi-dot" style={{ background: ELIGIBILITY_DOT[row.eligibility.tone] }} />
                            {row.eligibility.label}
                          </span>
                        ) : (
                          <span className="zpi-elig zpa-muted">
                            <span className="zpi-dot" style={{ background: ELIGIBILITY_DOT.neutral }} />
                            {nonImplementedEligibilityLabel(row.status)}
                          </span>
                        )}
                      </td>
                      <td className="zpa-actions">
                        <a href={`/admin/interventions/${row.id}`} className="zpa-btn zpa-btn-sm">View</a>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {drawerOpen ? (
        <RegisterDrawer baselines={baselines} onClose={() => setDrawerOpen(false)} />
      ) : null}
    </>
  );
}
