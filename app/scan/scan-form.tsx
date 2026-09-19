"use client";

import { FormEvent, useState } from "react";
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

export function ScanForm({
  enabled,
}: ScanFormProps) {
  const [values, setValues] =
    useState<SnapshotRequestFormValues>(
      EMPTY_VALUES
    );

  const [fieldErrors, setFieldErrors] =
    useState<SnapshotRequestFormErrors>({});

  const [feedback, setFeedback] =
    useState<string | null>(null);

  const [submitting, setSubmitting] =
    useState(false);

  const [submitted, setSubmitted] =
    useState(false);

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

  async function handleSubmit(
    event: FormEvent<HTMLFormElement>
  ) {
    event.preventDefault();

    if (!enabled || submitting) {
      return;
    }

    setSubmitting(true);
    setFeedback(null);
    setFieldErrors({});

    const result =
      await submitSnapshotRequest(values);

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
      <div className="scan-unavailable">
        <p className="scan-status-label">
          V1 demo request
        </p>

        <h2>
          Demo requests are not open yet.
        </h2>

        <p>
          The protected request flow is being
          prepared. No information has been
          submitted and no AI call has started.
        </p>

        <a
          href="/"
          className="button button-secondary"
        >
          Return to Zypact
        </a>
      </div>
    );
  }

  if (submitted) {
    return (
      <div
        className="scan-success"
        aria-live="polite"
      >
        <div
          className="verification-icon"
          aria-hidden="true"
        >
          ✓
        </div>

        <p className="scan-status-label">
          Request received
        </p>

        <h2>Check your work email.</h2>

        <p>
          We&rsquo;ve received your buyer question.
          No AI call has started. We sent a private
          verification link to confirm your email —
          once confirmed, we&rsquo;ll review the
          question and protocol before the baseline
          is approved.
        </p>

        <p className="scan-privacy-note">
          The link expires in 30 minutes and
          can be used only once.
        </p>

        <div className="scan-success-steps">
          <p className="scan-success-steps-label">
            What happens next
          </p>

          <ol>
            <li>Confirm your email</li>
            <li>Question review</li>
            <li>Protocol approval</li>
            <li>Controlled baseline</li>
            <li>Evidence report</li>
          </ol>
        </div>

        <a
          href="/"
          className="button button-secondary scan-return-link"
        >
          Return to Zypact
        </a>
      </div>
    );
  }

  return (
    <>
      <h2 className="scan-form-title">
        Request your demo
      </h2>

      <p className="scan-form-lede">
        Tell us a bit about yourself and your
        question. We&rsquo;ll review it and be
        in touch.
      </p>

      <form
        className="scan-form"
        onSubmit={handleSubmit}
        noValidate
      >
        <div className="scan-field">
          <label htmlFor="contactName">
            Your name
          </label>

          <input
            id="contactName"
            name="contactName"
            type="text"
            autoComplete="name"
            maxLength={160}
            required
            value={values.contactName}
            onChange={(event) =>
              updateField(
                "contactName",
                event.target.value
              )
            }
            aria-invalid={
              Boolean(fieldErrors.contactName)
            }
            aria-describedby={
              fieldErrors.contactName
                ? "contactName-error"
                : undefined
            }
            placeholder="Jane Smith"
          />

          {fieldErrors.contactName ? (
            <p
              id="contactName-error"
              className="scan-field-error"
            >
              {fieldErrors.contactName[0]}
            </p>
          ) : null}
        </div>

        <div className="scan-field">
          <label htmlFor="companyName">
            Company name
          </label>

          <input
            id="companyName"
            name="companyName"
            type="text"
            autoComplete="organization"
            maxLength={120}
            required
            value={values.companyName}
            onChange={(event) =>
              updateField(
                "companyName",
                event.target.value
              )
            }
            aria-invalid={
              Boolean(fieldErrors.companyName)
            }
            aria-describedby={
              fieldErrors.companyName
                ? "companyName-error"
                : undefined
            }
            placeholder="Example SaaS"
          />

          {fieldErrors.companyName ? (
            <p
              id="companyName-error"
              className="scan-field-error"
            >
              {fieldErrors.companyName[0]}
            </p>
          ) : null}
        </div>

        <div className="scan-field">
          <label htmlFor="workEmail">
            Work email
          </label>

          <input
            id="workEmail"
            name="workEmail"
            type="email"
            autoComplete="email"
            maxLength={254}
            required
            value={values.workEmail}
            onChange={(event) =>
              updateField(
                "workEmail",
                event.target.value
              )
            }
            aria-invalid={
              Boolean(fieldErrors.workEmail)
            }
            aria-describedby={
              fieldErrors.workEmail
                ? "workEmail-error"
                : undefined
            }
            placeholder="you@company.com"
          />

          {fieldErrors.workEmail ? (
            <p
              id="workEmail-error"
              className="scan-field-error"
            >
              {fieldErrors.workEmail[0]}
            </p>
          ) : null}
        </div>

        <div className="scan-field">
          <label htmlFor="websiteUrl">
            Company website
          </label>

          <input
            id="websiteUrl"
            name="websiteUrl"
            type="text"
            inputMode="url"
            autoComplete="url"
            maxLength={2048}
            required
            value={values.websiteUrl}
            onChange={(event) =>
              updateField(
                "websiteUrl",
                event.target.value
              )
            }
            aria-invalid={
              Boolean(fieldErrors.websiteUrl)
            }
            aria-describedby={
              fieldErrors.websiteUrl
                ? "websiteUrl-error"
                : undefined
            }
            placeholder="company.com"
          />

          {fieldErrors.websiteUrl ? (
            <p
              id="websiteUrl-error"
              className="scan-field-error"
            >
              {fieldErrors.websiteUrl[0]}
            </p>
          ) : null}
        </div>

        <div className="scan-field scan-field-question">
          <label htmlFor="buyerCategory">
            One buyer question
          </label>

          <textarea
            id="buyerCategory"
            name="buyerCategory"
            rows={4}
            maxLength={BUYER_QUESTION_MAX_LENGTH}
            required
            value={values.buyerCategory}
            onChange={(event) =>
              updateField(
                "buyerCategory",
                event.target.value
              )
            }
            aria-invalid={
              Boolean(
                fieldErrors.buyerCategory
              )
            }
            aria-describedby={
              fieldErrors.buyerCategory
                ? "buyerCategory-error"
                : "buyerCategory-help"
            }
            placeholder="Which AI visibility platforms are best for a B2B SaaS marketing team?"
          />

          <p
            id="buyerCategory-help"
            className="scan-field-help"
          >
            Enter one commercially important
            question a buyer might ask when
            comparing products like yours — for
            example, &ldquo;Which SOC 2 automation
            platforms are best for a 50-person B2B
            SaaS company?&rdquo;, not &ldquo;SOC 2
            software&rdquo;.
          </p>

          <p
            className="scan-field-counter"
            aria-hidden="true"
          >
            {values.buyerCategory.length}/
            {BUYER_QUESTION_MAX_LENGTH}
          </p>

          {fieldErrors.buyerCategory ? (
            <p
              id="buyerCategory-error"
              className="scan-field-error"
            >
              {fieldErrors.buyerCategory[0]}
            </p>
          ) : null}
        </div>

        {feedback ? (
          <p
            className="scan-feedback"
            role="alert"
          >
            {feedback}
          </p>
        ) : null}

        <button
          type="submit"
          className="button button-primary scan-submit"
          disabled={submitting}
        >
          {submitting
            ? "Submitting…"
            : "Request demo"}
        </button>

        <p className="scan-privacy-note">
          Request only. No AI call starts until
          the question and protocol are approved.
        </p>
      </form>
    </>
  );
}
