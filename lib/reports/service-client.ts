import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Service-role client for report review and delivery.
 *
 * Server-only. These paths call RPCs granted to `service_role` alone —
 * resolving a review, saving an artifact, claiming a delivery — none of which
 * an anon or authenticated browser client may execute. Every caller must
 * enforce founder authorization itself BEFORE reaching this client: it carries
 * no user identity and applies no row-level policy.
 */
export function getReportServiceClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error(
      "Supabase service-role configuration is required for report review."
    );
  }

  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
