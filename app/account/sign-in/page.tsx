import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";

import { readAccountsConfig } from "@/lib/accounts/config";
import { currentAccount } from "@/lib/accounts/http";

import { AccountForm } from "../account-form";
import { AccountShell } from "../account-shell";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Sign in", robots: { index: false, follow: false } };

const NOTICES: Record<string, { tone: "success" | "error"; text: string }> = {
  signed_out: { tone: "success", text: "You're signed out." },
  password_changed: { tone: "success", text: "Password changed. Sign in with the new one." },
  link_invalid: {
    tone: "error",
    text: "That link has expired or was already used. If you verified your email, sign in below.",
  },
  verify_email: { tone: "error", text: "Verify your email first. We can send a new link." },
  not_approved: { tone: "error", text: "This email isn't approved for the Zypact pilot yet." },
  workspace_ambiguous: { tone: "error", text: "This account belongs to more than one workspace. Please contact Zypact." },
  workspace_conflict: { tone: "error", text: "Your workspace could not be set up. Please contact Zypact." },
};

export default async function SignInPage({ searchParams }: { searchParams: Promise<{ notice?: string }> }) {
  if (!readAccountsConfig().enabled) notFound();
  if (await currentAccount()) redirect("/account");
  const { notice } = await searchParams;

  return (
    <AccountShell
      eyebrow="Your workspace"
      title="Sign in"
      copy="Use the email and password you signed up with."
      notice={notice ? (NOTICES[notice] ?? null) : null}
      footer={
        <span>
          <a href="/account/forgot-password">Forgot password?</a> · <a href="/account/verify">Resend verification</a> ·{" "}
          <a href="/account/sign-up">Create an account</a>
        </span>
      }
    >
      <AccountForm
        endpoint="/api/account/sign-in"
        submitLabel="Sign in"
        busyLabel="Signing in…"
        fields={[
          { name: "email", label: "Email", type: "email", autoComplete: "email", placeholder: "you@company.com" },
          { name: "password", label: "Password", type: "password", autoComplete: "current-password" },
        ]}
      />
    </AccountShell>
  );
}
