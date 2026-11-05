#!/usr/bin/env tsx
/**
 * W1-B: the additive transport options in lib/crawler/safe-fetch.ts.
 *
 * Uses a real pinnedTransport against a 127.0.0.1 server only (the same
 * approach as scripts/test-outbound-url-safety.ts): the URL names a `.invalid`
 * host and the socket is pinned to the loopback address, so no DNS query and
 * no external connection can happen. safeFetchOnce is exercised with an
 * injected transport and DNS.
 *
 * Proves: defaults are unchanged for existing callers; Accept and
 * Accept-Encoding are sent as asked; the raw bytes are returned exactly;
 * "truncate" keeps the prefix; "reject" still throws; the wall-clock deadline
 * fires on a slow drip that the idle timeout alone would allow; a 3xx comes
 * back unfollowed from safeFetchOnce.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import {
  RequestTimeoutError,
  ResponseTooLargeError,
  pinnedTransport,
  safeFetch,
  safeFetchOnce,
  type Transport,
} from "@/lib/crawler/safe-fetch";

let failures = 0;
let total = 0;
function check(label: string, condition: boolean): void {
  total += 1;
  if (condition) console.log("  ✓ " + label);
  else {
    failures += 1;
    console.error("  ✗ " + label);
  }
}

const seen: Array<Record<string, string | string[] | undefined>> = [];

function handler(req: IncomingMessage, res: ServerResponse): void {
  seen.push({ ...req.headers });
  const path = req.url ?? "/";
  if (path === "/bytes") {
    res.writeHead(200, { "content-type": "text/html; charset=windows-1252" });
    res.end(Buffer.from([0x3c, 0x70, 0x3e, 0xe9, 0x3c, 0x2f, 0x70, 0x3e]));
    return;
  }
  if (path === "/big") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("a".repeat(4096));
    return;
  }
  if (path === "/drip") {
    res.writeHead(200, { "content-type": "text/plain" });
    const timer = setInterval(() => res.write("x"), 50);
    res.on("close", () => clearInterval(timer));
    return;
  }
  res.writeHead(200, { "content-type": "text/html", "x-robots-tag": "noindex" });
  res.end("<h1>ok</h1>");
}

async function main(): Promise<void> {
  console.log("test-w1-safe-fetch");
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const base = { addresses: ["127.0.0.1"], timeoutMs: 2_000, userAgent: "w1-test" };
  const url = (path: string) => new URL(`http://w1.invalid:${port}${path}`);

  try {
    const legacy = await pinnedTransport({ ...base, url: url("/") });
    check("T1 default request still sends the HTML Accept header", seen[0].accept === "text/html,application/xhtml+xml");
    check("T2 default request sends no Accept-Encoding", seen[0]["accept-encoding"] === undefined);
    check("T3 default result keeps the decoded body", legacy.body === "<h1>ok</h1>" && legacy.truncated === false);
    check("T4 headers are returned lowercased", legacy.headers["x-robots-tag"] === "noindex");

    await pinnedTransport({ ...base, url: url("/"), accept: "text/plain", acceptEncoding: "identity" });
    check("T5 Accept is sent as asked", seen[1].accept === "text/plain");
    check("T6 Accept-Encoding: identity is sent", seen[1]["accept-encoding"] === "identity");

    const raw = await pinnedTransport({ ...base, url: url("/bytes") });
    check("T7 raw bytes are returned exactly, before decoding", Buffer.from(raw.bodyBytes ?? []).equals(Buffer.from([0x3c, 0x70, 0x3e, 0xe9, 0x3c, 0x2f, 0x70, 0x3e])));

    const cut = await pinnedTransport({ ...base, url: url("/big"), maxBodyBytes: 1000, onOversize: "truncate" });
    check("T8 truncate keeps exactly the cap's prefix", cut.truncated === true && cut.bodyBytes?.length === 1000);

    let rejected: unknown = null;
    try {
      await pinnedTransport({ ...base, url: url("/big"), maxBodyBytes: 1000 });
    } catch (error) {
      rejected = error;
    }
    check("T9 over the cap without truncate still rejects", rejected instanceof ResponseTooLargeError);

    const started = Date.now();
    let timedOut: unknown = null;
    try {
      await pinnedTransport({ ...base, url: url("/drip"), timeoutMs: 1_000, deadlineMs: 300 });
    } catch (error) {
      timedOut = error;
    }
    const elapsed = Date.now() - started;
    check("T10 the wall-clock deadline stops a slow drip the idle timeout allows", timedOut instanceof RequestTimeoutError && elapsed < 1_500);
    check("T11 the timeout keeps its historic message", (timedOut as Error | null)?.message === "request timed out");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  // safeFetchOnce: validation still applies, and a 3xx is returned, not followed.
  const calls: string[] = [];
  const stub: Transport = async (input) => {
    calls.push(input.url.toString());
    return { status: 301, headers: { location: "https://elsewhere.example/" }, body: "" };
  };
  const dns = async () => [{ address: "93.184.216.34", family: 4 }];
  const once = await safeFetchOnce("https://site.example/", { transport: stub, dnsLookup: dns, timeoutMs: 1000, userAgent: "w1-test" });
  check("T12 safeFetchOnce returns the 3xx unfollowed", once.status === 301 && once.headers.location === "https://elsewhere.example/" && calls.length === 1);
  check("T13 legacy stubs without bodyBytes still yield bytes", once.bodyBytes instanceof Uint8Array && once.bodyBytes.length === 0);
  let refused = false;
  try {
    await safeFetchOnce("https://private.example/", { transport: stub, dnsLookup: async () => [{ address: "10.1.2.3", family: 4 }], timeoutMs: 1000, userAgent: "w1-test" });
  } catch {
    refused = true;
  }
  check("T14 safeFetchOnce refuses a private destination before connecting", refused && calls.length === 1);

  // safeFetch behaviour unchanged: it still follows redirects itself.
  const chain: string[] = [];
  const follow: Transport = async (input) => {
    chain.push(input.url.toString());
    const headers: Record<string, string> = chain.length === 1 ? { location: "/next" } : { "content-type": "text/html" };
    return { status: chain.length === 1 ? 302 : 200, headers, body: chain.length === 1 ? "" : "done" };
  };
  const followed = await safeFetch("https://site.example/", { transport: follow, dnsLookup: dns, timeoutMs: 1000, userAgent: "w1-test" });
  check("T15 safeFetch still follows redirects as before", followed.text === "done" && chain.length === 2 && followed.finalUrl === "https://site.example/next");

  console.log(`\n${total - failures}/${total} checks passed.`);
  console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
