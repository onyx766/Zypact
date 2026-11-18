#!/usr/bin/env node
/**
 * Read-only regression contract for the public marketing homepage switch.
 * Run: node scripts/test-reflex-homepage-contract.cjs
 * Does not contact production or make any paid API calls.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const cfg = require(path.join(root, "next.config.js"));

(async () => {
  const rw = await cfg.rewrites();
  assert.deepEqual(rw.beforeFiles, [
    { source: "/", destination: "/reflex-v3-production.html" },
  ]);
  assert.deepEqual(rw.afterFiles, []);
  assert.deepEqual(rw.fallback, []);

  const hdr = await cfg.headers();
  assert(hdr.some(({source, headers}) =>
    source === "/reflex-v3-production.html" &&
    headers.some(({key, value}) => key === "X-Robots-Tag" && value.includes("noindex"))));

  const html = fs.readFileSync(path.join(root, "public/reflex-v3-production.html"), "utf8");
  assert(html.includes('<link rel="canonical" href="https://www.zypact.com/" />'));
  assert(html.includes('<meta name="robots" content="index,follow,max-image-preview:large" />'));
  assert(html.includes("font-size: clamp(2.55rem, 3.4vw, 3.35rem)"));
  assert(html.includes('mailto:contact@zypact.com'));
  assert((html.match(/href="\/scan"/g) || []).length === 4);
  assert(html.includes("Synthetic example"));
  assert(html.includes("Answers may differ from what people see inside the consumer ChatGPT app"));
  assert(!html.includes("Review Preview</title>"));
  assert.equal((html.match(/<h1\b/g) || []).length, 1);
  console.log("PASS: homepage-only route, indexation, CTA, illustrative claims and metadata");
})().catch((e) => { console.error(e); process.exitCode = 1; });
