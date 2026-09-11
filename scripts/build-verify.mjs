#!/usr/bin/env node
/**
 * Production build that cannot disturb a running dev server.
 *
 * `next build` wipes its output directory first. Pointing it at
 * `.next-verify` keeps it away from the `.next` a `next dev` process is
 * serving from, which is what turned a routine verification build into a dev
 * server answering 500 for every request.
 *
 * Use this for local verification. Deployments keep running `npm run build`,
 * which still writes `.next`.
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);

const nextBin = path.join(
  repo,
  "node_modules",
  "next",
  "dist",
  "bin",
  "next"
);

const distDir = process.env.NEXT_DIST_DIR || ".next-verify";

console.log(`[build:verify] building into ${distDir}/`);

const child = spawn(
  process.execPath,
  [nextBin, "build", ...process.argv.slice(2)],
  {
    cwd: repo,
    stdio: "inherit",
    env: {
      ...process.env,
      NEXT_DIST_DIR: distDir,
      NEXT_TELEMETRY_DISABLED: "1",
    },
  }
);

child.on("exit", (code, signal) => {
  process.exit(signal ? 1 : (code ?? 1));
});
