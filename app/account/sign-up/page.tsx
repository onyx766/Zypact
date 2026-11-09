import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";

import { PASSWORD_MIN_LENGTH, readAccountsConfig } from "@/lib/accounts/config";
import { currentAccount } from "@/lib/accounts/http";

import { AccountForm } from "../account-form";
import { AccountShell } from "../account-shell";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Create your account", robots: { index: false, follow: false } };

export default async function SignUpPage() {
  const config = readAccountsConfig();
  if (!config.enabled) notFound();
  if (await currentAccount()) redirect("/account");
  const closed = config.signupMode === "closed";

  return (
    <AccountShell
      eyebrow={config.signupMode === "pilot" ? "Pilot access" : "Get started"}
      title="Create your account"
      copy="We'll email you a link to verify your address. Your workspace is created when you first sign in."
      notice={closed ? { tone: "error", text: "Sign-up isn't open right now." } : null}
      footer={
        <span>
          Already have an account? <a href="/account/sign-in">Sign in</a>
        </span>
      }
    >
      {closed ? null : (
        <AccountForm
          endpoint="/api/account/sign-up"
          submitLabel="Create account"
          busyLabel="Creating…"
          fields={[
            { name: "workspaceName", label: "Company", type: "text", autoComplete: "organization", placeholder: "Example SaaS" },
            { name: "email", label: "Work email", type: "email", autoComplete: "email", placeholder: "you@company.com" },
            {
              name: "password",
              label: `Password (at least ${PASSWORD_MIN_LENGTH} characters)`,
              type: "password",
              autoComplete: "new-password",
            },
          ]}
        />
      )}
    </AccountShell>
  );
}
