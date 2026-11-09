import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { readAccountsConfig } from "@/lib/accounts/config";

import { AccountForm } from "../account-form";
import { AccountShell } from "../account-shell";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Resend verification", robots: { index: false, follow: false } };

export default function VerifyPage() {
  if (!readAccountsConfig().enabled) notFound();
  return (
    <AccountShell
      eyebrow="Verify your email"
      title="Resend the link"
      copy="Enter the email you signed up with. If it's waiting for verification, we'll send a new link."
      footer={<a href="/account/sign-in">Back to sign in</a>}
    >
      <AccountForm
        endpoint="/api/account/resend-verification"
        submitLabel="Send link"
        busyLabel="Sending…"
        fields={[{ name: "email", label: "Email", type: "email", autoComplete: "email", placeholder: "you@company.com" }]}
      />
    </AccountShell>
  );
}
