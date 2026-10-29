/**
 * Provider endpoints, and nothing else.
 *
 * Kept apart from the probe adapters so code that only needs to NAME an
 * endpoint — the measurement fingerprint, read by the Outcome Card's web
 * routes — never imports a module that can make a paid call
 * (scripts/test-paid-execution-guards.ts pins that boundary).
 */

/** The Sonar adapter's endpoint. Every version of lib/probes/perplexity.ts has used it. */
export const PERPLEXITY_SONAR_ENDPOINT = "https://api.perplexity.ai/v1/sonar";

/**
 * The Agent API endpoint (POST /v1/agent), per Perplexity's migration guide
 * and API reference. Used only by lib/probes/perplexity-agent.ts.
 */
export const PERPLEXITY_AGENT_ENDPOINT = "https://api.perplexity.ai/v1/agent";
