/**
 * The crawler's only outbound HTTP transport.
 *
 * Validating a URL and then calling global `fetch` would be an illusion of
 * protection: `fetch` performs its own DNS resolution, so a hostname that
 * validated as public can answer with a private address microseconds later
 * (classic DNS rebinding). The check has to bind at the socket.
 *
 * Node's `http`/`https` `request` accepts a `lookup` option, which is the
 * function the socket uses to turn a hostname into an address. Supplying a
 * lookup that can *only* return the already-validated addresses means the
 * connection cannot land anywhere else — no second resolution, no window
 * to swap the answer. That mechanism needs no new dependency; `undici` is
 * not installed in this project and Node's bundled copy is not importable.
 *
 * Redirects are followed manually, one hop at a time, with the full policy
 * re-applied to every destination. `redirect: "follow"` would hand the
 * decision to the transport and defeat the entire module.
 *
 * The Host header and TLS SNI keep the original hostname, so pinning is
 * invisible to the server and virtual hosting still works.
 */

import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

import {
  MAX_REDIRECTS,
  UnsafeOutboundUrlError,
  validateOutboundUrl,
  type DnsLookup,
} from "@/lib/crawler/outbound-url-safety";

/** Minimal response shape — the subset the crawler actually consumes. */
export interface SafeFetchResponse {
  ok: boolean;
  status: number;
  contentType: string;
  text: string;
  /** Final URL after any redirects, for provenance. */
  finalUrl: string;
}

export interface SafeFetchOptions {
  timeoutMs: number;
  userAgent: string;
  /** Injected for tests; defaults to real DNS. */
  dnsLookup?: DnsLookup;
  /** Injected for tests; defaults to the real socket transport. */
  transport?: Transport;
  maxRedirects?: number;
}

/**
 * One HTTP exchange with no redirect handling, pinned to `addresses`.
 * Injectable so tests can drive the redirect and rebinding logic without
 * a network, while production uses the pinned socket implementation.
 */
export type Transport = (input: {
  url: URL;
  addresses: string[];
  timeoutMs: number;
  userAgent: string;
}) => Promise<{ status: number; headers: Record<string, string>; body: string }>;

/** Caps a response body so a hostile server cannot exhaust memory. */
export const MAX_BODY_BYTES = 5_000_000;

/**
 * Raised when a response exceeds `MAX_BODY_BYTES`.
 *
 * This is a distinct type because the first implementation called
 * `res.destroy()` and returned nothing: `destroy()` emits neither `end`
 * nor `error`, so the promise never settled and any oversized page stalled
 * the crawl until the worker's outer execution bound expired. Capping the
 * body is only useful if exceeding the cap *terminates* the request.
 */
export class ResponseTooLargeError extends Error {
  constructor(limitBytes: number) {
    super(`Response body exceeded ${limitBytes} bytes`);
    this.name = "ResponseTooLargeError";
  }
}

export const pinnedTransport: Transport = ({
  url,
  addresses,
  timeoutMs,
  userAgent,
}) =>
  new Promise((resolve, reject) => {
    const isHttps = url.protocol === "https:";
    const requestFn = isHttps ? httpsRequest : httpRequest;

    // Every exit path funnels through here. `destroy()` fires neither
    // `end` nor `error`, and a destroyed socket can still emit `close`
    // afterwards, so without a guard the promise could hang or settle
    // twice. Settling exactly once is the invariant.
    let settled = false;
    const finish = (
      outcome: { ok: true; value: Awaited<ReturnType<Transport>> } | { ok: false; error: Error }
    ): void => {
      if (settled) return;
      settled = true;
      if (outcome.ok) resolve(outcome.value);
      else reject(outcome.error);
    };

    // The socket asks for an address; it may only ever be given one that
    // already passed validation. This is the enforcement point.
    const pinnedLookup = (
      _hostname: string,
      options: unknown,
      callback: (
        err: NodeJS.ErrnoException | null,
        address?: string | Array<{ address: string; family: number }>,
        family?: number
      ) => void
    ): void => {
      const familyOf = (addr: string): number => (addr.includes(":") ? 6 : 4);
      const all =
        typeof options === "object" && options !== null &&
        (options as { all?: boolean }).all === true;

      if (addresses.length === 0) {
        callback(new Error("no validated address"));
        return;
      }
      if (all) {
        callback(
          null,
          addresses.map((address) => ({ address, family: familyOf(address) }))
        );
        return;
      }
      callback(null, addresses[0], familyOf(addresses[0]));
    };

    const req = requestFn(
      {
        protocol: url.protocol,
        hostname: url.hostname, // preserved for Host header and SNI
        port: url.port || (isHttps ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: "GET",
        headers: {
          host: url.host,
          "user-agent": userAgent,
          accept: "text/html,application/xhtml+xml",
        },
        servername: isHttps ? url.hostname : undefined,
        lookup: pinnedLookup as never,
        // No connection pooling. Node's global agent keeps sockets alive,
        // and a pooled socket is reused *without* calling `lookup` — so a
        // later request to the same host:port would skip the pin entirely.
        // A fresh socket per request means every connection re-enters
        // validation and pinning, with no reuse to inherit.
        agent: false,
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let total = 0;

        res.on("data", (chunk: Buffer) => {
          if (settled) return;
          total += chunk.length;
          if (total > MAX_BODY_BYTES) {
            // Stop reading, tear the connection down, and settle now —
            // rather than waiting for an `end` that will never arrive.
            chunks.length = 0;
            res.destroy();
            req.destroy();
            finish({ ok: false, error: new ResponseTooLargeError(MAX_BODY_BYTES) });
            return;
          }
          chunks.push(chunk);
        });

        res.on("end", () => {
          const headers: Record<string, string> = {};
          for (const [key, value] of Object.entries(res.headers)) {
            headers[key.toLowerCase()] = Array.isArray(value)
              ? value.join(", ")
              : String(value ?? "");
          }
          finish({
            ok: true,
            value: {
              status: res.statusCode ?? 0,
              headers,
              body: Buffer.concat(chunks).toString("utf-8"),
            },
          });
        });

        res.on("error", (err) => finish({ ok: false, error: err }));

        // A response destroyed by anything other than the cap above must
        // still settle rather than leave the caller waiting.
        res.on("close", () => {
          finish({ ok: false, error: new Error("Response closed before completion") });
        });
      }
    );

    req.on("timeout", () => {
      // `destroy(err)` surfaces through the request's `error` handler,
      // which settles; the explicit finish keeps that guaranteed even if
      // the socket was already gone.
      req.destroy(new Error("request timed out"));
      finish({ ok: false, error: new Error("request timed out") });
    });
    req.on("error", (err) => finish({ ok: false, error: err }));
    req.end();
  });

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * Fetch a URL under the full outbound policy, following at most
 * `maxRedirects` hops and revalidating every one of them.
 *
 * A redirect to a private address, a non-http(s) scheme, or a credentialed
 * URL is rejected before any connection to it is opened — the check runs
 * on the Location value, not on the response that would follow it.
 */
export async function safeFetch(
  rawUrl: string,
  options: SafeFetchOptions
): Promise<SafeFetchResponse> {
  const transport = options.transport ?? pinnedTransport;
  const maxRedirects = options.maxRedirects ?? MAX_REDIRECTS;

  let current = rawUrl;

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    // Full policy on every hop, including the first.
    const destination = await validateOutboundUrl(current, options.dnsLookup);

    const response = await transport({
      url: destination.url,
      addresses: destination.addresses,
      timeoutMs: options.timeoutMs,
      userAgent: options.userAgent,
    });

    const location = response.headers["location"];
    if (!REDIRECT_STATUSES.has(response.status) || !location) {
      return {
        ok: response.status >= 200 && response.status < 300,
        status: response.status,
        contentType: response.headers["content-type"] ?? "",
        text: response.body,
        finalUrl: destination.url.toString(),
      };
    }

    if (hop === maxRedirects) break;

    // Resolve relative Locations against the URL that issued them. The
    // resulting absolute URL re-enters validation at the top of the loop.
    try {
      current = new URL(location, destination.url).toString();
    } catch {
      throw new UnsafeOutboundUrlError("invalid_url");
    }
  }

  throw new Error(`Too many redirects (limit ${maxRedirects})`);
}
