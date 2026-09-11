#!/usr/bin/env node
/**
 * Supervisor for `next dev`.
 *
 * Restarts the dev server when it exits for any reason, and when it is still
 * running but has stopped accepting connections. Ctrl+C stops it for good.
 *
 * This is a safety net, not a cure. A dev server that dies repeatedly is
 * telling you something — the restart reason is printed every time, so the
 * pattern stays visible instead of being hidden by the restart.
 *
 * Arguments are passed through: `npm run dev:forever -- -p 3001`.
 */

import { spawn } from "node:child_process";
import net from "node:net";
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

const args = process.argv.slice(2);

/** Port to watch. Only used for health checks, never to choose the port. */
function resolvePort() {
  const flag = args.findIndex((value) => value === "-p" || value === "--port");
  if (flag !== -1 && args[flag + 1]) {
    const parsed = Number.parseInt(args[flag + 1], 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  const fromEnv = Number.parseInt(process.env.PORT ?? "", 10);
  return Number.isFinite(fromEnv) ? fromEnv : 3000;
}

const port = resolvePort();

const HEALTH_INTERVAL_MS = 15_000;
/** Compiling a cold start takes a while; do not judge the server before this. */
const START_GRACE_MS = 60_000;
const FAILURES_BEFORE_RESTART = 4;
const MIN_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 15_000;
/** Uptime that proves the last start was fine, so backoff resets. */
const HEALTHY_UPTIME_MS = 60_000;

let child = null;
let stopping = false;
let backoff = MIN_BACKOFF_MS;
let startedAt = 0;
let failures = 0;
/**
 * Set once the port has answered. Until then a failing check means the port
 * is simply not the one Next chose (it auto-increments when a port is taken),
 * and restarting on that would loop forever.
 */
let everHealthy = false;

function log(message) {
  console.log(`[dev-forever] ${message}`);
}

function isListening() {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const finish = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(3_000);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

function start() {
  startedAt = Date.now();
  failures = 0;

  const spawned = spawn(process.execPath, [nextBin, "dev", ...args], {
    cwd: repo,
    stdio: "inherit",
    env: process.env,
  });

  child = spawned;

  spawned.on("exit", (code, signal) => {
    if (stopping || child !== spawned) return;

    child = null;

    if (Date.now() - startedAt > HEALTHY_UPTIME_MS) {
      backoff = MIN_BACKOFF_MS;
    }

    const delay = backoff;
    backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);

    log(
      `dev server exited (code ${code ?? "none"}, signal ${
        signal ?? "none"
      }). Restarting in ${Math.round(delay / 1000)}s.`
    );

    setTimeout(start, delay);
  });
}

async function checkHealth() {
  if (stopping || child === null) return;
  if (Date.now() - startedAt < START_GRACE_MS) return;

  const ok = await isListening();

  if (ok) {
    everHealthy = true;
    failures = 0;
    return;
  }

  if (!everHealthy) return;

  failures += 1;
  log(
    `port ${port} is not accepting connections (${failures}/${FAILURES_BEFORE_RESTART}).`
  );

  if (failures < FAILURES_BEFORE_RESTART) return;

  failures = 0;
  const stalled = child;
  log("dev server is not responding — restarting it.");
  stalled.kill("SIGTERM");

  // A process that ignores SIGTERM would otherwise hold the port and block
  // the replacement from ever starting.
  setTimeout(() => {
    if (!stalled.killed) stalled.kill("SIGKILL");
  }, 5_000);
}

const healthTimer = setInterval(() => {
  void checkHealth();
}, HEALTH_INTERVAL_MS);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    stopping = true;
    clearInterval(healthTimer);
    log("stopping.");
    if (child) child.kill(signal);
    process.exit(0);
  });
}

log(`starting next dev (watching port ${port}). Ctrl+C to stop.`);
start();
