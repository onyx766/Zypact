"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import {
  DEFAULT_FORBIDDEN_CLAIMS,
  PRODUCT_DESCRIPTION_MAX,
  ProofType,
  Tone,
  type EvidenceBankInput,
  type EvidenceBankOutput,
  type FeatureItem,
  type ProofItem,
} from "@/lib/schemas/evidence-bank.schema";

const PROOF_TYPES = ProofType.options;
const TONE_OPTIONS = Tone.options;

interface Props {
  projectId: string;
  initial: EvidenceBankOutput;
  wasCreated: boolean;
}

function linesToArray(text: string): string[] {
  return text
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function arrayToLines(arr: string[]): string {
  return arr.join("\n");
}

export function EvidenceBankForm({ projectId, initial, wasCreated }: Props) {
  const router = useRouter();

  const [productDescription, setProductDescription] = useState(
    initial.productDescription
  );
  const [targetAudienceText, setTargetAudienceText] = useState(
    arrayToLines(initial.targetAudience)
  );
  const [mainUseCasesText, setMainUseCasesText] = useState(
    arrayToLines(initial.mainUseCases)
  );
  const [features, setFeatures] = useState<FeatureItem[]>(
    initial.features.length ? initial.features : []
  );
  const [proofItems, setProofItems] = useState<ProofItem[]>(
    initial.proofItems.length ? initial.proofItems : []
  );
  const [competitorsText, setCompetitorsText] = useState(
    arrayToLines(initial.competitors)
  );
  const [allowedClaimsText, setAllowedClaimsText] = useState(
    arrayToLines(initial.allowedClaims)
  );
  const [forbiddenClaimsText, setForbiddenClaimsText] = useState(
    arrayToLines(initial.forbiddenClaims)
  );
  const [tone, setTone] = useState<EvidenceBankInput["tone"]>(initial.tone);
  const [notes, setNotes] = useState(initial.notes);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<null | {
    savedAt: string;
    counts: {
      audience: number;
      useCases: number;
      features: number;
      proofItems: number;
      allowedClaims: number;
      forbiddenClaims: number;
    };
  }>(null);

  const counts = useMemo(
    () => ({
      audience: linesToArray(targetAudienceText).length,
      useCases: linesToArray(mainUseCasesText).length,
      features: features.filter((f) => f.name.trim().length > 0).length,
      proofItems: proofItems.filter((p) => p.detail.trim().length > 0).length,
      allowedClaims: linesToArray(allowedClaimsText).length,
      forbiddenClaims: linesToArray(forbiddenClaimsText).length,
    }),
    [
      targetAudienceText,
      mainUseCasesText,
      features,
      proofItems,
      allowedClaimsText,
      forbiddenClaimsText,
    ]
  );

  function buildPayload(): EvidenceBankInput {
    return {
      productDescription,
      targetAudience: linesToArray(targetAudienceText),
      mainUseCases: linesToArray(mainUseCasesText),
      features: features
        .map((f) => ({ name: f.name.trim(), description: f.description }))
        .filter((f) => f.name.length > 0),
      proofItems: proofItems
        .filter((p) => p.detail.trim().length > 0)
        .map<ProofItem>((p) => {
          const item: ProofItem = {
            type: p.type,
            detail: p.detail.trim(),
          };
          const url = p.sourceUrl?.trim();
          if (url) item.sourceUrl = url;
          return item;
        }),
      competitors: linesToArray(competitorsText),
      allowedClaims: linesToArray(allowedClaimsText),
      forbiddenClaims: linesToArray(forbiddenClaimsText),
      tone,
      notes,
      // Sprint 12 provenance: any save from this UI is a real user edit.
      // The API route also forces this value server-side, but including it
      // here keeps the client payload aligned with the schema.
      provenance: "user_edited",
    };
  }

  async function onSave() {
    setError(null);
    setFlash(null);
    setBusy(true);
    try {
      const evidenceBank = buildPayload();
      const res = await fetch("/api/projects/evidence-bank", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId, evidenceBank }),
      });
      const json = (await res.json()) as {
        ok: boolean;
        error?: string;
        issues?: Array<{ path: (string | number)[]; message: string }>;
        evidenceBank?: EvidenceBankOutput;
      };
      if (!json.ok) {
        const issueSummary = (json.issues ?? [])
          .slice(0, 3)
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ");
        setError(
          issueSummary
            ? `${json.error ?? "Validation failed"} — ${issueSummary}`
            : json.error ?? "Unknown error"
        );
        setBusy(false);
        return;
      }
      const saved = json.evidenceBank!;
      setFlash({
        savedAt: saved.updatedAt,
        counts: {
          audience: saved.targetAudience.length,
          useCases: saved.mainUseCases.length,
          features: saved.features.length,
          proofItems: saved.proofItems.length,
          allowedClaims: saved.allowedClaims.length,
          forbiddenClaims: saved.forbiddenClaims.length,
        },
      });
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      {wasCreated && (
        <p
          style={{
            padding: 8,
            background: "#fff7e6",
            border: "1px solid #ffd591",
          }}
        >
          A prefilled draft was created from your Mirror Profile. Review and edit
          before relying on it — Zypact will only use what you save here.
        </p>
      )}

      {/* 1. Product facts ---------------------------------------------------- */}
      <section className="section">
        <h2>1. Product facts</h2>

        <label style={label}>Product description</label>
        <textarea
          value={productDescription}
          onChange={(e) => setProductDescription(e.target.value)}
          rows={5}
          maxLength={PRODUCT_DESCRIPTION_MAX}
          style={textarea}
          placeholder="What Zypact is allowed to say about your product, factually."
        />
        <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
          {productDescription.length} / {PRODUCT_DESCRIPTION_MAX} chars
        </div>

        <label style={label}>Target audience (one per line)</label>
        <textarea
          value={targetAudienceText}
          onChange={(e) => setTargetAudienceText(e.target.value)}
          rows={4}
          style={textarea}
          placeholder="B2B marketing teams
SaaS founders"
        />

        <label style={label}>Main use cases (one per line)</label>
        <textarea
          value={mainUseCasesText}
          onChange={(e) => setMainUseCasesText(e.target.value)}
          rows={4}
          style={textarea}
        />

        <label style={label}>Features</label>
        <FeatureListEditor value={features} onChange={setFeatures} />
      </section>

      {/* 2. Proof ------------------------------------------------------------ */}
      <section className="section">
        <h2>2. Proof</h2>
        <p className="muted" style={{ marginTop: 0 }}>
          Only proof that exists on your site or in real assets. Do not invent.
        </p>
        <ProofListEditor value={proofItems} onChange={setProofItems} />
      </section>

      {/* 3. Competitors ------------------------------------------------------ */}
      <section className="section">
        <h2>3. Competitors</h2>
        <label style={label}>Competitor names (one per line)</label>
        <textarea
          value={competitorsText}
          onChange={(e) => setCompetitorsText(e.target.value)}
          rows={5}
          style={textarea}
        />
      </section>

      {/* 4. Allowed claims --------------------------------------------------- */}
      <section className="section">
        <h2>4. Allowed claims</h2>
        <label style={label}>Claims Zypact IS allowed to use (one per line)</label>
        <textarea
          value={allowedClaimsText}
          onChange={(e) => setAllowedClaimsText(e.target.value)}
          rows={6}
          style={textarea}
        />
      </section>

      {/* 5. Forbidden claims ------------------------------------------------- */}
      <section className="section">
        <h2>5. Forbidden claims</h2>
        <p className="muted" style={{ marginTop: 0 }}>
          Future generated assets cannot use these claims. At least 3 required.
        </p>
        <label style={label}>Forbidden claims (one per line)</label>
        <textarea
          value={forbiddenClaimsText}
          onChange={(e) => setForbiddenClaimsText(e.target.value)}
          rows={8}
          style={textarea}
        />
        <details style={{ marginTop: 8 }}>
          <summary>Default forbidden claims</summary>
          <ul style={{ margin: "4px 0 0 20px" }}>
            {DEFAULT_FORBIDDEN_CLAIMS.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </details>
      </section>

      {/* 6. Tone ------------------------------------------------------------- */}
      <section className="section">
        <h2>6. Tone</h2>
        <select
          value={tone}
          onChange={(e) => setTone(e.target.value as EvidenceBankInput["tone"])}
          style={{ padding: 6, font: "inherit" }}
        >
          {TONE_OPTIONS.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </section>

      {/* 7. Notes ------------------------------------------------------------ */}
      <section className="section">
        <h2>7. Notes</h2>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={4}
          style={textarea}
          placeholder="Anything else Zypact should keep in mind."
        />
      </section>

      {/* Live counts + save -------------------------------------------------- */}
      <div className="section">
        <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
          {counts.audience} audience · {counts.useCases} use cases ·{" "}
          {counts.features} features · {counts.proofItems} proof items ·{" "}
          {counts.allowedClaims} allowed · {counts.forbiddenClaims} forbidden
          {counts.forbiddenClaims < 3 && (
            <span className="error" style={{ marginLeft: 8 }}>
              (need at least 3 forbidden claims)
            </span>
          )}
        </div>
        <button type="button" onClick={onSave} disabled={busy}>
          {busy ? "Saving…" : "Prepare Evidence Bank"}
        </button>
        {error && (
          <p className="error" style={{ marginTop: 8 }}>
            {error}
          </p>
        )}
        {flash && (
          <div
            style={{
              marginTop: 8,
              padding: 8,
              background: "#eef7ee",
              border: "1px solid #a3d9a5",
            }}
          >
            <strong>Saved</strong>{" "}
            <span className="muted">
              at {new Date(flash.savedAt).toLocaleString()}
            </span>
            <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
              {flash.counts.audience} audience · {flash.counts.useCases} use cases ·{" "}
              {flash.counts.features} features · {flash.counts.proofItems} proof items ·{" "}
              {flash.counts.allowedClaims} allowed · {flash.counts.forbiddenClaims} forbidden
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Feature list editor                                                        */
/* -------------------------------------------------------------------------- */

function FeatureListEditor({
  value,
  onChange,
}: {
  value: FeatureItem[];
  onChange: (next: FeatureItem[]) => void;
}) {
  function update(i: number, patch: Partial<FeatureItem>) {
    onChange(value.map((f, idx) => (idx === i ? { ...f, ...patch } : f)));
  }
  function remove(i: number) {
    onChange(value.filter((_, idx) => idx !== i));
  }
  function add() {
    onChange([...value, { name: "", description: "" }]);
  }

  return (
    <div>
      {value.length === 0 && (
        <p className="muted" style={{ fontSize: 12 }}>
          No features listed. Add one below.
        </p>
      )}
      {value.map((f, i) => (
        <div
          key={i}
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 2fr auto",
            gap: 6,
            marginBottom: 4,
          }}
        >
          <input
            type="text"
            value={f.name}
            onChange={(e) => update(i, { name: e.target.value })}
            placeholder="Feature name"
            style={input}
          />
          <input
            type="text"
            value={f.description}
            onChange={(e) => update(i, { description: e.target.value })}
            placeholder="Short factual description (optional)"
            style={input}
          />
          <button type="button" onClick={() => remove(i)}>
            remove
          </button>
        </div>
      ))}
      <button type="button" onClick={add} style={{ marginTop: 4 }}>
        + add feature
      </button>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Proof list editor                                                          */
/* -------------------------------------------------------------------------- */

function ProofListEditor({
  value,
  onChange,
}: {
  value: ProofItem[];
  onChange: (next: ProofItem[]) => void;
}) {
  function update(i: number, patch: Partial<ProofItem>) {
    onChange(value.map((p, idx) => (idx === i ? { ...p, ...patch } : p)));
  }
  function remove(i: number) {
    onChange(value.filter((_, idx) => idx !== i));
  }
  function add() {
    onChange([...value, { type: "customer", detail: "" }]);
  }

  return (
    <div>
      {value.length === 0 && (
        <p className="muted" style={{ fontSize: 12 }}>
          No proof items yet. Only add proof you can actually cite.
        </p>
      )}
      {value.map((p, i) => (
        <div
          key={i}
          style={{
            display: "grid",
            gridTemplateColumns: "140px 2fr 1fr auto",
            gap: 6,
            marginBottom: 4,
          }}
        >
          <select
            value={p.type}
            onChange={(e) =>
              update(i, { type: e.target.value as ProofItem["type"] })
            }
            style={input}
          >
            {PROOF_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <input
            type="text"
            value={p.detail}
            onChange={(e) => update(i, { detail: e.target.value })}
            placeholder='e.g. "42% faster onboarding, per Acme case study"'
            style={input}
          />
          <input
            type="url"
            value={p.sourceUrl ?? ""}
            onChange={(e) => update(i, { sourceUrl: e.target.value })}
            placeholder="https://…"
            style={input}
          />
          <button type="button" onClick={() => remove(i)}>
            remove
          </button>
        </div>
      ))}
      <button type="button" onClick={add} style={{ marginTop: 4 }}>
        + add proof item
      </button>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Shared styles                                                              */
/* -------------------------------------------------------------------------- */

const label: React.CSSProperties = {
  display: "block",
  marginTop: 8,
  marginBottom: 4,
  fontWeight: 600,
  fontSize: 12,
};

const textarea: React.CSSProperties = {
  width: "100%",
  padding: 8,
  font: "inherit",
  border: "1px solid #999",
  background: "white",
  boxSizing: "border-box",
};

const input: React.CSSProperties = {
  padding: 6,
  font: "inherit",
  border: "1px solid #999",
  background: "white",
};
