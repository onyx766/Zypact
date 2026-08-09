import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

function read(path: string): string {
  return readFileSync(path, "utf8");
}

let failed = false;

function check(label: string, condition: boolean) {
  if (condition) {
    console.log(`ok   ${label}`);
    return;
  }

  failed = true;
  console.error(`FAIL ${label}`);
}

const css = read("app/globals.css");
const projectLayout = read("app/projects/[id]/layout.tsx");
const newProject = read("app/projects/new/page.tsx");
const founderList = read("app/admin/snapshot-requests/page.tsx");
const founderDetail = read("app/admin/snapshot-requests/[requestId]/page.tsx");
const report = read("app/report/[secureToken]/page.tsx");
const login = read("app/login/page.tsx");
const thankYou = read("app/thank-you/page.tsx");
const scanForm = read("app/scan/scan-form.tsx");
const pricing = read("lib/pricing/plans.ts");

console.log("test-product-ui-system");

check("product UI system CSS exists", css.includes("Zypact Product UI System"));
check("dark product background is canonical", css.includes("--product-bg: #09090d"));
check("product teal is canonical", css.includes("--product-teal: #00ddb4"));
check("product orange is canonical", css.includes("--product-orange: #ff8a3d"));
check("workspace uses Inter", css.includes('font-family: "Inter"'));
check("data UI uses JetBrains Mono", css.includes('"JetBrains Mono"'));
check("workspace shell is scoped", css.includes(".product-page"));
check("founder operations shell is scoped", css.includes(".founder-page"));
check("client report shell is scoped", css.includes(".report-page"));
check("reduced motion remains supported", css.includes("@media (prefers-reduced-motion: reduce)"));

check(
  "project ownership gate remains in layout",
  projectLayout.includes("await requireProjectOwnerForPage(params.id")
);
check("workspace chrome renders", projectLayout.includes('className="product-topbar"'));
check("workspace sidebar renders", projectLayout.includes('className="product-sidebar"'));

const workspaceRoutes = [
  "/mirror",
  "/prompts",
  "/probe",
  "/lost-prompts",
  "/competitors",
  "/gap-map",
  "/evidence-bank",
  "/fix-briefs",
  "/assets",
  "/qa",
];

for (const route of workspaceRoutes) {
  check(`workspace navigation keeps ${route}`, projectLayout.includes(route));
}

check("new project stays auth-gated", newProject.includes("const user = await getCurrentUser()"));
check("new project uses product shell", newProject.includes('className="product-page product-new-page"'));

check(
  "founder list remains founder-gated",
  founderList.includes("await requireFounderForPage(")
);
check(
  "founder detail remains founder-gated",
  founderDetail.includes("await requireFounderForPage(")
);
check("founder list uses new visual shell", founderList.includes('className="founder-page founder-requests-page"'));
check("founder detail uses new visual shell", founderDetail.includes('className="founder-page founder-request-detail"'));

check("public report remains token-gated", report.includes("isValidPublicReportToken("));
check("public report still loads persisted artifact", report.includes("getSnapshotReportArtifactByPublicToken("));
check("report outcome gets semantic visual class", report.includes("report-outcome-${row.outcome"));
check("lost report state has orange styling", css.includes(".report-outcome-lost"));
check("won report state has teal styling", css.includes(".report-outcome-won"));
check("priority fix keeps teal treatment", css.includes(".report-fix"));

check("founder login uses product visual shell", login.includes('className="founder-login-page"'));
check("thank-you uses product visual shell", thankYou.includes("thankyou-page"));

check("scan still uses dark Turnstile", scanForm.includes('theme: "dark"'));
check("scan journey dark palette remains", css.includes("Dark intelligence snapshot journey"));
check("landing dark intelligence system remains", css.includes("Dark intelligence landing"));

check(
  "saved-project entitlements remain 0/3/5",
  pricing.includes("projects: 0") &&
    pricing.includes("projects: 3") &&
    pricing.includes("projects: 5")
);
check(
  "Growth and Pro pricing source remains 99/199",
  pricing.includes("priceMonthlyUsd: 99") &&
    pricing.includes("priceMonthlyUsd: 199")
);

let changed: string[] = [];
try {
  changed = execFileSync("git", ["diff", "--name-only"], {
    encoding: "utf8",
  })
    .trim()
    .split("\n")
    .filter(Boolean);
} catch {
  changed = [];
}

const forbiddenPrefixes = [
  "app/api/",
  "lib/",
  "supabase/",
  "middleware.ts",
  "scripts/snapshot-worker.ts",
];

for (const prefix of forbiddenPrefixes) {
  check(
    `no working-tree product UI change under ${prefix}`,
    !changed.some((path) => path === prefix || path.startsWith(prefix))
  );
}

if (failed) {
  console.error("\nPRODUCT UI TEST FAILED");
  process.exit(1);
}

console.log("\nALL PASS");
