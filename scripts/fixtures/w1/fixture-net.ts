/**
 * Offline network for the W1 tests: fake DNS, a fixture transport and a
 * virtual clock. Nothing here opens a socket or queries real DNS.
 *
 * Every site is synthetic and lives on a reserved `.example` domain.
 */
import type { DnsLookup } from "@/lib/crawler/outbound-url-safety";
import { RequestTimeoutError, ResponseTooLargeError, type Transport, type TransportInput } from "@/lib/crawler/safe-fetch";

export interface FixtureResponse {
  status: number;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  /** Simulated network time for this response (virtual ms). */
  latencyMs?: number;
  /** Throw this instead of answering. */
  fail?: "timeout" | "reset";
}

export type FixtureRoutes = Record<string, FixtureResponse>;

export class VirtualClock {
  constructor(public ms = Date.parse("2026-11-05T09:00:00.000Z")) {}
  now = (): number => this.ms;
  sleep = async (ms: number): Promise<void> => {
    this.ms += ms;
  };
}

export const PUBLIC_IP = "93.184.216.34";

export interface FixtureNet {
  transport: Transport;
  dnsLookup: DnsLookup;
  clock: VirtualClock;
  /** Every URL the transport was asked for, in order. */
  requests: string[];
  /** Every Accept header sent, in order. */
  accepts: string[];
  inputs: TransportInput[];
}

/**
 * routes: absolute URL (no fragment) → response. Unknown URLs answer 404.
 * hosts: DNS answers; a host missing from the map fails to resolve.
 */
export function fixtureNet(
  routes: FixtureRoutes,
  hosts: Record<string, string[]> = {},
  options: { defaultLatencyMs?: number } = {}
): FixtureNet {
  const clock = new VirtualClock();
  const requests: string[] = [];
  const accepts: string[] = [];
  const inputs: TransportInput[] = [];
  const knownHosts = new Map<string, string[]>(Object.entries(hosts));
  for (const url of Object.keys(routes)) {
    const host = new URL(url).hostname;
    if (!knownHosts.has(host)) knownHosts.set(host, [PUBLIC_IP]);
  }

  const dnsLookup: DnsLookup = async (hostname) => {
    const addresses = knownHosts.get(hostname.toLowerCase());
    if (!addresses) throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
    return addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  };

  const transport: Transport = async (input) => {
    inputs.push(input);
    const key = input.url.toString();
    requests.push(key);
    accepts.push(input.accept ?? "");
    const route: FixtureResponse = routes[key] ?? { status: 404, headers: { "content-type": "text/html" }, body: "<!doctype html><title>Not found</title><h1>Not found</h1>" };
    const latency = route.latencyMs ?? options.defaultLatencyMs ?? 20;
    if (input.deadlineMs !== undefined && latency > input.deadlineMs) {
      clock.ms += input.deadlineMs;
      throw new RequestTimeoutError();
    }
    clock.ms += latency;
    if (route.fail === "timeout") throw new RequestTimeoutError();
    if (route.fail === "reset") throw new Error("socket hang up");
    const raw = route.body ?? "";
    let bytes = typeof raw === "string" ? new TextEncoder().encode(raw) : raw;
    let truncated = false;
    const cap = input.maxBodyBytes ?? 5_000_000;
    if (bytes.length > cap) {
      if (input.onOversize === "truncate") {
        bytes = bytes.subarray(0, cap);
        truncated = true;
      } else {
        throw new ResponseTooLargeError(cap);
      }
    }
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(route.headers ?? {})) headers[name.toLowerCase()] = value;
    return { status: route.status, headers, body: Buffer.from(bytes).toString("utf8"), bodyBytes: bytes, truncated };
  };

  return { transport, dnsLookup, clock, requests, accepts, inputs };
}

export const html = (body: string, head = ""): FixtureResponse => ({
  status: 200,
  headers: { "content-type": "text/html; charset=utf-8" },
  body: `<!doctype html><html lang="en"><head>${head}</head><body>${body}</body></html>`,
});

export const text = (body: string, contentType = "text/plain; charset=utf-8", status = 200): FixtureResponse => ({
  status,
  headers: { "content-type": contentType },
  body,
});

export const redirect = (location: string, status = 301): FixtureResponse => ({
  status,
  headers: { location },
  body: "",
});

const words = (n: number, seed = "evidence") => Array.from({ length: n }, (_, i) => `${seed}${i % 7}`).join(" ");

/**
 * A representative synthetic B2B SaaS site at https://www.acme-analytics.example.
 * The apex redirects to www. GPTBot and CCBot are disallowed; ZypactBot is not.
 */
export function acmeSite(): FixtureRoutes {
  const origin = "https://www.acme-analytics.example";
  const nav = `
    <header><nav>
      <a href="/product">Product</a>
      <a href="/pricing">Pricing</a>
      <a href="/integrations">Integrations</a>
      <a href="/security">Security</a>
      <a href="/customers">Customers</a>
      <a href="/compare/acme-vs-rival">Compare</a>
      <a href="/faq">FAQ</a>
      <a href="https://docs.acme-analytics.example/">Docs</a>
      <a href="/login">Log in</a>
      <a href="/pricing?plan=pro&amp;email=someone%40example.com">Pro plan</a>
      <a href="/brochure.pdf">Brochure</a>
      <a href="https://rival.example/">Rival</a>
    </nav></header>`;
  const footer = `<footer><a href="/careers">Careers</a> <a href="/blog">Blog</a><p>© 2019–2026 Acme Analytics, Inc. All rights reserved.</p></footer>`;
  const page = (title: string, h1: string, path: string, extraHead = "", extraBody = "") =>
    html(
      `${nav}<main><h1>${h1}</h1><p>${words(160)}</p>${extraBody}</main>${footer}`,
      `<title>${title}</title><meta name="description" content="${h1} for B2B teams."><link rel="canonical" href="${origin}${path}">${extraHead}`
    );
  const orgLd = `<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"Organization","name":"Acme Analytics","url":"${origin}/","logo":"${origin}/logo.png","sameAs":["https://social.example/acme"]},{"@type":"WebSite","name":"Acme Analytics"}]}</script>`;

  return {
    "https://acme-analytics.example/robots.txt": redirect(`${origin}/robots.txt`),
    "https://acme-analytics.example/": redirect(`${origin}/`),
    [`${origin}/robots.txt`]: text(
      `# robots for Acme\nUser-agent: *\nDisallow: /internal/\n\nUser-agent: GPTBot\nUser-agent: CCBot\nDisallow: /\n\nSitemap: ${origin}/sitemap.xml\n`
    ),
    [`${origin}/`]: html(
      `${nav}<main><h1>Product analytics for B2B teams</h1><p>${words(220)} seamless all-in-one streamline</p></main>${footer}`,
      `<title>Acme Analytics | Product analytics for B2B teams</title><meta name="description" content="Acme Analytics shows how B2B teams use their product."><link rel="canonical" href="${origin}/"><meta property="og:site_name" content="Acme Analytics">${orgLd}`
    ),
    [`${origin}/sitemap.xml`]: text(
      `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${origin}/</loc></url><url><loc>${origin}/pricing</loc></url><url><loc>${origin}/about</loc></url><url><loc>https://other.example/x</loc></url></urlset>`,
      "application/xml"
    ),
    [`${origin}/llms.txt`]: text(`# Acme Analytics\n\n> Product analytics for B2B teams.\n`),
    [`${origin}/product`]: page("Product | Acme Analytics", "The Acme product", "/product"),
    [`${origin}/pricing`]: page("Pricing | Acme Analytics", "Pricing", "/pricing"),
    [`${origin}/integrations`]: page("Integrations | Acme Analytics", "Integrations", "/integrations"),
    [`${origin}/security`]: page("Security | Acme Analytics", "Security at Acme", "/security"),
    [`${origin}/customers`]: page("Customers | Acme Analytics", "Customer stories", "/customers"),
    [`${origin}/compare/acme-vs-rival`]: page("Acme vs Rival | Acme Analytics", "Acme vs Rival", "/compare/acme-vs-rival"),
    [`${origin}/faq`]: page(
      "FAQ | Acme Analytics",
      "Frequently asked questions",
      "/faq",
      `<script type="application/ld+json">{"@context":"https://schema.org","@type":"FAQPage","mainEntity":[]}</script>`
    ),
    [`${origin}/about`]: page("About | Acme Analytics", "About Acme", "/about"),
    [`${origin}/careers`]: page("Careers | Acme Analytics", "Careers", "/careers"),
    [`${origin}/blog`]: page("Blog | Acme Analytics", "Blog", "/blog"),
  };
}
