import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/current-user";
import {
  FOUNDER_ADMIN_PATH,
  safeNextPath,
} from "@/lib/auth/safe-next-path";
import { LoginForm } from "./login-form";

export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{
    sent?: string;
    error?: string;
    next?: string;
  }>;
}) {
  const resolvedSearchParams = await searchParams;
  const next = safeNextPath(
    resolvedSearchParams.next,
    FOUNDER_ADMIN_PATH
  );

  const user = await getCurrentUser();

  if (user) {
    redirect(next);
  }

  const sent = resolvedSearchParams.sent === "1";
  const errorMsg =
    typeof resolvedSearchParams.error === "string"
      ? resolvedSearchParams.error
      : null;

  return (
    <main className="founder-login-page">
      <section className="founder-login-card">
      <p
        className="founder-login-eyebrow"
        style={{
          margin: "0 0 12px",
          color: "#999",
          fontSize: 13,
          textTransform: "uppercase",
          letterSpacing: "0.04em",
        }}
      >
        Founder access
      </p>

      <h1
        className="founder-login-title"
        style={{
          margin: 0,
          fontSize: 42,
          lineHeight: 1.05,
        }}
      >
        Sign in
      </h1>

      <p
        className="founder-login-copy"
        style={{
          margin: "18px 0 28px",
          color: "#666",
          lineHeight: 1.6,
        }}
      >
        Enter your founder email. We will send a
        private sign-in link.
      </p>

      {sent ? (
        <p style={{ color: "#18794e" }}>
          Check your email for the sign-in link.
        </p>
      ) : (
        <LoginForm next={next} />
      )}

      {errorMsg ? (
        <p
          style={{ color: "crimson" }}
          role="alert"
        >
          {errorMsg}
        </p>
      ) : null}
      </section>
    </main>
  );
}
