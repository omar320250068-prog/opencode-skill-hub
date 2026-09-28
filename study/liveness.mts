/**
 * Study harness: measures the incidence of ungrounded links in tool output.
 *
 * Arm A (ungated)  - what a tool author naturally writes: take repo-search hits and
 *                    synthesize a SKILL.md raw URL from owner/repo/default-branch.
 * Arm B (gated)    - what we ship: HEAD-probe every candidate before it is emitted.
 *
 * Outcome is defined at the only point that matters to a downstream agent:
 * does the emitted URL actually resolve when the agent tries to fetch it?
 */
import { Octokit } from "@octokit/rest";
import axios from "axios";

const QUERIES = [
  "astro skill", "nextjs app router skill", "prisma migrations skill", "tailwind design system skill",
  "playwright e2e skill", "python typing skill", "rust async skill", "docker hardening skill",
  "typescript strict skill", "testing best practices skill", "graphql schema skill", "auth security skill",
];
const TOP_K = 5;

const token = process.env.GITHUB_TOKEN;
const octokit = new Octokit({ auth: token, userAgent: "study/1.0" });
const hasToken = token !== undefined;

interface Row { query: string; repo: string; naive: string; naiveLive: boolean | null; gated: string | null; gatedLive: boolean | null; }

async function live(url: string): Promise<boolean | null> {
  try {
    const r = await axios.head(url, { timeout: 12_000, maxRedirects: 5, validateStatus: (s) => s >= 200 && s < 300 });
    return r.status >= 200 && r.status < 300;
  } catch (e: any) {
    if (e?.response) return false;
    return null; // network/timeout -> unknown, excluded from denominator
  }
}

const rows: Row[] = [];

for (const query of QUERIES) {
  let items: any[] = [];
  try {
    const res = await octokit.search.repos({ q: `${query} in:name,description,readme`, sort: "stars", order: "desc", per_page: TOP_K });
    items = res.data.items ?? [];
  } catch (e: any) {
    console.error(`  ! repo search failed for ${query}: ${e?.message ?? e}`);
    continue;
  }

  for (const it of items) {
    const owner = it.owner?.login ?? it.full_name.split("/")[0];
    const branch = it.default_branch ?? "main";
    const naive = `https://raw.githubusercontent.com/${owner}/${it.name}/${branch}/SKILL.md`;
    const naiveLive = await live(naive);

    // Arm B: probe before emitting. Nested layouts are out of scope for the probe
    // budget here, so gated == root SKILL.md only (conservative).
    const gatedLive = naiveLive;

    rows.push({ query, repo: it.full_name, naive, naiveLive, gated: naiveLive ? naive : null, gatedLive });
  }
  process.stderr.write(".");
}

const known = rows.filter((r) => r.naiveLive !== null);
const naiveLiveN = known.filter((r) => r.naiveLive === true).length;
const gatedEmitted = rows.filter((r) => r.gated !== null).length;

const byQuery: Record<string, { n: number; live: number }> = {};
for (const r of known) {
  byQuery[r.query] ??= { n: 0, live: 0 };
  byQuery[r.query].n++;
  if (r.naiveLive) byQuery[r.query].live++;
}

console.log("\n=== RESULT ===");
console.log(`queries: ${QUERIES.length}, top_k=${TOP_K}`);
console.log(`candidate repos examined: ${rows.length} (${known.length} with a determinate HTTP outcome)`);
console.log(`ARM A (ungated) : emitted ${rows.length} URLs, live ${naiveLiveN} -> liveness ${((naiveLiveN / known.length) * 100).toFixed(1)}%`);
console.log(`ARM B (gated)   : emitted ${gatedEmitted} URLs, all live by construction -> liveness 100%`);
console.log(`dead-link rate avoided by gating: ${(known.length - naiveLiveN)} of ${known.length} candidates (${(((known.length - naiveLiveN) / known.length) * 100).toFixed(1)}%) suppressed`);
console.log(`token present: ${hasToken}`);
console.log("\nper-query (ungated liveness):");
for (const [q, v] of Object.entries(byQuery)) console.log(`  ${q.padEnd(34)} ${v.live}/${v.n}`);
console.log("\nJSON:" + JSON.stringify({
  authenticated: hasToken, queries: QUERIES.length, topK: TOP_K,
  candidates: rows.length, determinate: known.length,
  armA_emitted: rows.length, armA_live: naiveLiveN,
  armA_liveness: known.length ? naiveLiveN / known.length : null,
  armB_emitted: gatedEmitted,
  perQuery: byQuery,
}));
