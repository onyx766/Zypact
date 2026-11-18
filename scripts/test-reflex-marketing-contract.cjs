#!/usr/bin/env node
/**
 * Read-only contract: Reflex typography and /scan restyling must never change
 * the real public request, verification, approval or execution workflow.
 * Run: node scripts/test-reflex-marketing-contract.cjs
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(root,p),"utf8");
const home = read("public/reflex-v3-production.html");
const page = read("app/scan/page.tsx");
const form = read("app/scan/scan-form.tsx");
const post = read("lib/snapshot-requests/public-form.ts");
const layout = read("app/layout.tsx");
const nav = read("components/marketing/site-header.tsx");
const css = read("components/landing/styles/reflex-scan.css");

assert(home.includes("Reflex V3 refined type hierarchy"));
assert.equal((home.match(/href="\/scan"/g)||[]).length,4);
assert.equal((home.match(/<h1\b/g)||[]).length,1);
assert(home.includes("Synthetic example"));
assert(home.includes('rel="canonical" href="https://www.zypact.com/"'));
assert(page.includes('<ThemeRoot theme="light" className="lx scan-reflex">'));
assert(page.includes("<ScanForm enabled={enabled} />"));
assert(page.includes('process.env.SNAPSHOT_PUBLIC_FORM_ENABLED === "true"'));
assert(page.includes("Submitting this form does not start an AI call"));
assert(page.includes("V1 surface: Perplexity Sonar only"));
for(const anchor of ["product","how-it-works","use-cases","methodology","beta"]){
 assert(page.includes('href: "/#'+anchor+'"'),"missing live homepage anchor "+anchor);
 assert(home.includes('id="'+anchor+'"'),"missing homepage anchor "+anchor);
}
assert(page.includes("mailto:contact@zypact.com"));
assert(nav.includes("links = navLinks")); // all other pages retain the original nav
assert(nav.includes('{ label: "Request demo", href: "/scan" }'));
assert(css.includes(".lx.scan-reflex")); // no unscoped production/global CSS
assert(layout.includes('import "@/components/landing/styles/reflex-scan.css";'));
assert(form.includes("submitSnapshotRequest(values)"));
assert(form.includes("if (!enabled || submitting)"));
assert(post.includes('"/api/snapshot-requests"'));
assert(post.includes('status: "pending_verification"'));
assert(post.includes('nextStep: "check_email"'));
assert(!page.includes('import "./scan-form.css"'));
console.log("PASS: marketing typography / scan design, all five links, original gated form and request API");
