#!/usr/bin/env tsx
/** Sprint 14B.3 smoke tests for the short sales renderer. */

import { buildSalesReportFromMvpMarkdown } from "@/lib/export/build-sales-report";

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

const vugioFixture = `# Zypact MVP — Client Report

> Read-only snapshot of the AI-visibility scan for **Vugio** (\`vugio.com\`). Generated 2026-07-10T17:45:44.401Z.

## 1. Executive Summary

- **Brand**: Vugio
- **Domain**: \`vugio.com\`
- **Category (Mirror Profile)**: E-commerce platform for creative professionals
- **AI probe result (live Perplexity unbranded product-recommendation scorecard, 2 prompts / 4 runs)**: 0 won · 0 partial · 2 lost · recommendedAsProduct 0% · citedAsSource 0%
- **Branded probes tracked separately**: 1 prompt / 2 runs
- **Branded reputation**: at risk (2/2 branded runs negative)
- **Top competitors AI recommended instead**: B&H Photo, KEH Camera, MPB
- **Next recommended fix**: Create a comparison page that highlights Vugio as a viable alternative for purchasing studio equipment, alongside competitors like B&H Photo and KEH Camera. _(fixType \`comparison_page\`, status \`needs_evidence\`)_

## 3. Evidence Needed to Unlock Publish-Ready Assets

- specific product offerings and pricing details from Vugio that can be compared to competitors

## 6. Prompt Mirror summary

- **total prompts**: 50
- **selected for probe**: 20

## 7. Probe Results

### Probe Set

- **scorecard prompt groups**: 2
- **scorecard runs**: 4

### Prompt-level aggregation

| prompt | scorecard status | runs | recommendedAsProduct | citedAsSource | negativeMentions | product verdict |
|---|---|---|---|---|---|---|
| Compare Vugio vs Adorama for purchasing studio products. | tracked_separately (branded) | 2 | 0% | 0% | 100% | lost |
| Alternatives to Adorama for studio equipment? | included | 2 | 0% | 0% | 0% | lost |
| What are the best tools for enhancing online sales for creative professionals? | included | 2 | 0% | 0% | 0% | lost |

### Live Perplexity Sonar probe · product verdict: **lost**

- **scorecard status**: tracked_separately (branded)
- **prompt**: Compare Vugio vs Adorama for purchasing studio products.
- **platform**: \`perplexity\`
- **probe origin**: live_perplexity (live Perplexity API response)
- **recommendedAsProduct**: no
- **productPosition**: negative
- **negativeMention**: yes — brand was mentioned with caveats or as inferior, so it does not count as a product recommendation.
- **citedAsSource**: no
- **answerSummary**: The AI response indicates that Vugio is likely non-existent or misnamed and does not have a credible reputation as a retailer for studio products. In contrast, Adorama is recommended as a top choice due to its established reputation, extensive offerings, and customer service protections.
- **whyClientLost**: Vugio was mentioned negatively, indicating it lacks credibility as a retailer compared to Adorama.

### Live Perplexity Sonar probe · product verdict: **lost**

- **scorecard status**: included
- **prompt**: Alternatives to Adorama for studio equipment?
- **platform**: \`perplexity\`
- **recommendedAsProduct**: no
- **productPosition**: absent
- **citedAsSource**: no
- **competitors mentioned (in the live Perplexity answer)**:

  | position | name | context |
  |---|---|---|
  | 1 | B&H Photo | recommended alternative |
  | 2 | KEH Camera | recommended alternative |
  | 3 | MPB | recommended alternative |

## 8. What this means

### Which prompts Vugio lost or under-performed
**Lost prompts** (brand was not recommended as a product/tool):
- Alternatives to Adorama for studio equipment? (2 runs, recommendedAsProduct 0%, citedAsSource 0%)

### Branded reputation check
2/2 branded runs mentioned Vugio negatively. This is a reputation risk, not just a visibility gap.

### Which competitors appeared instead
| competitor | mentions across main probes |
|---|---|
| B&H Photo | 2 |
| KEH Camera | 2 |
| MPB | 2 |
| Shopify | 2 |
| Canva | 2 |

## 13. Fix Brief

- **lostPrompt**: Alternatives to Adorama for studio equipment?
- **competitorRecommended**: B&H Photo, KEH Camera, Roberts Camera, MPB, SRS Microsystems
- **fixType**: \`comparison_page\`

#### Root cause
The AI did not recommend Vugio because it was not mentioned in the context of alternatives for studio equipment.

#### Recommended fix
Create a comparison page that highlights Vugio as a viable alternative for purchasing studio equipment, alongside competitors like B&H Photo and KEH Camera.

#### Evidence needed
- specific product offerings and pricing details from Vugio that can be compared to competitors
`;

const vugioReport = buildSalesReportFromMvpMarkdown(vugioFixture, {
  now: new Date("2026-07-10T00:00:00.000Z"),
  focusCompetitors: ["B&H Photo", "KEH Camera", "MPB"],
});
const vugioBody = vugioReport.markdown;

assert(vugioBody.includes("Zypact Short Report — Vugio"), "renders brand title");
assert(vugioBody.includes("0% recommended as a product across 2 buyer prompts and 4 live AI runs"), "renders visibility headline with basis");
assert(vugioBody.includes("Trend vs previous scan:** — (first scan)"), "reserves trend placeholder");
assert(vugioBody.includes("at risk (2/2 branded runs negative)"), "renders branded reputation state with counts");
assert(vugioBody.includes("A buyer asked:"), "renders branded evidence prompt");
assert(vugioBody.includes("The AI response was summarized as:"), "does not present an answer summary as a raw quote");
assert(vugioBody.includes("likely non-existent or misnamed"), "renders the visceral branded reputation evidence");
assert(vugioBody.includes("1 of 2 unbranded buyer prompts is shown below"), "explains focused prompt filtering");
assert(vugioBody.includes("This snapshot covered 2 of the 20 highest-value buyer prompts identified for Vugio"), "renders scope CTA");
assert(vugioBody.includes("generate the publish-ready page draft, verified against that evidence"), "renders concierge next step");
assert(vugioBody.includes("from a live scan performed on 2026-07-10"), "uses client-safe integrity source wording");
assert(vugioBody.includes("B&H Photo"), "keeps in-frame competitor B&H Photo");
assert(vugioBody.includes("KEH Camera"), "keeps in-frame competitor KEH Camera");
assert(vugioBody.includes("MPB"), "keeps in-frame competitor MPB");
assert(!vugioBody.includes("projectId"), "does not expose internal project id wording");
assert(!vugioBody.includes("rawProbeRequest"), "does not expose raw probe request internals");
assert(!/legacy\s+/i.test(vugioBody), "does not expose legacy probe wording");
assert(!vugioBody.includes("existing MVP scan export"), "does not expose old internal source wording");
assert(!vugioBody.includes("Shopify (2)") && !vugioBody.includes("Canva (2)"), "does not foreground out-of-frame competitors in the main competitor column");
assert(vugioBody.includes("small snapshot, not a market-wide benchmark"), "keeps sample-size caveat");
assert(vugioBody.includes("**Competitors AI recommended across the tested prompts:**"), "Vugio losing case keeps the “instead” competitor label");
assert(!vugioBody.includes("**Other tools AI recommended across the tested prompts:**"), "Vugio losing case does not use the neutral winning label");

const linearFixture = `# Zypact MVP — Client Report

## 1. Executive Summary

- **Brand**: Linear
- **Domain**: \`linear.app\`
- **Category (Mirror Profile)**: Project management software for product and engineering teams
- **AI probe result (live Perplexity unbranded product-recommendation scorecard, 3 prompts / 8 runs)**: 2 won · 1 partial · 0 lost · recommendedAsProduct 88% · citedAsSource 50%
- **Branded probes tracked separately**: 1 prompt / 2 runs
- **Branded reputation**: positive (2/2 branded runs positive)
- **Top competitors AI recommended instead**: Jira, Asana, ClickUp
- **Next recommended fix**: Add a consolidation page that reinforces Linear's fit for product and engineering teams.

## 3. Evidence Needed to Unlock Publish-Ready Assets

- current pricing and plan details from Linear

## 6. Prompt Mirror summary

- **total prompts**: 50
- **selected for probe**: 20

## 7. Probe Results

### Probe Set

- **scorecard prompt groups**: 3
- **scorecard runs**: 8

### Prompt-level aggregation

| prompt | scorecard status | runs | recommendedAsProduct | citedAsSource | negativeMentions | product verdict |
|---|---|---|---|---|---|---|
| Best project management tools for product teams? | included | 3 | 100% | 67% | 0% | won |
| Best issue tracking tools for engineering teams? | included | 3 | 100% | 67% | 0% | won |
| Alternatives to Jira for product teams? | included | 2 | 50% | 0% | 0% | partial |
| Compare Linear vs Jira for engineering teams. | tracked_separately (branded) | 2 | 100% | 50% | 0% | won |

### Live Perplexity Sonar probe · product verdict: **partial**

- **scorecard status**: included
- **prompt**: Alternatives to Jira for product teams?
- **platform**: \`perplexity\`
- **recommendedAsProduct**: yes
- **productPosition**: secondary
- **citedAsSource**: no
- **competitors mentioned (in the live Perplexity answer)**:

  | position | name | context |
  |---|---|---|
  | 1 | Jira | primary incumbent |
  | 2 | Asana | alternative |
  | 3 | ClickUp | alternative |

## 8. What this means

### Which prompts Linear lost or under-performed
**Lost prompts** (brand was not recommended as a product/tool):
- Alternatives to Jira for product teams? (2 runs, recommendedAsProduct 50%, citedAsSource 0%)

### Which competitors appeared instead
| competitor | mentions across main probes |
|---|---|
| Jira | 3 |
| Asana | 1 |
| ClickUp | 1 |

## 13. Fix Brief

- **lostPrompt**: Alternatives to Jira for product teams?
- **competitorRecommended**: Jira, Asana, ClickUp
- **fixType**: \`comparison_page\`

#### Recommended fix
Add a comparison page that consolidates Linear's existing strengths against Jira for product and engineering teams.

#### Evidence needed
- current pricing and plan details from Linear
`;

const linearReport = buildSalesReportFromMvpMarkdown(linearFixture, {
  now: new Date("2026-07-10T00:00:00.000Z"),
});
const linearBody = linearReport.markdown;

assert(linearBody.includes("Zypact Short Report — Linear"), "renders Linear title");
assert(linearBody.includes("88% recommended as a product across 3 buyer prompts and 8 live AI runs"), "renders winning visibility headline");
assert(linearBody.includes("positive (2/2 branded runs positive)"), "renders positive branded reputation");
assert(linearBody.includes("was recommended in most of the unbranded buying prompts tested"), "positive case uses consolidation language");
assert(linearBody.includes("not basic recovery from invisibility"), "positive case does not pretend the brand is invisible");
assert(linearBody.includes("clearest consolidation opportunity"), "positive case labels the frame as a consolidation opportunity");
assert(linearBody.includes("AI still surfaced"), "positive case says competitors are still visible, not recommended instead");
assert(linearBody.includes("Strengthen comparison / proof content"), "positive case uses a consolidation fix heading");
assert(!linearBody.includes("Linear did not appear as a recommended product"), "does not falsely say a winning brand did not appear");
assert(!linearBody.includes("reputation-risk signal"), "does not falsely call positive branded reputation a risk");
assert(!linearBody.includes("clearest buying-frame loss"), "does not call a winning/partial frame a loss");
assert(!linearBody.includes("likely non-existent"), "does not fabricate a pain quote for a winning brand");
assert(!linearBody.includes("Direct evidence from the branded check"), "does not render negative evidence block when there is no negative branded probe");
assert(linearBody.includes("Add a comparison page that consolidates Linear's existing strengths"), "renders consolidation fix without fabricating pain");
assert(linearBody.includes("**Other tools AI recommended across the tested prompts:**"), "Linear winning case uses the neutral competitor label");
assert(!linearBody.includes("**Competitors AI recommended across the tested prompts:**"), "Linear winning case does not use the losing competitor label");


const noFrameFixture = `# Zypact MVP — Client Report

## 1. Executive Summary

- **Brand**: Acme
- **Domain**: \`acme.example\`
- **Category (Mirror Profile)**: AI visibility software
- **AI probe result (live Perplexity unbranded product-recommendation scorecard, 1 prompt / 3 runs)**: 0 won · 0 partial · 1 lost · recommendedAsProduct 0% · citedAsSource 0%
- **Branded reputation**: positive (0/1 branded runs negative)
- **Top competitors AI recommended instead**: Peec AI, Otterly AI
- **Next recommended fix**: Create a comparison page against Peec AI.

## 3. Evidence Needed to Unlock Publish-Ready Assets

- documented methodology and concrete product evidence

## 6. Prompt Mirror summary

- **selected for probe**: 10

## 7. Probe Results

### Probe Set

- **scorecard prompt groups**: 1
- **scorecard runs**: 3

### Prompt-level aggregation

| prompt | scorecard status | runs | recommendedAsProduct | citedAsSource | negativeMentions | product verdict |
|---|---|---|---|---|---|---|
| How to improve my company's visibility in AI recommendations? | included | 3 | 0% | 0% | 0% | lost |

### Live Perplexity Sonar probe · product verdict: **lost**

- **scorecard status**: included
- **prompt**: How to improve my company's visibility in AI recommendations?
- **platform**: \`perplexity\`
- **recommendedAsProduct**: no
- **productPosition**: absent
- **citedAsSource**: no
- **answerSummary**: The answer focused on general strategies and did not recommend any specific products.
- **whyClientLost**: Acme was not mentioned.

## 8. What this means

### Which prompts Acme lost or under-performed
- How to improve my company's visibility in AI recommendations? (3 runs, recommendedAsProduct 0%, citedAsSource 0%)

### Branded reputation check
0/1 branded runs mentioned Acme negatively.

### Which competitors appeared instead
| competitor | mentions across main probes |
|---|---|
| Peec AI | 3 |
| Otterly AI | 2 |

## 13. Fix Brief

- **lostPrompt**: How to improve my company's visibility in AI recommendations?
- **competitorRecommended**: Peec AI, Otterly AI
- **fixType**: \`comparison_page\`

#### Recommended fix
Create a comparison page against Peec AI.

#### Evidence needed
- documented methodology and concrete product evidence
`;

const noFrameReport =
  buildSalesReportFromMvpMarkdown(
    noFrameFixture,
    {
      now: new Date(
        "2026-07-17T00:00:00.000Z"
      ),
    }
  );

const noFrameBody =
  noFrameReport.markdown;

assert(
  noFrameBody.includes(
    "No specific products were recommended in these runs"
  ),
  "prompt table does not leak competitors from other prompts"
);

assert(
  noFrameBody.includes(
    "no specific competing product was recommended in the stored runs"
  ),
  "frame sentence reports the absence of prompt-level competitors"
);

assert(
  !noFrameBody.includes(
    "In that frame, AI recommended Peec AI"
  ),
  "does not attribute global competitors to the focus prompt"
);

assert(
  noFrameBody.includes(
    "Publish an answer-first, evidence-backed page"
  ),
  "uses an answer-first fix when the prompt had no competitor recommendations"
);

assert(
  noFrameBody.includes(
    "without framing the page as a competitor comparison"
  ),
  "does not preserve an unsupported comparison recommendation"
);

assert(
  noFrameBody.includes(
    "**Competitors AI recommended across the tested prompts:**"
  ),
  "keeps global competitors clearly labeled as cross-prompt evidence"
);

console.log("Sprint 14B.3 sales report tests passed.");
