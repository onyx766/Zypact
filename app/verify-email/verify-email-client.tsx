"use client";

import {
  useEffect,
  useRef,
  useState,
} from "react";
import {
  normalizeSnapshotVerificationToken,
  verifySnapshotEmailLink,
} from "@/lib/snapshot-requests/verification-ui";

type VerificationView =
  | "loading"
  | "ready"
  | "submitting"
  | "success"
  | "invalid"
  | "unavailable"
  | "error";

export function VerifyEmailClient() {
  const initializationRef =
    useRef(false);

  const [token, setToken] =
    useState<string | null>(null);

  const [view, setView] =
    useState<VerificationView>("loading");

  useEffect(() => {
    // React development Strict Mode may execute effects twice.
    // Without this guard, the first execution removes the token
    // from the address bar and the second incorrectly marks it invalid.
    if (initializationRef.current) {
      return;
    }

    initializationRef.current = true;

    const params = new URLSearchParams(
      window.location.search
    );

    const normalizedToken =
      normalizeSnapshotVerificationToken(
        params.get("token")
      );

    setToken(normalizedToken);

    setView(
      normalizedToken ? "ready" : "invalid"
    );

    // Remove the private token from the visible address bar
    // without consuming it.
    if (window.location.search) {
      window.history.replaceState(
        null,
        "",
        window.location.pathname
      );
    }
  }, []);

  async function handleVerify() {
    if (!token || view === "submitting") {
      return;
    }

    setView("submitting");

    const result =
      await verifySnapshotEmailLink(token);

    if (result.ok) {
      setToken(null);
      setView("success");
      return;
    }

    if (result.reason === "invalid_link") {
      setToken(null);
      setView("invalid");
      return;
    }

    if (result.reason === "unavailable") {
      setView("unavailable");
      return;
    }

    setView("error");
  }

  if (view === "loading") {
    return (
      <div
        className="verification-status"
        aria-live="polite"
      >
        Preparing your verification link…
      </div>
    );
  }

  if (view === "success") {
    return (
      <div
        className="verification-result"
        aria-live="polite"
      >
        <div
          className="verification-icon"
          aria-hidden="true"
        >
          ✓
        </div>

        <p className="verification-label">
          Email verified
        </p>

        <h1 className="verification-title">
          Your demo request is waiting for a fit review.
        </h1>

        <p className="verification-copy">
          Your email has been confirmed. No AI scan
          has started. Zypact will review the request
          and contact you before any pilot work or
          provider call.
        </p>

        <div className="verification-actions">
          <a
            href="/"
            className="button button-secondary"
          >
            Return to Zypact
          </a>
        </div>
      </div>
    );
  }

  if (view === "invalid") {
    return (
      <div
        className="verification-result"
        role="alert"
      >
        <p className="verification-label">
          Verification link
        </p>

        <h1 className="verification-title">
          This link is invalid or has expired.
        </h1>

        <p className="verification-copy">
          The link may already have been used, may
          have expired, or may be incomplete.
        </p>

        <div className="verification-actions">
          <a
            href="/scan"
            className="button button-primary"
          >
            Request another demo
          </a>
        </div>
      </div>
    );
  }

  const isSubmitting =
    view === "submitting";

  const feedback =
    view === "unavailable"
      ? "Email verification is temporarily unavailable. Your link has not been intentionally consumed. Please try again."
      : view === "error"
        ? "We could not complete the verification. Please try again."
        : null;

  return (
    <div className="verification-result">
      <p className="verification-label">
        Zypact V1 demo request
      </p>

      <h1 className="verification-title">
        Confirm your email address.
      </h1>

      <p className="verification-copy">
        Continue your Zypact demo request. After
        verification, the request will wait for a
        fit review. No AI scan starts automatically.
      </p>

      {feedback ? (
        <p
          className="verification-feedback"
          role="alert"
        >
          {feedback}
        </p>
      ) : null}

      <div className="verification-actions">
        <button
          type="button"
          className="button button-primary"
          onClick={handleVerify}
          disabled={isSubmitting}
        >
          {isSubmitting
            ? "Verifying…"
            : "Verify email"}
        </button>
      </div>

      <p className="verification-note">
        This private link can be used only once.
      </p>
    </div>
  );
}
