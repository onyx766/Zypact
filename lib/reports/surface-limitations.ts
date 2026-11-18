/**
 * Fixed client-facing limitation sentences shared by every report builder, so
 * the wording required by METHODOLOGY (section 4 "Required limitation" and the
 * section 7 "Dependence warning") exists once and cannot drift per builder.
 */

/** METHODOLOGY section 4. Verbatim; required on every client artifact that includes Perplexity Sonar. */
export const PERPLEXITY_SURFACE_LIMITATION =
  "This is a directional measurement of Perplexity Sonar under the recorded conditions. It does not represent what every buyer sees across ChatGPT, Gemini, Copilot, Claude, or all AI systems.";

/**
 * D-056 — the ChatGPT engine's required limitation, verbatim from
 * docs/ADAPTER_VALIDITY_CHATGPT.md ("Required limitation"): it measures
 * controlled OpenAI API responses, not observations of ChatGPT.com.
 */
export const CHATGPT_SURFACE_LIMITATION =
  "This is a directional measurement of controlled OpenAI API responses with web search (shown as \"ChatGPT\") under the recorded conditions. It is not what users of the ChatGPT app see, and it does not represent every AI system.";

/** Used only when the provider is neither Perplexity nor ChatGPT, where the verbatim sentences would be false. */
export const GENERIC_SURFACE_LIMITATION =
  "This is a directional measurement of one AI surface under the recorded conditions. It does not represent what every buyer sees across other AI systems.";

/** METHODOLOGY section 7. Intervals assume independent runs; that is not guaranteed. */
export const DEPENDENCE_LIMITATION =
  "Independence is not guaranteed: repeated runs of the same question on the same model may be correlated, so the stated intervals can overstate certainty. Read them as approximate.";

export function surfaceLimitation(provider: string): string {
  if (provider === "openai_chatgpt") return CHATGPT_SURFACE_LIMITATION;
  return /perplexity/i.test(provider)
    ? PERPLEXITY_SURFACE_LIMITATION
    : GENERIC_SURFACE_LIMITATION;
}
