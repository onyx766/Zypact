/**
 * Pipeline-step logger.
 *
 * Right now this just writes structured entries to the console so we can
 * follow the pipeline during Sprint 1. Later sprints will persist these to
 * Supabase for observability across the 7-agent chain — the signature is
 * shaped for that future.
 *
 * Do not add cross-cutting concerns here (metrics, tracing, alerts). Keep it
 * boring until we actually need more.
 */

export type PipelineStepStatus = "started" | "succeeded" | "failed" | "skipped";

export interface PipelineStep {
  projectId: string;
  agent:
    | "crawler"
    | "site-reader"
    | "prompt-mirror"
    | "ai-probe"
    | "probe-analysis"
    | "competitor-discovery"
    | "gap-map"
    | "evidence-bank"
    | "gap-analyzer"
    | "fix-agent"
    | "fix-brief"
    | "generate-asset"
    | "asset-generator"
    | "qa"
    | "qa-agent";
  status: PipelineStepStatus;
  durationMs?: number;
  message?: string;
  meta?: Record<string, unknown>;
}

export async function savePipelineStep(step: PipelineStep): Promise<void> {
  const line = {
    ts: new Date().toISOString(),
    ...step,
  };
  // In dev/tests, structured JSON to stdout is enough.
  // eslint-disable-next-line no-console
  console.log(`[zypact:pipeline] ${JSON.stringify(line)}`);
}

/** Convenience wrapper for the common start/end pattern. */
export async function withPipelineStep<T>(
  base: Omit<PipelineStep, "status" | "durationMs" | "message">,
  fn: () => Promise<T>
): Promise<T> {
  const startedAt = Date.now();
  await savePipelineStep({ ...base, status: "started" });
  try {
    const result = await fn();
    await savePipelineStep({
      ...base,
      status: "succeeded",
      durationMs: Date.now() - startedAt,
    });
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await savePipelineStep({
      ...base,
      status: "failed",
      durationMs: Date.now() - startedAt,
      message,
    });
    throw err;
  }
}
