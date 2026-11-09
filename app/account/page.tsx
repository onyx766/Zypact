import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";

import { readAccountsConfig } from "@/lib/accounts/config";
import { currentAccount } from "@/lib/accounts/http";

import { SignOutButton } from "./account-form";
import { AccountShell } from "./account-shell";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Your workspace", robots: { index: false, follow: false } };

export default async function AccountHomePage() {
  if (!readAccountsConfig().enabled) notFound();
  const account = await currentAccount();
  if (!account) redirect("/account/sign-in");

  const until = account.session.absoluteExpiresAt.slice(0, 16).replace("T", " ");

  return (
    <AccountShell
      eyebrow={account.email}
      title={account.workspaceName ?? "Your workspace"}
      copy="Your workspace is ready. The next steps open here as they become available."
      footer={<span>Signed in until {until} UTC at the latest, or sooner if you are idle.</span>}
    >
      <ul className="founder-login-features" style={{ margin: "8px 0 20px" }}>
        <li className="founder-login-feature">
          <span>
            <span className="founder-login-feature-title">Website diagnostic</span>
            <span className="founder-login-feature-desc">Coming soon: check how your site presents your product to buyers.</span>
          </span>
        </li>
        <li className="founder-login-feature">
          <span>
            <span className="founder-login-feature-title">Buyer questions</span>
            <span className="founder-login-feature-desc">Coming soon: choose the questions your buyers ask.</span>
          </span>
        </li>
      </ul>
      <SignOutButton />
    </AccountShell>
  );
}
