/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  /**
   * Build output directory.
   *
   * `next build` deletes and rewrites this directory. When it is the same
   * `.next` a running `next dev` is serving from, the dev server loses
   * routes-manifest.json mid-request and answers 500 until it is restarted —
   * a failure that looks random because nothing in the dev terminal caused it.
   *
   * Reading it from the environment lets a verification build write elsewhere
   * (`npm run build:verify`), so a build can never knock over a dev server.
   * Deployments set nothing and get `.next` exactly as before.
   */
  distDir: process.env.NEXT_DIST_DIR || ".next",
  experimental: {
    serverActions: {
      bodySizeLimit: "2mb",
    },
  },
};

/**
 * Marketing-only homepage switch. beforeFiles is required because app/page.tsx
 * still exists. Only the public homepage is rewritten; the demo request,
 * private app, API, auth, report, workers and DB are untouched.
 * Rollback: remove this rewrites override and deploy the previous build.
 */
nextConfig.rewrites = async () => ({
  beforeFiles: [{ source: "/", destination: "/reflex-v3-production.html" }],
  afterFiles: [],
  fallback: [],
});

/** Prevent the static asset URL from competing with the canonical homepage. */
nextConfig.headers = async () => [
  {
    source: "/reflex-v3-production.html",
    headers: [{ key: "X-Robots-Tag", value: "noindex, nofollow" }],
  },
];

module.exports = nextConfig;
