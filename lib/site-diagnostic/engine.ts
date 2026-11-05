/**
 * W1 Website Buyer-Readiness Diagnostic: the one entry point.
 *
 *   input URL → normalise → SSRF pre-check → crawl (W1-B) → checks (W1-A)
 *   → immutable report (W1-C)
 *
 * No model call, no paid call, no third-party API, no database. The only
 * outbound requests are to the submitted host and its www/apex alternate,
 * through the pinned SSRF-safe transport, within W1_FETCH_POLICY.
 *
 * Results are closed codes; no error message from the network or the site
 * ever reaches the caller.
 */
import {
  UnsafeOutboundUrlError,
  validateOutboundUrl,
  type DnsLookup,
} from "@/lib/crawler/outbound-url-safety";
import type { Transport } from "@/lib/crawler/safe-fetch";
import { evaluateChecks } from "@/lib/site-diagnostic/checks";
import { crawlForDiagnostic, type CrawlDeps } from "@/lib/site-diagnostic/crawl";
import { buildDiagnosticReport, type DiagnosticReport } from "@/lib/site-diagnostic/report";
import { normalizeDiagnosticInput, type InputRefusal } from "@/lib/site-diagnostic/url";

export type DiagnosticRefusal =
  | InputRefusal
  /** The host resolves to a non-public address (SSRF policy). */
  | "blocked_destination"
  /** The host does not resolve. */
  | "host_unresolvable";

export type DiagnosticResult =
  | { ok: true; report: DiagnosticReport }
  | { ok: false; refusal: DiagnosticRefusal };

export interface DiagnosticDeps extends CrawlDeps {
  transport?: Transport;
  dnsLookup?: DnsLookup;
}

export async function runSiteDiagnostic(rawUrl: string, deps: DiagnosticDeps = {}): Promise<DiagnosticResult> {
  const normalized = normalizeDiagnosticInput(rawUrl);
  if (!normalized.ok) return { ok: false, refusal: normalized.reason };

  // Refuse before any request when the host itself is not a public
  // destination; per-hop checks inside the crawl still apply afterwards.
  try {
    await validateOutboundUrl(normalized.value.startUrl, deps.dnsLookup);
  } catch (error) {
    if (error instanceof UnsafeOutboundUrlError) {
      if (error.reason === "dns_resolution_failed" || error.reason === "no_public_address") {
        return { ok: false, refusal: "host_unresolvable" };
      }
      return { ok: false, refusal: "blocked_destination" };
    }
    throw error;
  }

  const { capture, bodies } = await crawlForDiagnostic(normalized.value, deps);
  const findings = evaluateChecks(capture, bodies);
  return { ok: true, report: buildDiagnosticReport(capture, findings) };
}

export const REFUSAL_TEXT: Readonly<Record<DiagnosticRefusal, string>> = {
  empty: "Enter a website address.",
  invalid_url: "That is not a valid website address.",
  unsupported_protocol: "Only http and https addresses can be checked.",
  embedded_credentials: "Addresses with a username or password cannot be checked.",
  non_default_port: "Only addresses on the standard web ports can be checked.",
  ip_literal: "Enter a domain name, not an IP address.",
  reserved_hostname: "That host name is reserved for private networks.",
  invalid_domain: "That is not a valid public domain name.",
  blocked_destination: "That address is not a public internet destination.",
  host_unresolvable: "That domain could not be found.",
};
