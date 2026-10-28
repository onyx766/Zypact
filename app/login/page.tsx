import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/current-user";
import { isEmailAllowed } from "@/lib/auth/access-allowlist";
import {
  FOUNDER_ADMIN_PATH,
  safeNextPath,
} from "@/lib/auth/safe-next-path";
import { ZypactLogo } from "@/components/zypact-logo";
import { LoginForm } from "./login-form";

export const dynamic = "force-dynamic";

const FEATURES = [
  {
    title: "Private founder access",
    desc: "Early access for selected builders",
    icon: (
      <path d="M12 2 4 13h6l-1 9 9-13h-6l1-7Z" />
    ),
  },
  {
    title: "Built for what's next",
    desc: "From idea to execution, faster",
    icon: (
      <>
        <circle cx="9" cy="8" r="3" />
        <path d="M2.5 20a6.5 6.5 0 0 1 13 0" />
        <path d="M15.5 8.5a3 3 0 1 1 3.9 2.86" />
        <path d="M14 20a6.5 6.5 0 0 1 8-6.32" />
      </>
    ),
  },
  {
    title: "Your ideas stay private",
    desc: "Security and confidentiality first",
    icon: (
      <>
        <rect x="4" y="10" width="16" height="10" rx="2" />
        <path d="M8 10V7a4 4 0 0 1 8 0v3" />
      </>
    ),
  },
];

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
  // Only an invited account is sent on. Redirecting any session would loop
  // an uninvited one between this page and the gate that refused it.
  const uninvited = user !== null && !isEmailAllowed(user.email);

  if (user && !uninvited) {
    redirect(next);
  }

  const sent = resolvedSearchParams.sent === "1";
  const errorMsg = uninvited
    ? "This account has not been invited."
    : typeof resolvedSearchParams.error === "string"
      ? resolvedSearchParams.error
      : null;

  return (
    <main className="founder-login-page">
      <header className="founder-login-topbar">
        <ZypactLogo className="founder-login-logo" />
        <a className="founder-login-back" href="/">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
            <path d="M15 3h6v6" />
            <path d="M10 14 21 3" />
          </svg>
          Back to website
        </a>
      </header>

      <div className="founder-login-shell">
        <section className="founder-login-intro">
          <p className="founder-login-kicker">Build what matters</p>
          <h1 className="founder-login-headline">
            Zypact for
            <br />
            <span className="founder-login-headline-accent">
              Visionary Founders
            </span>
          </h1>
          <p className="founder-login-lede">
            A faster, more intelligent way to turn ideas into real
            products.
          </p>

          <ul className="founder-login-features">
            {FEATURES.map((feature) => (
              <li className="founder-login-feature" key={feature.title}>
                <span className="founder-login-feature-icon">
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    {feature.icon}
                  </svg>
                </span>
                <span>
                  <span className="founder-login-feature-title">
                    {feature.title}
                  </span>
                  <span className="founder-login-feature-desc">
                    {feature.desc}
                  </span>
                </span>
              </li>
            ))}
          </ul>

          <p className="founder-login-tagline">
            Bolder ideas.
            <br />
            Brighter tomorrow.
          </p>
        </section>

        <section className="founder-login-card">
          <p className="founder-login-eyebrow">Founder access</p>
          <h2 className="founder-login-title">Sign in</h2>
          <p className="founder-login-copy">
            Enter your founder email. We&rsquo;ll send a private
            sign-in link.
          </p>

          {sent ? (
            <div
              className="founder-login-alert founder-login-alert-success"
              role="status"
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <circle cx="12" cy="12" r="9" />
                <path d="m8.5 12.5 2.5 2.5 5-5" />
              </svg>
              <p className="founder-login-alert-title">
                Check your email for the sign-in link.
              </p>
            </div>
          ) : (
            <LoginForm next={next} />
          )}

          {errorMsg ? (
            <div
              className="founder-login-alert founder-login-alert-error"
              role="alert"
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <circle cx="12" cy="12" r="9" />
                <path d="M12 8v5" />
                <path d="M12 16h.01" />
              </svg>
              <p className="founder-login-alert-title">{errorMsg}</p>
            </div>
          ) : null}

          <div className="founder-login-footnote">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <rect x="4" y="10" width="16" height="10" rx="2" />
              <path d="M8 10V7a4 4 0 0 1 8 0v3" />
            </svg>
            <span>
              <span className="founder-login-footnote-title">
                Private access only
              </span>
              <span className="founder-login-footnote-desc">
                Magic link expires in 30 minutes.
              </span>
            </span>
          </div>
        </section>
      </div>
    </main>
  );
}
