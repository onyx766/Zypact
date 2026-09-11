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

module.exports = nextConfig;
