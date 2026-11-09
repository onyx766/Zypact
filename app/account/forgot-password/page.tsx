import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { readAccountsConfig } from "@/lib/accounts/config";

import { AccountForm } from "../account-form";
import { AccountShell } from "../account-shell";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Reset your password", robots: { index: false, follow: false } };

export default function ForgotPasswordPage() {
  if (!readAccountsConfig().enabled) notFound();
  return (
    <AccountShell
      eyebrow="Password"
      title="Reset your password"
      copy="We'll email you a link to choose a new password. The link works for a short time."
      footer={<a href="/account/sign-in">Back to sign in</a>}
    >
      <AccountForm
        endpoint="/api/account/forgot-password"
        submitLabel="Send reset link"
        busyLabel="Sending…"
        fields={[{ name: "email", label: "Email", type: "email", autoComplete: "email", placeholder: "you@company.com" }]}
      />
    </AccountShell>
  );
}
