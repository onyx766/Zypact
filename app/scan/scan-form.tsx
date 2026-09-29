"use client";

import { FormEvent, ReactNode, useState } from "react";
import { ArrowRight, Check, Lock } from "lucide-react";

import { Button } from "@/components/ui/button";
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
      <Label htmlFor={htmlFor}>{label}</Label>
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
        <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
          V1 demo request
        </p>

        <h2 className="mt-4 text-[24px] font-bold leading-tight tracking-tight sm:text-[28px]">
          Demo requests are not open yet.
        </h2>

        <p className="mt-4 text-[14px] leading-relaxed text-muted-foreground">
          The protected request flow is being prepared. No information has been
          submitted and no AI call has started.
        </p>

        <Button asChild variant="outline" className="mt-7 w-full sm:w-auto">
          <a href="/">Return to Zypact</a>
        </Button>
      </div>
    );
  }

  if (submitted) {
    return (
      <div aria-live="polite">
        <span
          className="inline-flex h-11 w-11 items-center justify-center rounded-full bg-chart-2/15 text-chart-2"
          aria-hidden="true"
        >
          <Check className="h-5 w-5" strokeWidth={2.5} />
        </span>

        <p className="mt-6 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
          Request received
        </p>

        <h2 className="mt-3 text-[24px] font-bold leading-tight tracking-tight sm:text-[28px]">
          Check your work email.
        </h2>

        <p className="mt-4 text-[14px] leading-relaxed text-muted-foreground">
          We&rsquo;ve received your buyer question. No AI call has started. We
          sent a private verification link to confirm your email — once
          confirmed, we&rsquo;ll review the question and protocol before the
          baseline is approved.
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
              "Question review",
              "Protocol approval",
              "Controlled baseline",
              "Evidence report",
            ].map((stage, index) => (
              <li key={stage} className="flex items-center gap-2.5">
                <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-border font-mono text-[10px]">
                  {index + 1}
                </span>
                {stage}
              </li>
            ))}
          </ol>
        </div>

        <Button asChild variant="outline" className="mt-7 w-full sm:w-auto">
          <a href="/">Return to Zypact</a>
        </Button>
      </div>
    );
  }

  return (
    <>
      <h2 className="text-[22px] font-bold tracking-tight sm:text-[25px]">
        Request your demo
      </h2>

      <p className="mt-2.5 text-[14px] leading-relaxed text-muted-foreground">
        Tell us a bit about yourself and your question. We&rsquo;ll review it
        and be in touch.
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
            />
          </Field>
        </div>

        {/* The question is the product input, so it gets its own framed block. */}
        <div className="rounded-xl border border-border bg-muted/30 p-4">
          <Field
            htmlFor="buyerCategory"
            label="One buyer question"
            error={fieldErrors.buyerCategory?.[0]}
            errorId="buyerCategory-error"
            footer={
              <>
                <p
                  id="buyerCategory-help"
                  className="text-[12.5px] leading-relaxed text-muted-foreground"
                >
                  Enter one commercially important question a buyer might ask
                  when comparing products like yours — for example,
                  &ldquo;Which SOC 2 automation platforms are best for a
                  50-person B2B SaaS company?&rdquo;, not &ldquo;SOC 2
                  software&rdquo;.
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
              className="min-h-[104px] bg-background"
            />
          </Field>
        </div>

        {feedback ? (
          <p
            className="rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-[13.5px] leading-relaxed text-foreground"
            role="alert"
          >
            {feedback}
          </p>
        ) : null}

        <Button
          type="submit"
          size="lg"
          className="w-full"
          disabled={submitting}
        >
          {submitting ? "Submitting…" : "Request demo"}
          {submitting ? null : (
            <ArrowRight className="h-4 w-4" strokeWidth={2.25} />
          )}
        </Button>

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
