import { getDb } from "@/lib/db";
import { requireFounderForPage } from "@/lib/auth/founder";
import {
  FOUNDER_ADMIN_PATH,
} from "@/lib/auth/safe-next-path";
import { ApproveButton } from "./approve-button";

export const dynamic = "force-dynamic";
export const revalidate = 0;

function formatDate(value: string): string {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function statusLabel(value: string): string {
  return value
    .split("_")
    .map(
      (part) =>
        part.charAt(0).toUpperCase() +
        part.slice(1)
    )
    .join(" ");
}

export default async function SnapshotRequestsAdminPage() {
  const user =
    await requireFounderForPage(
      FOUNDER_ADMIN_PATH
    );

  const requests =
    await getDb().listSnapshotRequests(100);

  return (
    <main
      style={{
        minHeight: "100vh",
        background: "#fafafa",
      }}
    >
      <header
        style={{
          borderBottom: "1px solid #eaeaea",
          background: "#fff",
        }}
      >
        <div
          style={{
            maxWidth: 1280,
            margin: "0 auto",
            padding: "20px 24px",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 20,
          }}
        >
          <div>
            <p
              style={{
                margin: 0,
                fontWeight: 700,
              }}
            >
              Zypact
            </p>
            <p
              style={{
                margin: "4px 0 0",
                color: "#777",
                fontSize: 13,
              }}
            >
              Founder operations
            </p>
          </div>

          <div
            style={{
              textAlign: "right",
              fontSize: 13,
            }}
          >
            <p
              style={{
                margin: 0,
                color: "#555",
              }}
            >
              {user.email}
            </p>
            <a
              href="/auth/logout"
              style={{
                display: "inline-block",
                marginTop: 5,
                textDecoration: "underline",
              }}
            >
              Sign out
            </a>
          </div>
        </div>
      </header>

      <section
        style={{
          maxWidth: 1280,
          margin: "0 auto",
          padding: "48px 24px 80px",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "flex-end",
            justifyContent: "space-between",
            gap: 24,
            marginBottom: 28,
          }}
        >
          <div>
            <p
              style={{
                margin: "0 0 10px",
                color: "#888",
                fontSize: 13,
                textTransform: "uppercase",
                letterSpacing: "0.04em",
              }}
            >
              Free snapshots
            </p>

            <h1
              style={{
                margin: 0,
                fontSize: 40,
                lineHeight: 1.08,
              }}
            >
              Snapshot requests
            </h1>
          </div>

          <p
            style={{
              margin: 0,
              color: "#666",
            }}
          >
            {requests.length} request
            {requests.length === 1 ? "" : "s"}
          </p>
        </div>

        {requests.length === 0 ? (
          <div
            style={{
              border: "1px solid #e5e5e5",
              borderRadius: 14,
              background: "#fff",
              padding: 32,
              color: "#666",
            }}
          >
            No snapshot requests yet.
          </div>
        ) : (
          <div
            style={{
              overflowX: "auto",
              border: "1px solid #e5e5e5",
              borderRadius: 14,
              background: "#fff",
            }}
          >
            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                minWidth: 1050,
                fontSize: 14,
              }}
            >
              <thead>
                <tr
                  style={{
                    borderBottom:
                      "1px solid #e5e5e5",
                    textAlign: "left",
                    color: "#777",
                  }}
                >
                  <th style={{ padding: 16 }}>
                    Company
                  </th>
                  <th style={{ padding: 16 }}>
                    Contact
                  </th>
                  <th style={{ padding: 16 }}>
                    Buyer category
                  </th>
                  <th style={{ padding: 16 }}>
                    Status
                  </th>
                  <th style={{ padding: 16 }}>
                    Progress
                  </th>
                  <th style={{ padding: 16 }}>
                    Requested
                  </th>
                  <th style={{ padding: 16 }}>
                    Action
                  </th>
                </tr>
              </thead>

              <tbody>
                {requests.map((request) => (
                  <tr
                    key={request.id}
                    style={{
                      borderBottom:
                        "1px solid #f0f0f0",
                      verticalAlign: "top",
                    }}
                  >
                    <td style={{ padding: 16 }}>
                      <strong>
                        {request.companyName}
                      </strong>
                      <br />
                      <a
                        href={request.websiteUrl}
                        target="_blank"
                        rel="noreferrer"
                        style={{
                          color: "#666",
                          fontSize: 13,
                          textDecoration:
                            "underline",
                        }}
                      >
                        {request.normalizedDomain}
                      </a>
                    </td>

                    <td style={{ padding: 16 }}>
                      <a
                        href={`mailto:${request.workEmail}`}
                        style={{
                          textDecoration:
                            "underline",
                        }}
                      >
                        {request.workEmail}
                      </a>
                    </td>

                    <td
                      style={{
                        padding: 16,
                        maxWidth: 280,
                        lineHeight: 1.45,
                      }}
                    >
                      {request.buyerCategory}
                    </td>

                    <td style={{ padding: 16 }}>
                      <span
                        style={{
                          display: "inline-flex",
                          borderRadius: 999,
                          background: "#f1f1f1",
                          padding: "6px 10px",
                          fontSize: 12,
                          fontWeight: 600,
                          whiteSpace: "nowrap",
                        }}
                      >
                        {statusLabel(
                          request.status
                        )}
                      </span>
                    </td>

                    <td style={{ padding: 16 }}>
                      {request.progressStage
                        ? statusLabel(
                            request.progressStage
                          )
                        : "—"}
                    </td>

                    <td
                      style={{
                        padding: 16,
                        whiteSpace: "nowrap",
                        color: "#666",
                      }}
                    >
                      {formatDate(
                        request.createdAt
                      )}
                    </td>

                    <td style={{ padding: 16 }}>
                      <div
                        style={{
                          display: "flex",
                          alignItems: "flex-start",
                          gap: 10,
                          flexWrap: "wrap",
                        }}
                      >
                        <a
                          href={`/admin/snapshot-requests/${request.id}`}
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            minHeight: 36,
                            border:
                              "1px solid #d0d0d0",
                            borderRadius: 999,
                            padding: "0 14px",
                            color: "#111",
                            textDecoration: "none",
                            fontWeight: 600,
                          }}
                        >
                          View
                        </a>

                        {request.status ===
                        "pending_approval" ? (
                          <ApproveButton
                            requestId={request.id}
                          />
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}
