/**
 * Sprint 13C — AI platforms are not product competitors.
 *
 * These names are monitored engines / answer surfaces. They can appear in raw
 * AI answers, but they must not be stored as competitors or drive Gap Map
 * distance. Keep the list deterministic and conservative.
 */
export const AI_PLATFORM_NAMES = [
  "ChatGPT",
  "OpenAI",
  "GPT-4",
  "GPT-5",
  "Perplexity",
  "Perplexity AI",
  "Claude",
  "Anthropic",
  "Gemini",
  "Google AI Overviews",
  "AI Overviews",
  "Google SGE",
  "Google Search Generative Experience",
  "Bing Copilot",
  "Microsoft Copilot",
  "Copilot",
  "Meta AI",
  "Grok",
  "Mistral",
] as const;

export function normalizeEntityKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\b(ai|llm|gpt)\b/g, "")
    .replace(/\.(com|io|ai|co|net|org)\b/g, "")
    .replace(/[^a-z0-9]+/g, "");
}

const PLATFORM_KEYS = new Set(AI_PLATFORM_NAMES.map(normalizeEntityKey));

export function isAiPlatformName(name: string): boolean {
  const key = normalizeEntityKey(name);
  if (!key) return false;
  if (PLATFORM_KEYS.has(key)) return true;
  return /^(chatgpt|openai|perplexity|claude|anthropic|gemini|googleaioverviews|aioverviews|copilot|grok|mistral|meta)$/.test(key);
}

export function splitPlatformsFromCompetitors<T extends { name?: unknown }>(
  items: T[],
): { competitors: T[]; platforms: T[] } {
  const competitors: T[] = [];
  const platforms: T[] = [];
  for (const item of items) {
    const name = typeof item.name === "string" ? item.name : "";
    if (isAiPlatformName(name)) platforms.push(item);
    else competitors.push(item);
  }
  return { competitors, platforms };
}
