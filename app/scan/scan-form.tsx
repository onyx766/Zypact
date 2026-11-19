"use client";

import { FormEvent, ReactNode, useState } from "react";
import { ArrowRight, Check, Lock } from "lucide-react";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  submitSnapshotRequest,
  type SnapshotRequestFormErrors,
  type SnapshotRequestFormValues,
} from "@/lib/snapshot-requests/public-form";

const EMPTY_VALUES: SnapshotRequestFormValues = {
  contactName: "",
  workEmail: "",
  companyName: "",
  websiteUrl: "",
  buyerCategory: "",
};

const BUYER_QUESTION_MAX_LENGTH = 300;

/**
 * Landing-token field styling, merged over the shadcn defaults by `cn`
 * (tailwind-merge replaces the conflicting height, radius, padding and
 * background utilities rather than stacking them).
 */
const INPUT_CLASS =
  "lx-request-input h-12 rounded-[12px] border-border bg-card px-4 text-[15px] shadow-[inset_0_1px_2px_hsl(var(--lx-shadow)/0.05)] focus-visible:ring-offset-card";

const RETURN_LINK_CLASS = "lx-btn lx-btn--ghost lx-btn--sm mt-7 w-full sm:w-auto";

interface ScanFormProps {
  enabled: boolean;
}

/**
 * Label + control + help/error wrapper.
 *
 * Ids stay at the call site rather than being derived here, so the
 * `htmlFor`/`aria-describedby` wiring of each field remains greppable and
 * cannot drift when a field is reordered.
 */
function Field({
  htmlFor,
  label,
  error,
  errorId,
  children,
  footer,
}: {
  htmlFor: string;
  label: string;
  error?: string;
  errorId?: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="grid gap-2">
      <Label htmlFor={htmlFor} className="lx-request-label">
        {label}
      </Label>
      {children}
      {footer}
      {error ? (
        <p id={errorId} className="text-[12.5px] leading-snug text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function ScanForm({ enabled }: ScanFormProps) {
  const [values, setValues] =
    useState<SnapshotRequestFormValues>(EMPTY_VALUES);

  const [fieldErrors, setFieldErrors] = useState<SnapshotRequestFormErrors>({});

  const [feedback, setFeedback] = useState<string | null>(null);

  const [submitting, setSubmitting] = useState(false);

  const [submitted, setSubmitted] = useState(false);

  function updateField(
    field: keyof SnapshotRequestFormValues,
    value: string
  ) {
    setValues((current) => ({
      ...current,
      [field]: value,
    }));

    setFieldErrors((current) => {
      const next = { ...current };
      delete next[field];
      return next;
    });
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!enabled || submitting) {
      return;
    }

    setSubmitting(true);
    setFeedback(null);
    setFieldErrors({});

    const result = await submitSnapshotRequest(values);

    if (result.ok) {
      setSubmitted(true);
      setSubmitting(false);
      return;
    }

    setFeedback(result.message);
    setFieldErrors(result.fieldErrors);
    setSubmitting(false);
  }

  if (!enabled) {
    return (
      <div>
        <p className="lx-eyebrow">
          Demo request
        </p>

        <h2 className="lx-request-card__title mt-4 text-[28px] sm:text-[32px]">
          Demo requests are not open yet.
        </h2>

        <p className="mt-4 text-[14px] leading-relaxed text-muted-foreground">
          The protected request flow is being prepared. No information has been
          submitted and no AI call has started.
        </p>

        <a href="/" className={RETURN_LINK_CLASS}>
          Return to Zypact
        </a>
      </div>
    );
  }

  if (submitted) {
    return (
      <div aria-live="polite">
        <span className="lx-request-success" aria-hidden="true">
          <Check className="h-5 w-5" strokeWidth={2.5} />
        </span>

        <p className="lx-eyebrow mt-6">
          Request received
        </p>

        <h2 className="lx-request-card__title mt-3 text-[28px] sm:text-[32px]">
          Check your work email.
        </h2>

        <p className="mt-4 text-[14px] leading-relaxed text-muted-foreground">
          We&rsquo;ve received your demo request. No AI call has started.
          We sent a private verification link to confirm your email. After
          confirmation, our team can discuss Zypact&rsquo;s capabilities
          and how the platform might support your marketing questions.
        </p>

        <p className="mt-3 text-[12.5px] leading-relaxed text-muted-foreground">
          The link expires in 30 minutes and can be used only once.
        </p>

        <div className="mt-6 border-t border-border pt-5">
          <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
            What happens next
          </p>

          <ol className="mt-3 grid gap-1.5 text-[13.5px] leading-relaxed text-muted-foreground">
            {[
              "Confirm your email",
              "Zypact team reviews your request",
              "Explore the platform and your use case",
              "Discuss available capabilities",
              "Agree on next steps",
            ].map((stage, index) => (
              <li key={stage} className="flex items-center gap-2.5">
                <span className="lx-request-next">
                  {index + 1}
                </span>
                {stage}
              </li>
            ))}
          </ol>
        </div>

        <a href="/" className={RETURN_LINK_CLASS}>
          Return to Zypact
        </a>
      </div>
    );
  }

  return (
    <>
      <h2 className="lx-request-card__title text-[28px] sm:text-[32px]">
        Request a demo
      </h2>

      <p className="mt-2.5 text-[14px] leading-relaxed text-muted-foreground">
        Tell us about your company and share an example question your buyers
        might ask AI. We&rsquo;ll explain how Zypact examines brand visibility,
        competitors, cited sources, and marketing opportunities.
      </p>

      <form className="mt-7 grid gap-5" onSubmit={handleSubmit} noValidate>
        {/* Paired on wider viewports, stacked on phones. */}
        <div className="grid gap-5 sm:grid-cols-2">
          <Field
            htmlFor="contactName"
            label="Your name"
            error={fieldErrors.contactName?.[0]}
            errorId="contactName-error"
          >
            <Input
              id="contactName"
              name="contactName"
              type="text"
              autoComplete="name"
              maxLength={160}
              required
              value={values.contactName}
              onChange={(event) =>
                updateField("contactName", event.target.value)
              }
              aria-invalid={Boolean(fieldErrors.contactName)}
              aria-describedby={
                fieldErrors.contactName ? "contactName-error" : undefined
              }
              placeholder="Jane Smith"
              className={INPUT_CLASS}
            />
          </Field>

          <Field
            htmlFor="companyName"
            label="Company name"
            error={fieldErrors.companyName?.[0]}
            errorId="companyName-error"
          >
            <Input
              id="companyName"
              name="companyName"
              type="text"
              autoComplete="organization"
              maxLength={120}
              required
              value={values.companyName}
              onChange={(event) =>
                updateField("companyName", event.target.value)
              }
              aria-invalid={Boolean(fieldErrors.companyName)}
              aria-describedby={
                fieldErrors.companyName ? "companyName-error" : undefined
              }
              placeholder="Example SaaS"
              className={INPUT_CLASS}
            />
          </Field>
        </div>

        <div className="grid gap-5 sm:grid-cols-2">
          <Field
            htmlFor="workEmail"
            label="Work email"
            error={fieldErrors.workEmail?.[0]}
            errorId="workEmail-error"
          >
            <Input
              id="workEmail"
              name="workEmail"
              type="email"
              autoComplete="email"
              maxLength={254}
              required
              value={values.workEmail}
              onChange={(event) =>
                updateField("workEmail", event.target.value)
              }
              aria-invalid={Boolean(fieldErrors.workEmail)}
              aria-describedby={
                fieldErrors.workEmail ? "workEmail-error" : undefined
              }
              placeholder="you@company.com"
              className={INPUT_CLASS}
            />
          </Field>

          <Field
            htmlFor="websiteUrl"
            label="Company website"
            error={fieldErrors.websiteUrl?.[0]}
            errorId="websiteUrl-error"
          >
            <Input
              id="websiteUrl"
              name="websiteUrl"
              type="text"
              inputMode="url"
              autoComplete="url"
              maxLength={2048}
              required
              value={values.websiteUrl}
              onChange={(event) =>
                updateField("websiteUrl", event.target.value)
              }
              aria-invalid={Boolean(fieldErrors.websiteUrl)}
              aria-describedby={
                fieldErrors.websiteUrl ? "websiteUrl-error" : undefined
              }
              placeholder="company.com"
              className={INPUT_CLASS}
            />
          </Field>
        </div>

        {/* The question is the product input, so it gets its own framed block. */}
        <div className="lx-request-question">
          <Field
            htmlFor="buyerCategory"
            label="Example buyer question"
            error={fieldErrors.buyerCategory?.[0]}
            errorId="buyerCategory-error"
            footer={
              <>
                <p
                  id="buyerCategory-help"
                  className="text-[12.5px] leading-relaxed text-muted-foreground"
                >
                  Enter one question a buyer might ask when comparing software,
                  for example, &ldquo;Which SOC 2 automation platforms are best
                  for a 50-person B2B SaaS company?&rdquo;. This simply helps us understand your use case, not limit Zypact
                  to one question.
                </p>

                <p
                  className="text-right font-mono text-[11px] text-muted-foreground"
                  aria-hidden="true"
                >
                  {values.buyerCategory.length}/{BUYER_QUESTION_MAX_LENGTH}
                </p>
              </>
            }
          >
            <Textarea
              id="buyerCategory"
              name="buyerCategory"
              rows={4}
              maxLength={BUYER_QUESTION_MAX_LENGTH}
              required
              value={values.buyerCategory}
              onChange={(event) =>
                updateField("buyerCategory", event.target.value)
              }
              aria-invalid={Boolean(fieldErrors.buyerCategory)}
              aria-describedby={
                fieldErrors.buyerCategory
                  ? "buyerCategory-error"
                  : "buyerCategory-help"
              }
              placeholder="Which AI visibility platforms are best for a B2B SaaS marketing team?"
              className="lx-request-input min-h-[112px] rounded-[12px] border-border bg-card px-4 py-3 text-[15px] focus-visible:ring-offset-card"
            />
          </Field>
        </div>

        {feedback ? (
          <p className="lx-request-error" role="alert">
            {feedback}
          </p>
        ) : null}

        <button
          type="submit"
          className="lx-btn lx-btn--primary w-full"
          disabled={submitting}
        >
          {submitting ? "Submitting…" : "Request demo"}
          {submitting ? null : (
            <ArrowRight
              className="lx-btn__arrow"
              strokeWidth={2.25}
              aria-hidden="true"
            />
          )}
        </button>

        <p className="flex items-start gap-2 text-[12.5px] leading-relaxed text-muted-foreground">
          <Lock
            className="mt-0.5 h-3.5 w-3.5 shrink-0"
            strokeWidth={2}
            aria-hidden="true"
          />
          <span>
            Request only. No AI call starts until the question and protocol are
            approved.
          </span>
        </p>
      </form>
    </>
  );
}
