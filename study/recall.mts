/**
 * Counterweight to the liveness study: does gating destroy utility?
 * Measures the *authenticated* path — code search (which yields real paths) plus the
 * gated repo-search fallback — and reports how many installable artifacts an agent
 * actually ends up with per query.
 */
import { Octokit } from "@octokit/rest";
import axios from "axios";

const QUERIES = [
  "astro skill", "nextjs app router skill", "prisma migrations skill", "tailwind design system skill",
  "playwright e2e skill", "python typing skill", "rust async skill", "docker hardening skill",
  "typescript strict skill", "testing best practices skill", "graphql schema skill", "auth security skill",
];
const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN, userAgent: "study/1.0" });

async function live(u: string): Promise<boolean | null> {
  try {
    const r = await axios.head(u, { timeout: 12_000, maxRedirects: 5, validateStatus: (s) => s >= 200 && s < 300 });
    return r.status >= 300 ? false : true;
  } catch (e: any) { return e?.response ? false : null; }
}

const out: any[] = [];
for (const q of QUERIES) {
  let codeVerified = 0, codeTotal = 0, repoCandidates = 0, repoVerified = 0, repoErrors = 0;
  try {
    const cs = await octokit.search.code({ q: `filename:SKILL.md ${q}`, per_page: 10 });
    codeTotal = cs.data.items?.length ?? 0;
    for (const it of cs.data.items ?? []) {
      const m = it.html_url.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)$/);
      if (!m) continue;
      const enc = m[4].split("/").map(encodeURIComponent).join("/");
      const raw = `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${encodeURIComponent(m[3])}/${enc}`;
      const l = await live(raw);
      if (l === null) repoErrors++; else if (l) codeVerified++;
    }
  } catch (e: any) { console.error(`  ! code search ${q}: ${e?.message ?? e}`); }
  try {
    const rs = await octokit.search.repos({ q: `${q} skill in:name,description,readme`, sort: "stars", per_page: 5 });
    for (const it of rs.data.items ?? []) {
      repoCandidates++;
      const owner = it.owner?.login ?? it.full_name.split("/")[0];
      const raw = `https://raw.githubusercontent.com/${owner}/${it.name}/${it.default_branch}/SKILL.md`;
      const l = await live(raw);
      if (l === null) repoErrors++; else if (l) repoVerified++;
    }
  } catch { /* logged above */ }
  out.push({ q, codeTotal, codeVerified, repoCandidates, repoVerified, repoErrors });
  process.stderr.write(".");
}

const totCode = out.reduce((a, r) => a + r.codeTotal, 0);
const totCodeV = out.reduce((a, r) => a + r.codeVerified, 0);
const totRepo = out.reduce((a, r) => a + r.repoCandidates, 0);
const totRepoV = out.reduce((a, r) => a + r.repoVerified, 0);

console.log("\n=== RECALL / UTILITY ===");
console.log(`queries: ${QUERIES.length}`);
console.log(`code-search (authenticated): ${totCode} file paths found, ${totCodeV} verified live -> precision ${((totCodeV / Math.max(1, totCode)) * 100).toFixed(1)}%`);
console.log(`gated repo-search:          ${totRepo} candidates probed, ${totRepoV} verified live`);
console.log(`installable artifacts/query: code ${(totCodeV / QUERIES.length).toFixed(2)}, +gated-repo ${((totCodeV + totRepoV) / QUERIES.length).toFixed(2)}`);
console.log(`queries yielding >=1 verified artifact: ${out.filter((r) => r.codeVerified + r.repoVerified > 0).length}/${QUERIES.length}`);
console.log(`indeterminate (network) probes: ${out.reduce((a, r) => a + r.repoErrors, 0)}`);
console.log("\nJSON:" + JSON.stringify({ totCode, totCodeV, totRepo, totRepoV, perQuery: out }));
