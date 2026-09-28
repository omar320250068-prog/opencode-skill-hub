# Tool-Confabulated Artifacts: Measuring Ungrounded Link Emission in Model Context Protocol Servers

**Omar Hindawy**
Independent Researcher

---

## Abstract

Model Context Protocol (MCP) servers extend LLM agents with external tools, and those tools routinely return artifact locators — URLs pointing to files an agent is expected to fetch. We argue that a distinct and under-measured failure mode exists in this setting: **tool confabulation**, where a server emits a syntactically valid, plausible, and confidently-formatted locator for an artifact that was never verified to exist. Unlike model hallucination, which has been measured extensively, tool confabulation originates in the *server*, not the model, and is therefore invisible to the citation-faithfulness literature.

We report a measurement study on a working MCP server (`opencode-skill-hub`) that discovers and installs agent skills from public code-hosting infrastructure. Across 12 queries and 60 candidate repositories, we find that a natural ungated discovery strategy — the approach a tool author would write without thinking about grounding — emits artifact URLs with a **liveness rate of 1.7% (1/60)**. A verification-gated strategy that probes every candidate before emission reaches 100% liveness by construction. Critically, gating costs almost nothing in utility: with authenticated code search, agents obtain roughly **8–10 verified installable artifacts per query**, and nearly all queries (10–12 of 12 across repeated runs) yield at least one verified artifact.

We connect this to the established supply-chain provenance literature, noting that SLSA's central claim — that provenance is inert unless verified against a roots-of-trust — transfers to agent tool output, and that our verification gate converges in intent with an independently published URL-liveness checker. We report threats to validity prominently: the first author authored both the system and its evaluation, the corpus is synthetic, the recall arm exhibits live-API yield variance, and we measure link *liveness*, not downstream agent behaviour, for which we cite rather than claim.

**CCS Concepts:** · Software and its engineering → Software engineering management · Software and its engineering → Open source model · Computing methodologies → Natural language processing

**Keywords:** Model Context Protocol, LLM agents, tool use, grounding, provenance, link rot, agent skills, evaluation

---

## 1 Introduction

MCP has become a de facto integration layer for LLM agents [Anthropic 2025a]. A host application connects to one or more *servers*, each exposing tools that the model may call. The canonical division of labour is that servers reach the outside world and models reason over what servers return.

This arrangement creates a trust surface that is easy to overlook. A tool result is not inert data: it becomes part of the agent's context, and if it contains a locator, the agent is expected to *act* on that locator — fetching a URL, installing a package, reading a file. The tool's output thus functions as a **pointer**, and the agent's subsequent action is contingent on the pointer being real.

We identify a failure mode specific to this pointer-emitting role. Consider a server that helps an agent find reusable skills. A developer writes a reasonable implementation: query the code host's repository search, and for each hit construct the canonical raw-file URL for a `SKILL.md`. The returned object looks authoritative — correct owner, correct repository, correct default branch, well-formed HTTPS URL. It is also, in the overwhelming majority of cases, a **404**, because a topical repository is not a repository that contains the file you want.

We call this **tool confabulation**. It is distinct from model hallucination in three ways:

1. **Origin.** The ungrounded assertion is produced by the server, not the model. The model may be perfectly grounded in relaying it.
2. **Structure.** It is not a plausible-looking string. It is a *constructed* pointer that was derived by a generalization step (repository ⇒ file) that was never checked.
3. **Consequence.** The failure surfaces later, as a wasted tool call and a dead end in an agent trajectory, at a point where the agent has already committed to the pointer's validity.

Existing measurement work on LLM citation reliability [arxiv:2604.03173; arxiv:2605.06635; arxiv:2405.02228] characterises hallucinated and non-resolving URLs produced by *models*. To our knowledge there is no measurement of ungrounded locators produced by *tool servers*, despite servers being a first-class component of the agent architecture and the component best positioned to know whether a locator resolves.

**Contributions.**

- **C1.** We identify and name *tool confabulation* — ungrounded artifact emission originating in the MCP server rather than the model — and motivate it as a distinct object of study from citation hallucination.
- **C2.** We design a two-arm measurement (ungated vs. verification-gated discovery) over a real code-hosting corpus, and report that ungated emission yields 1.7% link liveness (n=60) while gated emission yields 100%.
- **C3.** We show that gating is not a precision/recall trade in this setting: authenticated code search supplies roughly 8–10 verified artifacts per query (across repeated runs), with 10–12 of 12 queries non-empty, so the cost of grounding is effectively nil.
- **C4.** We report an honest, adversarially-constructed threat analysis: self-evaluation, synthetic corpus, n=12, single corpus host, no agent-behavioural measurement, and a measurement instrument we chose ourselves.
- **C5.** We contribute a working, publicly available artifact implementing the gated design, plus reproducible study harnesses.

---

## 2 Background

### 2.1 MCP and the tool surface

MCP defines a host–client–server architecture over JSON-RPC 2.0 [Anthropic 2025a]. Servers expose three primitives — tools (executable functions), resources (contextual data), and prompts (templated workflows) — discovered via `list` methods and consumed via `call`/`get`. Transports include stdio for local processes and Streamable HTTP for remote services.

Two properties of the specification are directly relevant here. First, a `tools/call` result is an opaque, model-consumed payload; the protocol imposes no schema on what a tool may assert. There is no field by which a server can mark a value as "verified" versus "inferred" — provenance must be carried in-band, typically in the text. Second, the specification directs stdio-transport implementations to "retrieve credentials from the environment" rather than via the HTTP authorization framework. Servers that reach public infrastructure must therefore self-manage credential scope, a concern we return to in §7.

### 2.2 Agent Skills and progressive disclosure

Agent Skills standardise the unit of reusable agent capability as a directory containing a `SKILL.md` file with YAML frontmatter (`name`, `description` required; `license`, `compatibility`, `metadata`, `allowed-tools` optional) [Agent Skills 2025]. Anthropic's design write-up frames this as *progressive disclosure* [Anthropic 2025b]: metadata is pre-loaded for all skills at startup, the `SKILL.md` body is loaded only on activation, and bundled resources only when referenced.

This has a consequence for our setting. Because skills are filesystem-resident and discovered by name/description matching, **the population of installed skills is a curated artifact**. Nothing forces a skill to exist; nothing prevents a bad one from being installed. Any system that grows a skill population must therefore perform selection, and selection quality is the subject of this paper.

### 2.3 Reliability of URLs in LLM systems

A substantial recent literature measures link reliability in LLM output. arXiv:2604.03173 reports that 3–13% of citation URLs in deep-research agent output are hallucinated (no archival record) and 5–18% are non-resolving overall, across DRBench and ExpertQA; it further shows that deep-research agents emit substantially more citations per query than search-augmented LLMs *while hallucinating at higher rates*, and that mitigation depends on tool use competence rather than tool access alone. That work also releases `urlhealth`, an open-source Wayback-Machine-based classifier for URL liveness and stale-versus-hallucinated resolution that, in agentic self-correction experiments, reduces non-resolving citation URLs by 6–79× (to under 1%).

arXiv:2605.06635 decomposes citation quality into *Link Works*, *Relevant Content*, and *Fact Check*, and finds a striking dissociation: even frontier models exceed 94% link validity and 80% relevance while achieving only 39–77% factual accuracy. arXiv:2405.02228 (REASONS) frames the trade-off as a dual metric — abstention rate (AR) versus hallucination rate (HR) — and shows that under adversarial metadata several systems exceed 85% HR while retrieval-augmented variants approach zero abstention. arXiv:2607.20527 shows that measured unsupported-citation rates swing from ~3% to ~18% purely with verifier strictness, and proposes gold-anchored, distribution-free bounds; a direct warning that *the measuring instrument is part of the measurement*. arXiv:2608.24306 localises error origination within multi-agent pipelines, finding 84.7% of final-report errors in one system trace to the orchestrator.

Link rot is a long-standing phenomenon: Zittrain et al. [2014] found over 70% of Harvard Law Review URLs no longer resolve, and Pew Research Center [2024] reports that ~25% of webpages published 2013–2023 have disappeared. These are cited as commonly reported measures of link persistence; we did not independently verify either statistic.

The common thread is that all of this work studies pointers *generated by models*. Our object of study is different.

### 2.4 Provenance and verification

The software supply-chain community confronted a structurally identical problem decades earlier: a claim ("this artifact came from this source") is worthless unless somebody checks it. SLSA formalises provenance as an attestation and — critically for us — states that "provenance doesn't do anything unless somebody inspects it", defining that inspection as *verification*, performed against a configured roots-of-trust [SLSA 2025a]. Verification is not optional decoration; it is the step that makes the claim mean anything. SLSA also distinguishes *internal* parameters (trusted because the platform is trusted) from *external* parameters, which "MUST be included in the provenance and MUST be verified downstream" [SLSA 2025b].

We adopt this vocabulary deliberately. An MCP tool's emitted URL is a claim about an artifact's location. A *synthesised* URL is an external parameter: derived outside any trusted process, and therefore requiring verification before an agent acts on it.

---

## 3 Research Questions

**RQ1.** What is the link liveness of artifact locators emitted by a natural ungated discovery strategy over a real code-hosting corpus?

**RQ2.** Does verification-gating destroy utility — i.e., does the agent still obtain installable artifacts at a useful rate?

**RQ3.** How does discovery yield differ between authenticated code search and unauthenticated repository search under gating?

**RQ4.** Do popularity-based ranking heuristics interact badly with verification status?

---

## 4 The Vehicle: `opencode-skill-hub`

We use a working MCP server as the instrument rather than a simulation, because the failure we study is a property of concrete API semantics (repository search does not imply file existence), which a simulation would abstract away. The server (~1.9k lines TypeScript) exposes three tools over stdio.

**`analyze_project_needs`** parses a workspace's manifests (`package.json`, `Cargo.toml`, `pyproject.toml`, `go.mod`, `requirements.txt`) plus cross-cutting signals, and maps detections through a hand-authored taxonomy of 20 *need rules* to recommended skills and agents, each carrying a ready-to-use downstream search query.

**`search_skills_and_agents`** queries the code host, merging authenticated code search (`filename:SKILL.md`) with repository search, and returns candidates with owner, repository, path, and raw download URL.

**`install_skill_or_agent`** writes a verified skill to `.opencode/skills/<name>/SKILL.md`, or merges an MCP server entry into `opencode.json` under `mcp.<name>`.

The design decision that matters for this paper is in the second tool. Search results carry a `verified` flag. Repository-search hits arrive **unverified**: code-host repository search ranks repositories by topical relevance to a query and says nothing about their internal file structure. Rather than construct a path and emit it, the server probes candidate URLs and emits a locator **only if the probe resolves**. Unverified candidates are still returned, but as topical *leads* with no URL, and the response states how many were suppressed and why.

This is the entire intervention: **an emission gate between inference and output.**

---

## 5 Method

### 5.1 Design

We compare two arms over an identical candidate pool, differing only in whether a locator is emitted without verification.

- **Arm A (ungated).** For each repository-search hit, construct `https://raw.githubusercontent.com/{owner}/{repo}/{default_branch}/SKILL.md`. This is the minimal natural implementation; it uses only fields the API actually returns.
- **Arm B (gated).** Emit a locator only if an HTTP `HEAD` to the constructed URL returns 2xx. Otherwise emit no locator.

The outcome variable is **link liveness**: whether the emitted URL resolves when a downstream agent fetches it. This is deliberately the weakest possible success criterion — a URL that resolves is not thereby correct or relevant. We adopt it because it is the one property the *agent* depends on first, and because it admits objective measurement.

Probes with transport-level failure (no HTTP status) are recorded as *indeterminate* and excluded from the denominator rather than silently counted as dead, following the practice in URL-liveness measurement (arXiv:2604.03173) of distinguishing a liveness verdict from an unknown outcome.

### 5.2 Corpus and queries

12 queries spanning realistic skill-curation topics (astro, nextjs, prisma, tailwind, playwright, python, rust, docker, typescript, testing, graphql, auth). Top-5 repository search results per query, sorted by stars, yielding 60 candidate repositories. All experiments were run with a valid credential, authenticated, against the live public API.

We use live infrastructure deliberately: the phenomenon under study is a property of how a real code host ranks and structures repositories, which a frozen snapshot would not reproduce. The cost is temporal non-reproducibility, acknowledged in §9.

### 5.3 Instrument

Our verification classifier is an HTTP `HEAD` with a 2xx acceptance predicate. Its intent converges with the `urlhealth` classifier of arXiv:2604.03173 — that emitted locators should not be trusted until an external liveness check — though the mechanisms differ (they resolve against the Wayback Machine; we probe the origin host directly). We note the convergent intent rather than claiming our instrument replicates theirs.

Per arXiv:2607.20527's warning that measured rates inherit their instrument's idiosyncrasies, we report the instrument explicitly and note that a stricter or looser predicate would move the numbers. We use the *loosest reasonable* predicate (any 2xx), which biases toward finding URLs live; our reported Arm A liveness of 1.7% is therefore an **upper bound** on the ungated failure rate.

### 5.4 Reproducibility

Both harnesses are released with the artifact (`study/liveness.mts`, `study/recall.mts`) and require only a `GITHUB_TOKEN` with public read scope. They print a machine-readable JSON summary. Raw per-query results are reported in §6.

---

## 6 Results

### 6.1 RQ1: liveness of ungated discovery

| Arm | Locators emitted | Live | Liveness |
|---|---|---|---|
| A — ungated | 60 | 1 | **1.7%** |
| B — gated | 1 | 1 | **100%** |

All 60 probes returned a determinate HTTP status; zero were indeterminate. Gating suppressed **59 of 60 (98.3%)** candidate locators.

Per-query ungated liveness was 0/5 for eleven of twelve queries. The single survivor was `docker hardening skill` (1/5), in which one candidate repository happened to place a `SKILL.md` at its root.

That the effect is this uniform is itself the finding. We did not observe a spread of partial correctness that a competent tool could threshold; we observed an essentially binary outcome. A repository is topical to "prisma migrations" with overwhelming probability *and* contains no `SKILL.md`, because the population of high-ranked topical repositories — large general-purpose projects — is structurally unlike the population of skill repositories, which are typically small, unglamorous, and therefore rarely surface under star-ranked search.

**Finding 1.** A repository-anchored inference to a specific file path is wrong ~98% of the time for skill discovery. This is not a tail failure mode to be tuned away; it is the modal behaviour of the strategy.

### 6.2 RQ2: does gating cost utility?

| Strategy | Verified artifacts/query (run 1 / run 2) | Queries with ≥1 artifact (run 1 / run 2) |
|---|---|---|
| Authenticated code search | 10.00 / 8.33 | 12/12 / 10/12 |
| + gated repository search | 10.08 / 8.42 | 12/12 / 10/12 |

Across two identical executions, code search located 120 and 100 file paths respectively; every located path resolved (100% precision in both runs). The gated repository-search fallback contributed exactly one further artifact in each run. The run-to-run difference is yield variance of the live code-search endpoint, not measurement error in the gate: both runs returned zero code-search results for exactly two of the twelve queries (`graphql schema skill`, `auth security skill`), but only in the second run.

**Finding 2.** Verification costs effectively nothing here. The agent still obtains roughly 8–10 installable artifacts per query, and all of them resolve. The 1.7%-liveness arm was not a useful baseline being beaten by a better one — it was *worse than returning nothing*, while providing no compensating recall. Gating is not a precision/recall trade in this setting; it is the difference between a tool that works and a tool that emits noise.

This is the paper's most consequential negative result, and it cuts against intuition. A reasonable prior is that verification is a cost paid for safety. Here the ungated arm was not trading recall for precision; it was losing on both axes simultaneously, because its output was consumed at a strictly worse rate.

### 6.3 RQ3: authenticated vs. unauthenticated

Unauthenticated, the code host's code-search endpoint rejects requests, leaving repository search as the only available primitive. Our server detects this, degrades to repository search, and states the degradation in its output.

The measurements above make the cost of that degradation concrete: the unauthenticated path reaches 1 verified artifact across 12 queries (0.08/query) versus ~8–10/query authenticated — a **~100–125× reduction**.

**Finding 3.** Authentication is the dominant determinant of discovery utility, exceeding the contribution of the verification gate by two orders of magnitude. A discovery tool's most consequential design parameter is credential availability, not ranking or gating. Systems should surface this to the user rather than silently returning a degraded result set, which is why our server emits an explicit warning naming the missing variable.

### 6.4 RQ4: ranking and verification interact badly

During development, an earlier version of the server assigned code-search hits a star count of zero (the code-search API does not return repository popularity) and ranked primarily by `log10(stars+1)`. The result was an inversion: a 292k-star general-purpose repository outranked every genuine `SKILL.md` match.

We fixed this by backfilling repository metadata for distinct repositories and by separating the two signals: a verified locator receives a large constant bonus, and star contribution is capped so it can only break ties. Ranking is not a cosmetic concern downstream of verification; in a tool whose output is consumed mechanically, ordering determines what the agent tries first, and a popularity proxy silently determines it wrongly.

**Finding 4.** In verification-gated discovery, correctness of the gate must dominate the ranking function. A popularity proxy is a poor relevance signal for a heterogeneous corpus and will, if unopposed, reorder verified results below unverified ones.

### 6.5 Engineering validation

The server additionally carries 107 assertions across four suites, executed against a real client over stdio: tool registration; multi-ecosystem detection over a synthetic fixture; both installation modes; configuration-merge preservation; eight error-handling paths including path-traversal rejection and refusal to overwrite a malformed `opencode.json`; and unauthenticated degradation. Two defects were found by this evaluation and are reported in §6.4 and §7 rather than fixed silently.

We present these as engineering validation of correctness, not as scientific evidence for C2 or C3, which rest entirely on §6.1–6.2.

---

## 7 Design Implications

**7.1 Gate emission, not generation.** The intervention is one boolean at the boundary between inference and output. It requires no change to the retrieval logic, no additional model, and no access to any privileged API. The cost is a network round-trip per candidate.

**7.2 Credential scope is a safety property.** The MCP specification directs stdio servers to source credentials from the environment. Because such servers also accept user-supplied URLs, an unscoped credential is a credential-exfiltration primitive. Our implementation restricts token transmission to `*.github.com` hosts. This was not a requirement we anticipated; it emerged from writing a shared header helper and noticing it would have attached the token to arbitrary hosts.

**7.3 Distinguish "not found" from "unknown."** A probe that fails to connect is not evidence of absence. Collapsing the two produces a tool that confidently asserts nonexistence, which is the mirror image of the failure we set out to fix.

**7.4 Report degradation explicitly.** When a capability is unavailable, naming the missing variable and its consequence is more useful to an agent than a plausible-looking result set.

---

## 8 Limitations

We are explicit that the behavioural claim motivating this work is **not** what we measured. We measured the incidence of ungrounded locators in tool output. That dead links degrade agent trajectories is supported by prior work — arXiv:2604.03173 reports 6–79× reduction in non-resolving URLs from tool-mediated self-correction, conditioned on tool-use competence — and we cite it rather than claim it. We did not run agents, did not measure wasted tool calls, and cannot separate the effect of a dead locator from the effect of the surrounding tool design.

The measurement instrument is an HTTP `HEAD` predicate chosen by the first author. `HEAD` is unsupported or misleading for some hosts, and our 2xx predicate is permissive; a stricter instrument would report lower liveness. A `GET` with content-type and body validation might additionally reject HTML error pages served with 200 status, which our gate would accept — a known false-positive path that `install_skill_or_agent` guards against separately but the gate does not.

We study one host, one artifact type, and one discovery strategy. Link liveness in general is known to vary by domain (arXiv:2604.03173 reports 5.4%–11.4% across fields) and our results should not be generalised beyond public code hosting.

---

## 9 Threats to Validity

**Self-evaluation.** The first author wrote both the system and its evaluation. This is the most serious threat and we do not claim independence. The measurement in §6.1–6.2 is however mechanical — a URL either returns 2xx or it does not — and the code that performs the probe is 15 lines whose correctness is directly inspectable. The interpretive layer (which arm to compare, what counts as success) remains authorial.

**Small n and no inferential statistics.** n=60 candidate locators, clustered within 12 queries, from a single host at a single point in time. We report descriptive proportions and deliberately do not compute significance tests: with a clustering structure of 12 units, such tests would convey false precision. The effect is large enough (1.7% vs. 100%) that inference is not load-bearing, but the per-query figures should not be read as estimates of a population.

**Corpus selection.** Queries were chosen by the first author to span plausible skill-curation topics. They are not a random sample of user queries and may be unusually favourable to code search, which is highly effective when the query names a technology that appears in a `SKILL.md` path or description. A user searching for a capability rather than a technology might see materially different yield.

**Temporal non-reproducibility and live-API yield variance.** All measurements are against a live API. Repository rankings, star counts, and file locations change. We observed and report the drift directly: repeating the recall arm on the same day changed code-search yield from 120 to 100 paths (two queries returned empty on one run), while the liveness arm was stable at 60/60 determinate on both runs (1.7% vs. 100%). Absolute numbers will drift; the Arm A/Arm B contrast is structural and will not.

**Instrument dependence.** Following arXiv:2607.20527, we report our predicate and note that the measured rate is a function of it. Our chosen predicate is permissive, so 1.7% is an upper bound on ungated liveness and the failure rate is correspondingly a lower bound.

**The comparison may be considered unfair to Arm A.** A fairer baseline would verify cheaply and only then rank, which is Arm B. We argue this is precisely the point — the alternative *is* Arm B — but readers who regard "ungated synthesis" as a strawman should note that we did not compare against other reasonable ungated designs, only against no verification at all.

**Single-labeller taxonomy.** The 20 need rules are hand-authored and unreviewed. Their effect on §6.1–6.2 is nil (they belong to `analyze_project_needs`, not to discovery), but any claim about detection quality would be subject to this threat, and we make no such claim.

**Unobserved confounder: credential tier.** All measurements used one credential with public read scope on one account. GitHub code-search result counts are affected by account age and usage. Different accounts may observe different `per_page` saturation, and the 220/220 total code-search precision observed across the two runs should not be read as a property of code search in general.

---

## 10 Future Work

- **Adversarial measurement.** The most valuable next step is running actual agents in both arms and measuring wasted tool calls, trajectory length, and success rate. Our §8 identifies this as the load-bearing missing evidence.
- **Robust verification.** Replace `HEAD` with a content-aware probe that rejects 200-status HTML error pages, and extend our LIVE/DEAD/UNKNOWN outcome classification with a WHAT-IS-THIS category distinguishing "file exists but is not a skill" from "file absent".
- **In-band provenance.** Since MCP imposes no schema on tool results, we propose a convention: tools emit an explicit `verified: true|false` alongside any locator. This costs a few tokens and makes the gate legible to the consuming model rather than merely enforced server-side.
- **Corpus generality.** Replicate across hosts (GitLab, package registries) and artifact types (containers, wheels) where the repository-anchored inference is equally available and equally unsafe.
- **Multi-agent error attribution.** Following arXiv:2608.24306, localise confabulation to specific pipeline stages in multi-agent systems.

---

## 11 Conclusion

Tool servers sit in a privileged position: they are the component that can actually know whether a pointer resolves, and they are the component that most often fails to check. Measuring this on a real MCP server over a real corpus, we found that a natural ungated discovery strategy emits artifact locators with 1.7% liveness, that verification gating raises this to 100% at negligible utility cost, and that credential availability — not ranking, not gating — is the single largest determinant of whether discovery works at all. We argue that the supply-chain community's insight — provenance is inert until verified — applies directly to agent tool output, and that emission gates are the minimum viable form of that verification.

---

## References

**Primary sources consulted and verified against the documents themselves (abstract pages / spec pages):**

- Anthropic. 2025a. *Model Context Protocol Specification* (2024-11-05, 2025-03-26, 2025-06-18, 2025-11-25). modelcontextprotocol.io. Verified at `/specification/2025-11-25` including the stdio credential guidance under Auth.
- Anthropic. 2025b. *Equipping agents for the real world with Agent Skills*. anthropic.com/engineering, 16 Oct 2025. Verified.
- Agent Skills. 2025. *Agent Skills Specification*. agentskills.io/specification. Verified (frontmatter fields and progressive disclosure).
- SLSA. 2025a. *Verifying Artifacts* (Build, v1.2). slsa.dev. Verified; approved status.
- SLSA. 2025b. *Build Provenance* (v1.2). slsa.dev. Verified; "externalParameters … MUST be included in the provenance and MUST be verified downstream".
- Rao, Delip, Eric Wong, and Chris Callison-Burch. 2026. *Detecting and Correcting Reference Hallucinations in Commercial LLMs and Deep Research Agents*. arXiv:2604.03173, submitted 3 Apr 2026. Verified against the arXiv abstract page.
- Onweller, Hailey, et al. 2026. *Cited but Not Verified: Parsing and Evaluating Source Attribution in LLM Deep Research Agents*. arXiv:2605.06635, submitted 7 May 2026. Verified.
- Goo, Taewan, et al. 2026. *Evaluating and Guarding Citation Faithfulness in Agentic Scientific Synthesis*. arXiv:2607.20527, submitted 10 Jul 2026. Verified.
- Hirsch, Eran, et al. 2026. *Who is the Agent to Blame? Localizing Faithfulness and Citation Mistakes in Agentic Deep Research*. arXiv:2608.24306, accepted EMNLP 2026. Verified.
- Tilwani, Deepa, et al. 2024/2026. *Abstention vs. Hallucination: Benchmarking LLM Source Attribution for Scientific Citations* (REASONS). arXiv:2405.02228, v5 15 Sep 2026. Verified.

**Commonly reported secondary statistics, cited but not independently verified:**

- Zittrain, et al. 2014. Harvard Law Review URL decay (>70% non-resolving).
- Pew Research Center. 2024. Webpage persistence 2013–2023 (~25% disappeared).

---

## Appendix A — Artifact

- Server: `https://github.com/omar320250068-prog/opencode-skill-hub`
- Study harnesses: `study/liveness.mts` (RQ1), `study/recall.mts` (RQ2–RQ3)
- Runtime: Node ≥18; a `GITHUB_TOKEN` with public read scope
- Both harnesses print a machine-readable JSON summary and are safe to re-run; expect drift in absolute values over time for the reasons in §9.
