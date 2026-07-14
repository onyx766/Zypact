"use client";

import Script from "next/script";
import {
  FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  submitSnapshotRequest,
  type SnapshotRequestFormErrors,
  type SnapshotRequestFormValues,
} from "@/lib/snapshot-requests/public-form";

declare global {
  interface Window {
    turnstile?: {
      render(
        container: string | HTMLElement,
        options: {
          sitekey: string;
          action?: string;
          theme?: "light" | "dark" | "auto";
          size?: "normal" | "compact" | "flexible";
          callback?: (token: string) => void;
          "expired-callback"?: () => void;
          "error-callback"?: (
            errorCode?: string
          ) => void;
        }
      ): string;
      reset(widgetId?: string): void;
      remove(widgetId?: string): void;
    };
  }
}

const EMPTY_VALUES: SnapshotRequestFormValues = {
  workEmail: "",
  companyName: "",
  websiteUrl: "",
  buyerCategory: "",
};

interface ScanFormProps {
  enabled: boolean;
  siteKey: string | null;
}

export function ScanForm({
  enabled,
  siteKey,
}: ScanFormProps) {
  const [values, setValues] =
    useState<SnapshotRequestFormValues>(
      EMPTY_VALUES
    );

  const [fieldErrors, setFieldErrors] =
    useState<SnapshotRequestFormErrors>({});

  const [feedback, setFeedback] =
    useState<string | null>(null);

  const [turnstileToken, setTurnstileToken] =
    useState("");

  const [turnstileReady, setTurnstileReady] =
    useState(false);

  const [submitting, setSubmitting] =
    useState(false);

  const [submitted, setSubmitted] =
    useState(false);

  const widgetContainerRef =
    useRef<HTMLDivElement | null>(null);

  const widgetIdRef =
    useRef<string | null>(null);

  const renderTurnstile = useCallback(() => {
    if (
      !enabled ||
      !siteKey ||
      !widgetContainerRef.current ||
      !window.turnstile ||
      widgetIdRef.current
    ) {
      return;
    }

    widgetIdRef.current =
      window.turnstile.render(
        widgetContainerRef.current,
        {
          sitekey: siteKey,
          action: "snapshot_request",
          theme: "light",
          size: "flexible",
          callback(token) {
            setTurnstileToken(token);
            setTurnstileReady(true);
            setFieldErrors((current) => {
              const next = { ...current };
              delete next.turnstileToken;
              return next;
            });
          },
          "expired-callback"() {
            setTurnstileToken("");
            setTurnstileReady(false);
          },
          "error-callback"() {
            setTurnstileToken("");
            setTurnstileReady(false);
            setFeedback(
              "The security check could not load. Please refresh the page and try again."
            );
          },
        }
      );
  }, [enabled, siteKey]);

  useEffect(() => {
    renderTurnstile();

    return () => {
      if (
        widgetIdRef.current &&
        window.turnstile
      ) {
        window.turnstile.remove(
          widgetIdRef.current
        );

        widgetIdRef.current = null;
      }
    };
  }, [renderTurnstile]);

  function resetTurnstile() {
    setTurnstileToken("");
    setTurnstileReady(false);

    if (
      widgetIdRef.current &&
      window.turnstile
    ) {
      window.turnstile.reset(
        widgetIdRef.current
      );
    }
  }

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

    if (
      !enabled ||
      !siteKey ||
      submitting
    ) {
      return;
    }

    setSubmitting(true);
    setFeedback(null);
    setFieldErrors({});

    const result =
      await submitSnapshotRequest(
        values,
        turnstileToken
      );

    if (result.ok) {
      setSubmitted(true);
      setTurnstileToken("");

      if (
        widgetIdRef.current &&
        window.turnstile
      ) {
        window.turnstile.remove(
          widgetIdRef.current
        );

        widgetIdRef.current = null;
      }

      setSubmitting(false);
      return;
    }

    setFeedback(result.message);
    setFieldErrors(result.fieldErrors);
    resetTurnstile();
    setSubmitting(false);
  }

  if (!enabled || !siteKey) {
    return (
      <div className="scan-unavailable">
        <p className="scan-status-label">
          Free snapshot
        </p>

        <h2>
          Snapshot requests are not open yet.
        </h2>

        <p>
          The protected request flow is being
          prepared. No information has been
          submitted.
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
          We sent a private verification link.
          Your request will wait for approval
          after verification. No AI scan has
          started yet.
        </p>

        <p className="scan-privacy-note">
          The link expires in 30 minutes and
          can be used only once.
        </p>
      </div>
    );
  }

  return (
    <>
      <Script
        src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"
        strategy="afterInteractive"
        onLoad={renderTurnstile}
      />

      <form
        className="scan-form"
        onSubmit={handleSubmit}
        noValidate
      >
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

        <div className="scan-field">
          <label htmlFor="buyerCategory">
            What category would buyers use?
          </label>

          <input
            id="buyerCategory"
            name="buyerCategory"
            type="text"
            maxLength={160}
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
            placeholder="AI visibility software for B2B SaaS"
          />

          <p
            id="buyerCategory-help"
            className="scan-field-help"
          >
            Use the phrase a buyer would type
            when searching for products like
            yours.
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

        <div className="scan-security">
          <div
            ref={widgetContainerRef}
            className="scan-turnstile"
          />

          {fieldErrors.turnstileToken ? (
            <p className="scan-field-error">
              {fieldErrors.turnstileToken[0]}
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
          disabled={
            submitting || !turnstileReady
          }
        >
          {submitting
            ? "Sending request…"
            : "Request free snapshot"}
        </button>

        <p className="scan-privacy-note">
          No account or card required. Email
          verification and founder approval
          happen before any AI scan starts.
        </p>
      </form>
    </>
  );
}
