import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/current-user";
import { LoginForm } from "./login-form";

export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: { sent?: string; error?: string; next?: string };
}) {
  const user = await getCurrentUser();
  if (user) {
    redirect("/");
  }

  const sent = searchParams.sent === "1";
  const errorMsg = typeof searchParams.error === "string" ? searchParams.error : null;
  const next = typeof searchParams.next === "string" ? searchParams.next : "/";

  return (
    <section>
      <h1>Sign in</h1>
      <p className="muted">
        Enter your email. We&apos;ll send a magic link to sign you in.
      </p>
      {sent ? (
        <p style={{ color: "green" }}>
          Check your email for a sign-in link. You can close this tab.
        </p>
      ) : (
        <LoginForm next={next} />
      )}
      {errorMsg ? (
        <p style={{ color: "crimson" }} role="alert">
          {errorMsg}
        </p>
      ) : null}
    </section>
  );
}
