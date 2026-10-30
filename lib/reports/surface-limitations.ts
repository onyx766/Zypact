/**
 * Fixed client-facing limitation sentences shared by every report builder, so
 * the wording required by METHODOLOGY (section 4 "Required limitation" and the
 * section 7 "Dependence warning") exists once and cannot drift per builder.
 */

/** METHODOLOGY section 4. Verbatim; required on every Perplexity-only client artifact. */
export const PERPLEXITY_SURFACE_LIMITATION =
  "This is a directional measurement of Perplexity Sonar under the recorded conditions. It does not represent what every buyer sees across ChatGPT, Gemini, Copilot, Claude, or all AI systems.";

/** Used only when the provider is not Perplexity, where the verbatim sentence would be false. */
export const GENERIC_SURFACE_LIMITATION =
  "This is a directional measurement of one AI surface under the recorded conditions. It does not represent what every buyer sees across other AI systems.";

/** METHODOLOGY section 7. Intervals assume independent runs; that is not guaranteed. */
export const DEPENDENCE_LIMITATION =
  "Independence is not guaranteed: repeated runs of the same question on the same model may be correlated, so the stated intervals can overstate certainty. Read them as approximate.";

export function surfaceLimitation(provider: string): string {
  return /perplexity/i.test(provider)
    ? PERPLEXITY_SURFACE_LIMITATION
    : GENERIC_SURFACE_LIMITATION;
}
