import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { PASSWORD_MIN_LENGTH, readAccountsConfig } from "@/lib/accounts/config";

import { AccountForm } from "../account-form";
import { AccountShell } from "../account-shell";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Choose a new password", robots: { index: false, follow: false } };

export default function ResetPasswordPage() {
  if (!readAccountsConfig().enabled) notFound();
  return (
    <AccountShell
      eyebrow="Password"
      title="Choose a new password"
      copy="This signs you out everywhere. Then sign in with the new password."
      footer={<a href="/account/forgot-password">Need a new link?</a>}
    >
      <AccountForm
        endpoint="/api/account/reset-password"
        submitLabel="Save password"
        busyLabel="Saving…"
        fields={[
          {
            name: "password",
            label: `New password (at least ${PASSWORD_MIN_LENGTH} characters)`,
            type: "password",
            autoComplete: "new-password",
          },
        ]}
      />
    </AccountShell>
  );
}
