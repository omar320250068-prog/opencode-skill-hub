#!/usr/bin/env node
/**
 * opencode-skill-hub
 * ------------------
 * An MCP (Model Context Protocol) server, transported over stdio, that acts as an
 * automated skill & agent manager for OpenCode projects.
 *
 * Tools exposed:
 *   1. analyze_project_needs    - detect stacks/frameworks in a workspace and
 *                                 recommend the skills/agents the project needs.
 *   2. search_skills_and_agents - query GitHub for SKILL.md files and MCP server
 *                                 configurations.
 *   3. install_skill_or_agent   - write a skill into `.opencode/skills/<name>/SKILL.md`
 *                                 or register an MCP server in `opencode.json`.
 *
 * CRITICAL: stdout is the JSON-RPC channel. Every diagnostic message must go to
 * stderr instead, otherwise the client connection will be corrupted.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Octokit } from "@octokit/rest";
import axios from "axios";
import fs from "fs-extra";
import os from "node:os";
import path from "node:path";

const SERVER_NAME = "opencode-skill-hub";
const SERVER_VERSION = "0.1.0";

/** Hard ceiling for any remote content we are willing to write to disk (2 MiB). */
const MAX_REMOTE_BYTES = 2 * 1024 * 1024;
/** Safety valve for a single `analyze_project_needs` call. */
const MAX_DEPENDENCIES_REPORTED = 60;
/** Cap on the number of GitHub repo-metadata lookups performed per search. */
const MAX_REPO_LOOKUPS = 15;
/** How many candidate repos get a SKILL.md existence probe. */
const MAX_SKILL_FILE_PROBES = 20;
/** How many of those probes may additionally walk known skill directories (costs API quota). */
const MAX_NESTED_SKILL_PROBES = 5;
/** Conventional directories that hold `<name>/SKILL.md` layouts. */
const KNOWN_SKILL_DIRS = [".claude/skills", ".opencode/skills", ".cursor/skills", "skills", ".github/skills"];
/** Safety valve for recursive directory walks. */
const MAX_DIR_ENTRIES_SCANNED = 2000;

/* -------------------------------------------------------------------------- */
/* Logging (stderr only — stdout belongs to the MCP transport)                 */
/* -------------------------------------------------------------------------- */

function log(message: string, ...rest: unknown[]): void {
  console.error(`[${SERVER_NAME}] ${message}`, ...rest);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/* -------------------------------------------------------------------------- */
/* Small utilities                                                             */
/* -------------------------------------------------------------------------- */

/** Read an env var defensively: trimmed, unquoted, empty => undefined. */
function readEnv(name: string): string | undefined {
  try {
    const raw = process.env[name];
    if (typeof raw !== "string") return undefined;
    const cleaned = raw.trim().replace(/^["']|["']$/g, "").trim();
    return cleaned.length > 0 ? cleaned : undefined;
  } catch {
    return undefined;
  }
}

function githubToken(): string | undefined {
  return readEnv("GITHUB_TOKEN") ?? readEnv("GH_TOKEN");
}

function ensureDirSafe(dir: string): void {
  fs.ensureDirSync(dir);
}

function readTextIfExists(file: string): string | undefined {
  try {
    if (!fs.existsSync(file)) return undefined;
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_REMOTE_BYTES) return undefined;
    return fs.readFileSync(file, "utf8");
  } catch (e) {
    log(`failed reading ${file}: ${errorMessage(e)}`);
    return undefined;
  }
}

function readJsonIfExists<T>(file: string): T | undefined {
  const raw = readTextIfExists(file);
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch (e) {
    log(`failed parsing JSON at ${file}: ${errorMessage(e)}`);
    return undefined;
  }
}

/** Validate that `candidate` is an existing, readable directory. */
function resolveWorkspace(raw: unknown): string {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new Error("`workspacePath` is required and must be a non-empty string.");
  }

  const resolved = path.resolve(os.homedir(), raw.trim());
  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch {
    throw new Error(`Workspace path does not exist: ${resolved}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`Workspace path is not a directory: ${resolved}`);
  }
  try {
    fs.accessSync(resolved, fs.constants.R_OK);
  } catch {
    throw new Error(`Workspace path is not readable: ${resolved}`);
  }
  return resolved;
}

/** Reject anything that could escape the skills directory (traversal, absolute paths...). */
function assertSafeName(raw: unknown, label = "name"): string {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new Error(`\`${label}\` is required and must be a non-empty string.`);
  }
  const name = raw.trim();
  if (name.length > 128) {
    throw new Error(`\`${label}\` must be 128 characters or fewer (got ${name.length}).`);
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name)) {
    throw new Error(
      `\`${label}\` must start with a letter/digit and contain only letters, digits, dots, underscores and dashes (got: ${JSON.stringify(name)}).`,
    );
  }
  if (name === "." || name === "..") {
    throw new Error(`\`${label}\` cannot be "${name}".`);
  }
  return name;
}

function unique<T>(items: Iterable<T>): T[] {
  return Array.from(new Set(items));
}

function titleCase(value: string): string {
  return value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

/** Best-effort, dependency-free extraction of top-level keys from a TOML table. */
function extractTomlTableKeys(content: string, table: string): string[] {
  const keys: string[] = [];
  const lines = content.split(/\r?\n/);
  let inTable = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;

    const header = line.match(/^\[+\s*([^\]]+?)\s*\]+$/);
    if (header?.[1] !== undefined) {
      // `[dependencies]`, `[dependencies.foo]`, `[workspace.dependencies]`
      const name = header[1].replace(/^["']|["']$/g, "");
      inTable = name === table || name === `workspace.${table}` || name.startsWith(`${table}.`);
      continue;
    }

    if (!inTable) continue;
    const kv = line.match(/^([A-Za-z0-9_.-]+|"[^"]+"|'[^']+')\s*=/);
    const key = kv?.[1];
    if (key === undefined) continue;
    keys.push(key.replace(/^["']|["']$/g, ""));
  }
  return unique(keys);
}

/** Best-effort extraction of the module names in a `go.mod` `require` block. */
function extractGoRequires(content: string): string[] {
  const mods: string[] = [];

  const block = content.match(/require\s*\(([\s\S]*?)\)/);
  const body = block?.[1] ?? content;

  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("//")) continue;
    const mod = line.match(/^([A-Za-z0-9._~-]+\.[A-Za-z0-9._~/-]+)\s+v\S+/);
    if (mod?.[1] !== undefined) mods.push(mod[1]);
  }
  return unique(mods);
}

/* -------------------------------------------------------------------------- */
/* Detection catalogs                                                          */
/* -------------------------------------------------------------------------- */

type Ecosystem = "node" | "python" | "rust" | "go";

interface FrameworkRule {
  id: string;
  label: string;
  /** Package / module names that indicate this framework. */
  packages: string[];
  /** Config file globs that indicate this framework even without a dependency. */
  files?: string[];
}

const NODE_FRAMEWORKS: FrameworkRule[] = [
  { id: "astro", label: "Astro", packages: ["astro"], files: ["astro.config.*"] },
  { id: "nextjs", label: "Next.js", packages: ["next"], files: ["next.config.*"] },
  { id: "nuxt", label: "Nuxt", packages: ["nuxt"], files: ["nuxt.config.*"] },
  {
    id: "remix",
    label: "Remix",
    packages: ["@remix-run/react", "@remix-run/node", "@remix-run/serve"],
  },
  { id: "sveltekit", label: "SvelteKit", packages: ["@sveltejs/kit"], files: ["svelte.config.*"] },
  { id: "svelte", label: "Svelte", packages: ["svelte"] },
  { id: "vue", label: "Vue", packages: ["vue"] },
  { id: "angular", label: "Angular", packages: ["@angular/core"] },
  { id: "solidstart", label: "SolidStart", packages: ["solid-start", "@solidjs/start"] },
  { id: "solid", label: "SolidJS", packages: ["solid-js"] },
  { id: "react", label: "React", packages: ["react"] },
  { id: "express", label: "Express", packages: ["express"] },
  { id: "fastify", label: "Fastify", packages: ["fastify"] },
  { id: "hono", label: "Hono", packages: ["hono"] },
  { id: "nestjs", label: "NestJS", packages: ["@nestjs/core", "@nestjs/common"] },
  { id: "trpc", label: "tRPC", packages: ["@trpc/server", "@trpc/client"] },
  { id: "prisma", label: "Prisma", packages: ["prisma", "@prisma/client"], files: ["prisma/schema.prisma"] },
  { id: "drizzle", label: "Drizzle ORM", packages: ["drizzle-orm"] },
  { id: "kysely", label: "Kysely", packages: ["kysely"] },
  { id: "sequelize", label: "Sequelize", packages: ["sequelize"] },
  { id: "mongoose", label: "Mongoose", packages: ["mongoose"] },
  { id: "mongodb", label: "MongoDB", packages: ["mongodb", "mongoose"] },
  { id: "postgres", label: "PostgreSQL", packages: ["pg", "postgres", "@neondatabase/serverless"] },
  { id: "mysql", label: "MySQL", packages: ["mysql", "mysql2"] },
  { id: "sqlite", label: "SQLite", packages: ["better-sqlite3", "sqlite3", "node:sqlite"] },
  { id: "supabase", label: "Supabase", packages: ["@supabase/supabase-js", "@supabase/ssr"] },
  { id: "firebase", label: "Firebase", packages: ["firebase", "firebase-admin"] },
  { id: "graphql", label: "GraphQL", packages: ["graphql", "apollo-server", "@apollo/server", "graphql-yoga"] },
  { id: "tailwindcss", label: "Tailwind CSS", packages: ["tailwindcss"], files: ["tailwind.config.*"] },
  { id: "redux", label: "Redux", packages: ["@reduxjs/toolkit", "redux"] },
  { id: "zustand", label: "Zustand", packages: ["zustand"] },
  { id: "electron", label: "Electron", packages: ["electron"] },
  { id: "tauri", label: "Tauri", packages: ["@tauri-apps/api", "tauri"] },
  { id: "expo", label: "Expo", packages: ["expo"] },
  { id: "vite", label: "Vite", packages: ["vite"], files: ["vite.config.*"] },
  { id: "webpack", label: "Webpack", packages: ["webpack"] },
  { id: "playwright", label: "Playwright", packages: ["@playwright/test", "playwright"] },
  { id: "cypress", label: "Cypress", packages: ["cypress"] },
  { id: "vitest", label: "Vitest", packages: ["vitest"] },
  { id: "jest", label: "Jest", packages: ["jest"] },
  { id: "storybook", label: "Storybook", packages: ["@storybook/react", "storybook"] },
  { id: "zod", label: "Zod", packages: ["zod"] },
  { id: "trpc-ui", label: "shadcn/ui", packages: ["@radix-ui/react-dialog", "class-variance-authority"] },
  { id: "langchain", label: "LangChain", packages: ["langchain", "@langchain/core"] },
  { id: "llm-sdk", label: "LLM SDK", packages: ["openai", "@anthropic-ai/sdk", "ai", "@ai-sdk/core", "ollama"] },
  { id: "vector-db", label: "Vector DB", packages: ["@pinecone-database/pinecone", "chromadb", "qdrant-js"] },
  { id: "stripe", label: "Stripe", packages: ["stripe"] },
  { id: "auth", label: "Auth", packages: ["next-auth", "@auth/core", "lucia", "clerk", "@clerk/nextjs"] },
  { id: "queue", label: "Job Queue", packages: ["bullmq", "bull", "graphile-worker", "inngest"] },
  { id: "realtime", label: "Realtime", packages: ["socket.io", "socket.io-client", "ably"] },
  { id: "telemetry", label: "Telemetry", packages: ["@sentry/node", "opentelemetry", "@vercel/analytics"] },
  { id: "eslint", label: "ESLint", packages: ["eslint"], files: ["eslint.config.*", ".eslintrc*"] },
  { id: "biome", label: "Biome", packages: ["@biomejs/biome"], files: ["biome.json"] },
];

const PYTHON_FRAMEWORKS: FrameworkRule[] = [
  { id: "django", label: "Django", packages: ["django"] },
  { id: "fastapi", label: "FastAPI", packages: ["fastapi"] },
  { id: "flask", label: "Flask", packages: ["flask"] },
  { id: "starlette", label: "Starlette", packages: ["starlette"] },
  { id: "sqlalchemy", label: "SQLAlchemy", packages: ["sqlalchemy"] },
  { id: "alembic", label: "Alembic", packages: ["alembic"] },
  { id: "pydantic", label: "Pydantic", packages: ["pydantic"] },
  { id: "pandas", label: "pandas", packages: ["pandas"] },
  { id: "numpy", label: "NumPy", packages: ["numpy"] },
  { id: "pytorch", label: "PyTorch", packages: ["torch"] },
  { id: "tensorflow", label: "TensorFlow", packages: ["tensorflow"] },
  { id: "sklearn", label: "scikit-learn", packages: ["scikit-learn"] },
  { id: "transformers", label: "Transformers", packages: ["transformers"] },
  { id: "celery", label: "Celery", packages: ["celery"] },
  { id: "streamlit", label: "Streamlit", packages: ["streamlit"] },
  { id: "gradio", label: "Gradio", packages: ["gradio"] },
  { id: "langchain-py", label: "LangChain (py)", packages: ["langchain", "langchain-core"] },
  { id: "pytest", label: "pytest", packages: ["pytest", "pytest-asyncio"] },
  { id: "httpx", label: "HTTPX", packages: ["httpx", "aiohttp", "requests"] },
  { id: "typer", label: "Typer / Click", packages: ["typer", "click"] },
  { id: "polars", label: "Polars", packages: ["polars"] },
  { id: "duckdb", label: "DuckDB", packages: ["duckdb"] },
];

const RUST_FRAMEWORKS: FrameworkRule[] = [
  { id: "tokio", label: "Tokio", packages: ["tokio"] },
  { id: "axum", label: "Axum", packages: ["axum"] },
  { id: "actix-web", label: "Actix Web", packages: ["actix-web"] },
  { id: "rocket", label: "Rocket", packages: ["rocket"] },
  { id: "serde", label: "Serde", packages: ["serde"] },
  { id: "clap", label: "Clap", packages: ["clap"] },
  { id: "sqlx", label: "sqlx", packages: ["sqlx"] },
  { id: "diesel", label: "Diesel", packages: ["diesel"] },
  { id: "bevy", label: "Bevy", packages: ["bevy"] },
  { id: "tauri-rs", label: "Tauri (Rust)", packages: ["tauri"] },
  { id: "wasm", label: "WebAssembly", packages: ["wasm-bindgen", "web-sys"] },
];

const GO_FRAMEWORKS: FrameworkRule[] = [
  { id: "gin", label: "Gin", packages: ["github.com/gin-gonic/gin"] },
  { id: "echo", label: "Echo", packages: ["github.com/labstack/echo"] },
  { id: "chi", label: "chi", packages: ["github.com/go-chi/chi"] },
  { id: "fiber", label: "Fiber", packages: ["github.com/gofiber/fiber"] },
  { id: "cobra", label: "Cobra", packages: ["github.com/spf13/cobra"] },
  { id: "grpc-go", label: "gRPC-Go", packages: ["google.golang.org/grpc"] },
  { id: "gorm", label: "GORM", packages: ["gorm.io/gorm"] },
];

/**
 * Each "need" links a detection signal to the specialised skill/agent that the
 * project is likely to benefit from. `searchQuery` is directly consumable by
 * `search_skills_and_agents`.
 */
interface NeedRule {
  id: string;
  title: string;
  priority: "high" | "medium" | "low";
  reason: string;
  suggestedSkill: string;
  suggestedAgent: string;
  searchQuery: string;
  /** Signals that trigger this need. */
  signals: string[];
}

const NEED_RULES: NeedRule[] = [
  {
    id: "astro",
    title: "Astro conventions & content collections",
    priority: "high",
    reason: "Astro projects depend on island architecture, content collections and file-based routing rules that are easy to get wrong.",
    suggestedSkill: "astro-best-practices",
    suggestedAgent: "astro-engineer",
    searchQuery: "astro skill",
    signals: ["astro"],
  },
  {
    id: "nextjs",
    title: "Next.js App Router / RSC patterns",
    priority: "high",
    reason: "Next.js mixes server and client components; a dedicated skill prevents hydration and caching mistakes.",
    suggestedSkill: "nextjs-app-router",
    suggestedAgent: "nextjs-engineer",
    searchQuery: "nextjs app router skill",
    signals: ["nextjs", "react"],
  },
  {
    id: "data-orm",
    title: "ORM schema design & migrations",
    priority: "high",
    reason: "A Prisma/Drizzle/SQLAlchemy model is present, so schema authoring, migration safety and seeding need a house style.",
    suggestedSkill: "prisma-schema-and-migrations",
    suggestedAgent: "database-engineer",
    searchQuery: "prisma migrations skill",
    signals: ["prisma", "drizzle", "kysely", "sequelize", "sqlalchemy", "diesel", "sqlx", "gorm"],
  },
  {
    id: "tailwind-design",
    title: "Design-system & Tailwind conventions",
    priority: "medium",
    reason: "Tailwind is configured; a token/utility convention skill keeps generated markup consistent with the design system.",
    suggestedSkill: "tailwind-design-system",
    suggestedAgent: "ui-engineer",
    searchQuery: "tailwind design system skill",
    signals: ["tailwindcss"],
  },
  {
    id: "api-design",
    title: "API contract & schema validation",
    priority: "medium",
    reason: "An API surface (REST/tRPC/GraphQL) is present; contracts, validation and versioning deserve an explicit contract.",
    suggestedSkill: "api-contract-design",
    suggestedAgent: "api-designer",
    searchQuery: "rest api design skill",
    signals: ["trpc", "graphql", "express", "fastify", "hono", "nestjs", "fastapi", "flask", "axum", "actix-web", "gin", "echo"],
  },
  {
    id: "typescript",
    title: "TypeScript strictness & type-safety review",
    priority: "medium",
    reason: "A tsconfig.json is present; a skill that enforces `strict` discipline and safe type-narrowing catches whole bug classes.",
    suggestedSkill: "typescript-strict-review",
    suggestedAgent: "typescript-reviewer",
    searchQuery: "typescript strict skill",
    signals: ["typescript"],
  },
  {
    id: "rust",
    title: "Rust ownership & async patterns",
    priority: "high",
    reason: "This is a Rust project; borrow-checker pitfalls and async runtime discipline need project-specific guidance.",
    suggestedSkill: "rust-ownership-and-async",
    suggestedAgent: "rust-engineer",
    searchQuery: "rust async skill",
    signals: ["rust"],
  },
  {
    id: "python",
    title: "Python packaging & typing conventions",
    priority: "high",
    reason: "A Python project was detected; packaging, virtualenvs and type-checking rules should be codified once.",
    suggestedSkill: "python-packaging-and-typing",
    suggestedAgent: "python-engineer",
    searchQuery: "python project skill",
    signals: ["python"],
  },
  {
    id: "go",
    title: "Go module & concurrency conventions",
    priority: "high",
    reason: "This is a Go project; idiomatic error handling and goroutine hygiene benefit from an explicit checklist.",
    suggestedSkill: "go-idioms",
    suggestedAgent: "go-engineer",
    searchQuery: "go idioms skill",
    signals: ["go"],
  },
  {
    id: "docker",
    title: "Container build & runtime hardening",
    priority: "medium",
    reason: "Container files were found; multi-stage builds, non-root users and layer caching should be standardised.",
    suggestedSkill: "docker-hardening",
    suggestedAgent: "devops-engineer",
    searchQuery: "docker best practices skill",
    signals: ["docker"],
  },
  {
    id: "testing",
    title: "Test strategy & coverage discipline",
    priority: "medium",
    reason: "A test runner is configured; a testing skill prevents snapshot sprawl and flaky integration tests.",
    suggestedSkill: "testing-strategy",
    suggestedAgent: "qa-engineer",
    searchQuery: "testing best practices skill",
    signals: ["playwright", "cypress", "vitest", "jest", "pytest"],
  },
  {
    id: "e2e",
    title: "Browser end-to-end testing",
    priority: "medium",
    reason: "Playwright/Cypress is installed; E2E flake control and locator discipline need explicit rules.",
    suggestedSkill: "playwright-e2e",
    suggestedAgent: "e2e-engineer",
    searchQuery: "playwright testing skill",
    signals: ["playwright", "cypress"],
  },
  {
    id: "ai",
    title: "LLM integration & evaluation",
    priority: "high",
    reason: "An LLM/agent SDK is a dependency; prompting, tool-calling and eval loops should follow a documented pattern.",
    suggestedSkill: "llm-integration-patterns",
    suggestedAgent: "ai-engineer",
    searchQuery: "llm agent skill",
    signals: ["llm-sdk", "langchain", "langchain-py", "vector-db", "pytorch", "transformers"],
  },
  {
    id: "auth",
    title: "Authentication & authorization review",
    priority: "high",
    reason: "An auth provider is wired up; session handling and permission boundaries deserve a dedicated review pass.",
    suggestedSkill: "auth-security-review",
    suggestedAgent: "security-reviewer",
    searchQuery: "authentication security skill",
    signals: ["auth", "next-auth"],
  },
  {
    id: "payments",
    title: "Payments & billing integration",
    priority: "high",
    reason: "Stripe is a dependency; webhook verification and idempotency are correctness-critical.",
    suggestedSkill: "stripe-billing",
    suggestedAgent: "payments-engineer",
    searchQuery: "stripe payments skill",
    signals: ["stripe"],
  },
  {
    id: "monorepo",
    title: "Monorepo workspace conventions",
    priority: "medium",
    reason: "Workspace configuration was detected; package boundaries and build orchestration need to be documented.",
    suggestedSkill: "monorepo-workspaces",
    suggestedAgent: "platform-engineer",
    searchQuery: "monorepo workspace skill",
    signals: ["monorepo"],
  },
  {
    id: "cicd",
    title: "CI/CD pipeline conventions",
    priority: "low",
    reason: "GitHub Actions workflows exist; caching, matrix strategy and required checks should be standardised.",
    suggestedSkill: "github-actions-ci",
    suggestedAgent: "devops-engineer",
    searchQuery: "github actions ci skill",
    signals: ["ci-cd"],
  },
  {
    id: "observability",
    title: "Logging, tracing & error reporting",
    priority: "low",
    reason: "Telemetry is instrumented; log/trace conventions keep production debugging tractable.",
    suggestedSkill: "observability",
    suggestedAgent: "sre",
    searchQuery: "observability logging skill",
    signals: ["telemetry"],
  },
  {
    id: "desktop",
    title: "Desktop app packaging",
    priority: "medium",
    reason: "A desktop shell (Electron/Tauri/Expo) is in use; packaging, signing and auto-update need explicit rules.",
    suggestedSkill: "desktop-packaging",
    suggestedAgent: "desktop-engineer",
    searchQuery: "electron tauri packaging skill",
    signals: ["electron", "tauri", "tauri-rs", "expo"],
  },
  {
    id: "graphql",
    title: "GraphQL schema & resolver design",
    priority: "medium",
    reason: "A GraphQL layer was detected; N+1 resolution and schema versioning are common failure points.",
    suggestedSkill: "graphql-schema-design",
    suggestedAgent: "api-designer",
    searchQuery: "graphql schema skill",
    signals: ["graphql"],
  },
];

/* -------------------------------------------------------------------------- */
/* Tool 1: analyze_project_needs                                               */
/* -------------------------------------------------------------------------- */

interface Detected {
  id: string;
  label: string;
  evidence: string[];
}

interface EcosystemReport {
  ecosystem: Ecosystem;
  manifest: string;
  packageManager?: string;
  dependencyCount: number;
  dependencies: string[];
}

type ProjectNeed = Omit<NeedRule, "signals"> & { triggeredBy: string[] };

async function analyzeProjectNeeds(args: Record<string, unknown>): Promise<unknown> {
  const workspace = resolveWorkspace(args.workspacePath);

  const scannedFiles: string[] = [];
  const frameworks: Detected[] = [];
  const stacks: Detected[] = [];
  const ecosystems: EcosystemReport[] = [];
  const signals = new Set<string>();

  const addStack = (id: string, label: string, evidence: string): void => {
    const existing = stacks.find((s) => s.id === id);
    if (existing) {
      if (!existing.evidence.includes(evidence)) existing.evidence.push(evidence);
      return;
    }
    stacks.push({ id, label, evidence: [evidence] });
  };

  const addFramework = (rule: FrameworkRule, evidence: string): void => {
    signals.add(rule.id);
    const existing = frameworks.find((f) => f.id === rule.id);
    if (existing) {
      if (!existing.evidence.includes(evidence)) existing.evidence.push(evidence);
      return;
    }
    frameworks.push({ id: rule.id, label: rule.label, evidence: [evidence] });
  };

  /* --- ecosystem: Node / TypeScript ------------------------------------- */
  const pkgPath = path.join(workspace, "package.json");
  const pkgRaw = readTextIfExists(pkgPath);
  if (pkgRaw !== undefined) {
    scannedFiles.push("package.json");
    addStack("nodejs", "Node.js", "package.json");

    let pkg: Record<string, unknown> = {};
    try {
      pkg = JSON.parse(pkgRaw) as Record<string, unknown>;
    } catch (e) {
      log(`package.json is not valid JSON: ${errorMessage(e)}`);
    }

    const deps: Record<string, string> = {
      ...(typeof pkg.dependencies === "object" && pkg.dependencies !== null
        ? (pkg.dependencies as Record<string, string>)
        : {}),
      ...(typeof pkg.devDependencies === "object" && pkg.devDependencies !== null
        ? (pkg.devDependencies as Record<string, string>)
        : {}),
      ...(typeof pkg.peerDependencies === "object" && pkg.peerDependencies !== null
        ? (pkg.peerDependencies as Record<string, string>)
        : {}),
    };
    const depNames = Object.keys(deps);

    for (const [field, marker] of [
      ["packageManager", "package.json:packageManager"],
      ["engines", "package.json:engines"],
    ] as const) {
      if (pkg[field] !== undefined) addStack(field, titleCase(field), marker);
    }

    ecosystems.push({
      ecosystem: "node",
      manifest: "package.json",
      packageManager: typeof pkg.packageManager === "string" ? pkg.packageManager : undefined,
      dependencyCount: depNames.length,
      dependencies: depNames.slice(0, MAX_DEPENDENCIES_REPORTED),
    });

    for (const rule of NODE_FRAMEWORKS) {
      const hit = depNames.find((dep) => rule.packages.includes(dep));
      if (hit !== undefined) {
        addFramework(rule, `package.json dependency "${hit}"`);
        continue;
      }
      if (rule.files !== undefined && globAnyExists(workspace, rule.files)) {
        addFramework(rule, `config file ${rule.files.join(" | ")}`);
      }
    }

    if (depNames.includes("typescript") || fs.existsSync(path.join(workspace, "tsconfig.json"))) {
      signals.add("typescript");
      addStack("typescript", "TypeScript", "typescript dependency or tsconfig.json");
    }
    if (globAnyExists(workspace, ["tailwind.config.*"])) signals.add("tailwindcss");
    if (fs.existsSync(path.join(workspace, "prisma", "schema.prisma"))) signals.add("prisma");

    // Monorepo detection.
    const workspaces = pkg.workspaces;
    const isMonorepo =
      (Array.isArray(workspaces) && workspaces.length > 0) ||
      (typeof workspaces === "object" && workspaces !== null && Array.isArray((workspaces as { packages?: unknown }).packages)) ||
      globAnyExists(workspace, ["pnpm-workspace.yaml", "lerna.json", "nx.json", "turbo.json"]);
    if (isMonorepo) {
      signals.add("monorepo");
      addStack("monorepo", "Monorepo", "workspaces field or workspace manifest");
    }
  }

  /* --- ecosystem: Python ------------------------------------------------- */
  const pyprojectPath = path.join(workspace, "pyproject.toml");
  const pyproject = readTextIfExists(pyprojectPath);
  const requirementsPath = path.join(workspace, "requirements.txt");
  const requirements = readTextIfExists(requirementsPath);

  if (pyproject !== undefined || requirements !== undefined) {
    scannedFiles.push(...(pyproject !== undefined ? ["pyproject.toml"] : []));
    scannedFiles.push(...(requirements !== undefined ? ["requirements.txt"] : []));
    signals.add("python");
    addStack("python", "Python", pyproject !== undefined ? "pyproject.toml" : "requirements.txt");

    const deps: string[] = [];
    let packageManager: string | undefined;

    if (pyproject !== undefined) {
      for (const key of extractTomlTableKeys(pyproject, "project.dependencies")) deps.push(key);
      // PEP 621 `dependencies = ["fastapi>=0.1", ...]`
      const pep621 = pyproject.match(/^dependencies\s*=\s*\[([\s\S]*?)\]/m)?.[1];
      if (pep621 !== undefined) {
        for (const entry of pep621.split(",")) {
          const name = entry.trim().replace(/^["']|["']$/g, "").split(/[<>=!~[;\s]/)[0];
          if (name) deps.push(name);
        }
      }
      const poetryDeps = extractTomlTableKeys(pyproject, "tool.poetry.dependencies");
      deps.push(...poetryDeps.filter((k) => k !== "python"));
      if (poetryDeps.length > 0) packageManager = "poetry";
      if (/\btool\.uv\b|\[tool\.uv\]/.test(pyproject)) packageManager = packageManager ?? "uv";
      if (/\[\s*build-system\s*\]/.test(pyproject) && packageManager === undefined) packageManager = "pep-621";
    }

    if (requirements !== undefined) {
      for (const line of requirements.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed.length === 0 || trimmed.startsWith("#") || trimmed.startsWith("-")) continue;
        const name = trimmed.split(/[<>=!~[;\s]/)[0];
        if (name) deps.push(name);
      }
      if (packageManager === undefined) packageManager = "pip";
    }

    const pyDeps = unique(deps.map((d) => d.toLowerCase()));
    ecosystems.push({
      ecosystem: "python",
      manifest: pyproject !== undefined ? "pyproject.toml" : "requirements.txt",
      packageManager,
      dependencyCount: pyDeps.length,
      dependencies: pyDeps.slice(0, MAX_DEPENDENCIES_REPORTED),
    });

    for (const rule of PYTHON_FRAMEWORKS) {
      const hit = pyDeps.find((dep) => rule.packages.includes(dep));
      if (hit !== undefined) addFramework(rule, `python dependency "${hit}"`);
    }
  }

  /* --- ecosystem: Rust ---------------------------------------------------- */
  const cargoPath = path.join(workspace, "Cargo.toml");
  const cargo = readTextIfExists(cargoPath);
  if (cargo !== undefined) {
    scannedFiles.push("Cargo.toml");
    signals.add("rust");
    addStack("rust", "Rust", "Cargo.toml");
    const cargoDeps = unique([
      ...extractTomlTableKeys(cargo, "dependencies"),
      ...extractTomlTableKeys(cargo, "dev-dependencies"),
      ...extractTomlTableKeys(cargo, "build-dependencies"),
    ]);
    ecosystems.push({
      ecosystem: "rust",
      manifest: "Cargo.toml",
      dependencyCount: cargoDeps.length,
      dependencies: cargoDeps.slice(0, MAX_DEPENDENCIES_REPORTED),
    });
    for (const rule of RUST_FRAMEWORKS) {
      const hit = cargoDeps.find((dep) => rule.packages.includes(dep));
      if (hit !== undefined) addFramework(rule, `Cargo.toml dependency "${hit}"`);
    }
  }

  /* --- ecosystem: Go ------------------------------------------------------ */
  const gomodPath = path.join(workspace, "go.mod");
  const gomod = readTextIfExists(gomodPath);
  if (gomod !== undefined) {
    scannedFiles.push("go.mod");
    signals.add("go");
    addStack("go", "Go", "go.mod");
    const goDeps = extractGoRequires(gomod);
    ecosystems.push({
      ecosystem: "go",
      manifest: "go.mod",
      dependencyCount: goDeps.length,
      dependencies: goDeps.slice(0, MAX_DEPENDENCIES_REPORTED),
    });
    for (const rule of GO_FRAMEWORKS) {
      const hit = goDeps.find((dep) => rule.packages.includes(dep));
      if (hit !== undefined) addFramework(rule, `go.mod module "${hit}"`);
    }
  }

  /* --- cross-cutting infrastructure signals ------------------------------- */
  if (globAnyExists(workspace, ["Dockerfile", "Dockerfile.*", "docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml", "*.Dockerfile"])) {
    signals.add("docker");
    addStack("docker", "Docker", "Dockerfile / compose manifest");
  }
  if (fs.existsSync(path.join(workspace, ".github", "workflows"))) {
    signals.add("ci-cd");
    addStack("ci-cd", "CI/CD", ".github/workflows");
  }
  if (fs.existsSync(path.join(workspace, "opencode.json")) || fs.existsSync(path.join(workspace, "opencode.jsonc"))) {
    addStack("opencode", "OpenCode", "opencode.json present");
  }
  if (fs.existsSync(path.join(workspace, "AGENTS.md"))) addStack("agents-md", "AGENTS.md", "AGENTS.md present");

  /* --- existing OpenCode assets ------------------------------------------ */
  const opencodeDir = path.join(workspace, ".opencode");
  const skillsDir = path.join(opencodeDir, "skills");
  const existing: {
    opencodeConfig: boolean;
    opencodeConfigPath?: string;
    opencodeMcpServers: string[];
    globalMcpServers: string[];
    installedSkills: string[];
    agentFiles: string[];
  } = {
    opencodeConfig: false,
    opencodeMcpServers: [],
    globalMcpServers: [],
    installedSkills: [],
    agentFiles: [],
  };

  const configCandidates = ["opencode.json", "opencode.jsonc"];
  for (const candidate of configCandidates) {
    const configPath = path.join(workspace, candidate);
    if (!fs.existsSync(configPath)) continue;
    existing.opencodeConfig = true;
    existing.opencodeConfigPath = configPath;
    const config = readJsonIfExists<{ mcp?: Record<string, unknown> }>(configPath);
    existing.opencodeMcpServers = config?.mcp ? Object.keys(config.mcp) : [];
    break;
  }

  const globalConfig = readJsonIfExists<{ mcp?: Record<string, unknown> }>(
    path.join(os.homedir(), ".config", "opencode", "opencode.json"),
  );
  if (globalConfig?.mcp !== undefined) existing.globalMcpServers = Object.keys(globalConfig.mcp);

  if (fs.existsSync(skillsDir)) {
    try {
      existing.installedSkills = fs
        .readdirSync(skillsDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .slice(0, 100);
    } catch (e) {
      log(`failed listing skills directory: ${errorMessage(e)}`);
    }
  }

  for (const [relDir, key] of [
    ["agent", "agentFiles"],
    ["agents", "agentFiles"],
  ] as const) {
    const dir = path.join(opencodeDir, relDir);
    if (!fs.existsSync(dir)) continue;
    try {
      const names = fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
        .map((entry) => entry.name);
      existing[key] = unique([...existing[key], ...names]);
    } catch {
      /* non-fatal */
    }
  }

  /* --- derive needs ------------------------------------------------------- */
  const needs: ProjectNeed[] = NEED_RULES.filter((rule) => rule.signals.some((s) => signals.has(s)))
    .map((rule) => ({
      ...rule,
      triggeredBy: frameworks.filter((f) => rule.signals.includes(f.id)).map((f) => f.label),
    }))
    .sort((a, b) => {
      const order = { high: 0, medium: 1, low: 2 } as const;
      return order[a.priority] - order[b.priority];
    });

  if (stacks.length === 0) {
    needs.push({
      id: "unknown-project",
      title: "Unrecognised project layout",
      priority: "medium",
      reason:
        "No recognised manifest (package.json, Cargo.toml, pyproject.toml, go.mod, requirements.txt) was found. Describe the stack to a general-purpose agent.",
      suggestedSkill: "project-onboarding",
      suggestedAgent: "generalist",
      searchQuery: "onboarding skill",
      triggeredBy: [],
    });
  }

  const analysis = {
    workspacePath: workspace,
    scannedFiles,
    stacks,
    frameworks,
    ecosystems,
    needs,
    opencodeAssets: existing,
    summary: {
      primaryStack: stacks[0]?.label ?? "unknown",
      stackCount: stacks.length,
      frameworkCount: frameworks.length,
      highPriorityNeedCount: needs.filter((n) => n.priority === "high").length,
      nextActions: needs.slice(0, 3).map((n) => `search_skills_and_agents(query: ${JSON.stringify(n.searchQuery)})`),
    },
  };

  const text = renderAnalysisText(analysis);
  return { text, analysis };
}

function globAnyExists(dir: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    try {
      if (pattern.includes("*")) {
        // Simple suffix/prefix wildcard expansion for the shallow patterns we use.
        const matches = fs.readdirSync(dir).some((name) => {
          if (pattern.startsWith("*.")) return name.endsWith(pattern.slice(1));
          if (pattern.endsWith(".*")) return name.startsWith(pattern.slice(0, -1));
          return name === pattern;
        });
        if (matches) return true;
      } else if (fs.existsSync(path.join(dir, pattern))) {
        return true;
      }
    } catch {
      /* unreadable directory — treat as not found */
    }
  }
  return false;
}

function renderAnalysisText(a: {
  workspacePath: string;
  scannedFiles: string[];
  stacks: Detected[];
  frameworks: Detected[];
  ecosystems: EcosystemReport[];
  needs: ProjectNeed[];
  opencodeAssets: {
    opencodeConfig: boolean;
    opencodeMcpServers: string[];
    globalMcpServers: string[];
    installedSkills: string[];
    agentFiles: string[];
  };
  summary: { primaryStack: string; nextActions: string[] };
}): string {
  const lines: string[] = [];
  lines.push(`# Project analysis: ${a.workspacePath}`);
  lines.push("");
  lines.push(`Primary stack: ${a.summary.primaryStack}`);
  lines.push(`Manifests scanned: ${a.scannedFiles.length > 0 ? a.scannedFiles.join(", ") : "none"}`);
  lines.push("");

  lines.push("## Stacks");
  if (a.stacks.length === 0) lines.push("- (none detected)");
  for (const s of a.stacks) lines.push(`- ${s.label} — ${s.evidence.join("; ")}`);
  lines.push("");

  lines.push("## Frameworks & libraries");
  if (a.frameworks.length === 0) lines.push("- (none detected)");
  for (const f of a.frameworks) lines.push(`- ${f.label} — ${f.evidence.join("; ")}`);
  lines.push("");

  lines.push("## Dependencies");
  for (const e of a.ecosystems) {
    const pm = e.packageManager === undefined ? "" : ` (${e.packageManager})`;
    lines.push(`- ${e.manifest}${pm}: ${e.dependencyCount} dependencies`);
    if (e.dependencies.length > 0) lines.push(`  ${e.dependencies.join(", ")}`);
  }
  if (a.ecosystems.length === 0) lines.push("- (no dependency manifest found)");
  lines.push("");

  lines.push("## Recommended skills & agents");
  if (a.needs.length === 0) lines.push("- Nothing specialised required; the project looks self-contained.");
  for (const n of a.needs) {
    lines.push(`- [${n.priority.toUpperCase()}] ${n.title}`);
    lines.push(`    why: ${n.reason}`);
    lines.push(`    skill: ${n.suggestedSkill} | agent: ${n.suggestedAgent}`);
    if (n.triggeredBy.length > 0) lines.push(`    triggered by: ${n.triggeredBy.join(", ")}`);
    lines.push(`    search: search_skills_and_agents(query: ${JSON.stringify(n.searchQuery)})`);
  }
  lines.push("");

  lines.push("## Existing OpenCode assets");
  lines.push(`- opencode.json: ${a.opencodeAssets.opencodeConfig ? "present" : "missing"}`);
  lines.push(`- project MCP servers: ${a.opencodeAssets.opencodeMcpServers.join(", ") || "(none)"}`);
  lines.push(`- global MCP servers: ${a.opencodeAssets.globalMcpServers.join(", ") || "(none)"}`);
  lines.push(`- installed skills: ${a.opencodeAssets.installedSkills.join(", ") || "(none)"}`);
  lines.push(`- agent files: ${a.opencodeAssets.agentFiles.join(", ") || "(none)"}`);
  lines.push("");

  if (a.summary.nextActions.length > 0) {
    lines.push("## Suggested next steps");
    for (const action of a.summary.nextActions) lines.push(`- ${action}`);
  }
  return lines.join("\n");
}

/* -------------------------------------------------------------------------- */
/* Tool 2: search_skills_and_agents                                           */
/* -------------------------------------------------------------------------- */

/**
 * A single search result.
 *
 * `verified` is the important one: GitHub *code search* proves a real file exists at
 * `path`, whereas a *repository search* only proves the repository is topical. We never
 * emit a `downloadUrl` for an unverified hit, because a guessed `SKILL.md` path is
 * almost always a 404 and would send the agent chasing a dead link.
 */
interface SearchHit {
  type: "skill" | "mcp-server";
  name: string;
  fullName: string;
  owner: string;
  repo: string;
  branch: string;
  path?: string;
  htmlUrl: string;
  downloadUrl?: string;
  description?: string;
  stargazers: number;
  updatedAt?: string;
  source: "code-search" | "repo-search";
  verified: boolean;
}

let cachedOctokit: Octokit | null = null;
function getOctokit(): Octokit {
  if (cachedOctokit === null) {
    const token = githubToken();
    cachedOctokit = new Octokit(token === undefined ? {} : { auth: token, userAgent: `${SERVER_NAME}/${SERVER_VERSION}` });
  }
  return cachedOctokit;
}

/** Split `https://github.com/owner/repo/blob/main/a/b/SKILL.md` into its parts. */
function parseGitHubFileUrl(htmlUrl: string): { owner: string; repo: string; branch: string; filePath: string } | undefined {
  const match = htmlUrl.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)$/);
  if (match?.[1] === undefined || match[2] === undefined || match[3] === undefined || match[4] === undefined) {
    return undefined;
  }
  return {
    owner: match[1],
    repo: match[2],
    branch: match[3],
    filePath: match[4],
  };
}

function toRawUrl(owner: string, repo: string, branch: string, filePath: string): string {
  const encodedPath = filePath
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `https://raw.githubusercontent.com/${owner}/${repo}/${encodeURIComponent(branch)}/${encodedPath}`;
}

function isGitHubUrl(url: string): boolean {
  return /^https:\/\/(raw\.githubusercontent\.com|github\.com|api\.github\.com)\//.test(url);
}

function githubRequestHeaders(url: string): Record<string, string> {
  const headers: Record<string, string> = {
    "User-Agent": `${SERVER_NAME}/${SERVER_VERSION}`,
    Accept: "text/plain, text/markdown, */*;q=0.8",
  };
  // Only ever hand the token to GitHub — never leak it to an arbitrary sourceUrl host.
  const token = githubToken();
  if (token !== undefined && isGitHubUrl(url)) headers.Authorization = `Bearer ${token}`;
  return headers;
}

/**
 * Confirm a raw URL resolves, without downloading the body. This is what stops us
 * from handing the agent a plausible-looking but dead download link.
 */
async function rawUrlExists(url: string): Promise<boolean> {
  try {
    await axios.head(url, {
      headers: githubRequestHeaders(url),
      timeout: 10_000,
      maxRedirects: 5,
      validateStatus: (status) => status >= 200 && status < 300,
    });
    return true;
  } catch (e) {
    log(`existence probe failed for ${url}: ${errorMessage(e)}`);
    return false;
  }
}

/** Look for a `SKILL.md` inside one of the conventional skill directories. */
async function findSkillInDir(
  octokit: Octokit,
  owner: string,
  repo: string,
  ref: string,
  dir: string,
): Promise<string | undefined> {
  try {
    const res = await octokit.repos.getContent({ owner, repo, path: dir, ref });
    if (!Array.isArray(res.data)) return undefined;
    const file = res.data.find((entry) => entry.type === "file" && entry.name === "SKILL.md");
    return file === undefined ? undefined : `${dir}/${file.name}`;
  } catch {
    return undefined; // 404 simply means "no skills directory here"
  }
}

async function searchSkillsAndAgents(args: Record<string, unknown>): Promise<unknown> {
  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (query.length === 0) throw new Error("`query` is required and must be a non-empty string.");

  const searchType = args.searchType === undefined ? "all" : args.searchType;
  if (searchType !== "skill" && searchType !== "mcp-server" && searchType !== "all") {
    throw new Error('`searchType` must be one of "skill", "mcp-server" or "all".');
  }

  const limitRaw = args.limit;
  const limit =
    typeof limitRaw === "number" && Number.isFinite(limitRaw)
      ? Math.min(30, Math.max(1, Math.trunc(limitRaw)))
      : 10;

  const octokit = getOctokit();
  const hasToken = githubToken() !== undefined;
  const warnings: string[] = [];
  const hits: SearchHit[] = [];

  const wantsSkills = searchType === "skill" || searchType === "all";
  const wantsMcp = searchType === "mcp-server" || searchType === "all";

  /* --- code search for SKILL.md files ------------------------------------- */
  if (wantsSkills) {
    if (!hasToken) {
      warnings.push(
        "GITHUB_TOKEN is not set; the GitHub code-search API requires authentication, so only repository search was used. Set GITHUB_TOKEN to discover actual SKILL.md files.",
      );
    } else {
      try {
        const res = await octokit.search.code({
          q: `filename:SKILL.md ${query}`,
          per_page: Math.min(100, Math.max(limit * 2, 10)),
        });
        for (const item of res.data.items ?? []) {
          const parsed = parseGitHubFileUrl(item.html_url);
          if (parsed === undefined) continue;
          const segments = parsed.filePath.split("/");
          // `.claude/skills/<name>/SKILL.md` → derive the skill name from its folder.
          const folder = segments.at(-2) ?? parsed.repo;
          const skillName = folder === "skills" || folder.length === 0 ? (segments.at(-3) ?? folder) : folder;
          hits.push({
            type: "skill",
            name: skillName,
            fullName: `${parsed.owner}/${parsed.repo}`,
            owner: parsed.owner,
            repo: parsed.repo,
            branch: parsed.branch,
            path: parsed.filePath,
            htmlUrl: item.html_url,
            downloadUrl: toRawUrl(parsed.owner, parsed.repo, parsed.branch, parsed.filePath),
            stargazers: 0,
            source: "code-search",
            verified: true,
          });
        }
      } catch (e) {
        const message = errorMessage(e);
        warnings.push(`SKILL.md code search failed: ${message}`);
        if (/rate limit/i.test(message)) {
          warnings.push("GitHub rate limit reached — results may be incomplete.");
        }
      }
    }
  }

  /* --- code search for MCP server configurations -------------------------- */
  if (wantsMcp) {
    if (!hasToken) {
      warnings.push("GITHUB_TOKEN is not set; skipping MCP code search (authentication required).");
    } else {
      try {
        const res = await octokit.search.code({
          q: `"mcpServers" ${query}`,
          per_page: Math.min(100, Math.max(limit * 2, 10)),
        });
        for (const item of res.data.items ?? []) {
          const parsed = parseGitHubFileUrl(item.html_url);
          if (parsed === undefined) continue;
          hits.push({
            type: "mcp-server",
            name: `${parsed.repo}-${parsed.filePath.split("/").pop()?.replace(/\.jsonc?$/, "") ?? "config"}`,
            fullName: `${parsed.owner}/${parsed.repo}`,
            owner: parsed.owner,
            repo: parsed.repo,
            branch: parsed.branch,
            path: parsed.filePath,
            htmlUrl: item.html_url,
            downloadUrl: toRawUrl(parsed.owner, parsed.repo, parsed.branch, parsed.filePath),
            stargazers: 0,
            source: "code-search",
            verified: true,
          });
        }
      } catch (e) {
        warnings.push(`MCP code search failed: ${errorMessage(e)}`);
      }
    }
  }

  /* --- repository search (always available, boosts ranking) ---------------- */
  const repoQueries: string[] = [];
  if (wantsSkills) {
    repoQueries.push(`${query} skill in:name,description,readme`);
    repoQueries.push(`${query} "SKILL.md" in:name,description`);
  }
  if (wantsMcp) {
    repoQueries.push(`${query} mcp-server in:name,description,readme`);
    repoQueries.push(`mcp ${query} in:name,description`);
  }

  for (const repoQuery of repoQueries.slice(0, 4)) {
    try {
      const res = await octokit.search.repos({
        q: repoQuery,
        sort: "stars",
        order: "desc",
        per_page: Math.min(30, Math.max(limit, 5)),
      });
      for (const item of res.data.items ?? []) {
        const existing = hits.find((h) => h.fullName === item.full_name && h.type === "mcp-server");
        if (existing !== undefined) {
          existing.stargazers = item.stargazers_count;
          existing.description = item.description ?? undefined;
          continue;
        }

        const type: SearchHit["type"] = /mcp/i.test(`${item.name} ${item.description ?? ""}`) ? "mcp-server" : "skill";
        if (type === "mcp-server" && !wantsMcp) continue;
        if (type === "skill" && !wantsSkills) continue;

        hits.push({
          type,
          name: item.name,
          fullName: item.full_name,
          owner: item.owner?.login ?? item.full_name.split("/")[0] ?? "unknown",
          repo: item.name,
          branch: "", // resolved lazily below
          htmlUrl: item.html_url,
          description: item.description ?? undefined,
          stargazers: item.stargazers_count,
          updatedAt: item.updated_at,
          source: "repo-search",
          // A topical repository is not evidence that it ships a SKILL.md. Leave
          // `path`/`downloadUrl` unset until the existence check below confirms it.
          verified: false,
        });
      }
    } catch (e) {
      const message = errorMessage(e);
      warnings.push(`repository search failed for ${JSON.stringify(repoQuery)}: ${message}`);
      if (/rate limit/i.test(message)) break;
    }
  }

  /* --- enrich hits with repository metadata -------------------------------- */
  // Code search returns no star counts and no descriptions, which would let a
  // high-star but irrelevant repository outrank a genuine SKILL.md. Fill them in.
  const repoCache = new Map<string, { defaultBranch: string; description?: string; stargazers: number; updatedAt?: string }>();
  const needMetadata = unique(hits.map((h) => h.fullName))
    .filter((fullName) => !repoCache.has(fullName))
    .slice(0, MAX_REPO_LOOKUPS);

  for (const fullName of needMetadata) {
    const [owner, repo] = fullName.split("/");
    if (owner === undefined || repo === undefined) continue;
    try {
      const res = await octokit.repos.get({ owner, repo });
      repoCache.set(fullName, {
        defaultBranch: res.data.default_branch,
        description: res.data.description ?? undefined,
        stargazers: res.data.stargazers_count,
        updatedAt: res.data.updated_at ?? undefined,
      });
    } catch (e) {
      warnings.push(`could not read metadata for ${fullName}: ${errorMessage(e)}`);
    }
  }

  for (const hit of hits) {
    const meta = repoCache.get(hit.fullName);
    if (meta === undefined) {
      if (hit.branch === "") hit.branch = "main";
      continue;
    }
    hit.stargazers = meta.stargazers;
    hit.description = hit.description ?? meta.description;
    hit.updatedAt = hit.updatedAt ?? meta.updatedAt;
    if (hit.branch === "") hit.branch = meta.defaultBranch;
  }

  /* --- verify that repo-search hits really contain a skill file ------------- */
  // A topical repository is not the same thing as a repository that ships a
  // SKILL.md. Before handing a URL to the agent we confirm the file exists;
  // otherwise we would be manufacturing links that are guaranteed to 404.
  let verifiedCount = hits.filter((h) => h.verified).length;
  let unverifiedCount = 0;
  const skillCandidates = hits.filter((h) => !h.verified && h.type === "skill" && h.branch !== "");
  let nestedBudget = hasToken ? MAX_NESTED_SKILL_PROBES : 0;

  for (const hit of skillCandidates.slice(0, MAX_SKILL_FILE_PROBES)) {
    if (await rawUrlExists(toRawUrl(hit.owner, hit.repo, hit.branch, "SKILL.md"))) {
      hit.path = "SKILL.md";
      hit.downloadUrl = toRawUrl(hit.owner, hit.repo, hit.branch, "SKILL.md");
      hit.verified = true;
      verifiedCount++;
      continue;
    }

    // Nested layouts (.claude/skills/<name>/SKILL.md) need a directory listing,
    // which costs API quota — only do it when we have a token and spare budget.
    if (nestedBudget > 0) {
      nestedBudget--;
      for (const dir of KNOWN_SKILL_DIRS) {
        const found = await findSkillInDir(octokit, hit.owner, hit.repo, hit.branch, dir);
        if (found !== undefined) {
          hit.path = found;
          hit.downloadUrl = toRawUrl(hit.owner, hit.repo, hit.branch, found);
          hit.verified = true;
          verifiedCount++;
          break;
        }
      }
      if (hit.verified) continue;
    }
    unverifiedCount++;
  }

  if (unverifiedCount > 0) {
    warnings.push(
      `${unverifiedCount} candidate repository/repositories are topical but do not contain a SKILL.md at a conventional location; they are listed without a download URL. Set GITHUB_TOKEN to search code directly for SKILL.md files.`,
    );
  }

  /* --- rank & dedupe ------------------------------------------------------ */
  const seen = new Set<string>();
  const ranked = hits
    .filter((hit) => {
      const key = `${hit.type}:${hit.fullName}:${hit.path ?? ""}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => score(b) - score(a))
    .slice(0, limit);

  function score(hit: SearchHit): number {
    // A confirmed SKILL.md is exactly what the caller asked for, so it must
    // outrank popularity. Star count is capped and only breaks ties.
    let value = hit.verified ? 1000 : 0;
    value += Math.min(20, Math.log10(hit.stargazers + 1) * 6);
    if (hit.type === "skill") value += 5;
    if (hit.updatedAt !== undefined) {
      const ageDays = (Date.now() - Date.parse(hit.updatedAt)) / 86_400_000;
      if (Number.isFinite(ageDays)) value += Math.max(0, 5 - ageDays / 90);
    }
    return value;
  }

  const result = {
    query,
    searchType,
    limit,
    authenticated: hasToken,
    totalFound: hits.length,
    verifiedSkillFiles: verifiedCount,
    returned: ranked.length,
    warnings: unique(warnings),
    results: ranked,
  };

  const lines: string[] = [];
  lines.push(`# GitHub search for "${query}" (${searchType})`);
  lines.push(`Authenticated: ${hasToken ? "yes" : "no (code search unavailable)"}`);
  lines.push(`Found ${result.totalFound} candidate(s), returning top ${result.returned}.`);
  lines.push(`Verified skill files: ${verifiedCount}.`);
  if (result.warnings.length > 0) {
    lines.push("");
    lines.push("## Warnings");
    for (const w of result.warnings) lines.push(`- ${w}`);
  }
  lines.push("");
  if (ranked.length === 0) {
    lines.push("No matches. Try a broader query, or create the skill yourself with install_skill_or_agent.");
  }
  for (const [i, hit] of ranked.entries()) {
    lines.push("");
    lines.push(`## ${i + 1}. ${hit.name} (${hit.type})`);
    lines.push(`- repo: ${hit.fullName} — ${hit.stargazers} stars`);
    if (hit.description !== undefined) lines.push(`- description: ${hit.description}`);
    if (hit.path !== undefined) lines.push(`- path: ${hit.path}`);
    lines.push(`- html: ${hit.htmlUrl}`);
    if (hit.downloadUrl !== undefined) lines.push(`- raw download: ${hit.downloadUrl}`);
    lines.push(`- found via: ${hit.source}`);
    if (hit.verified) {
      lines.push(
        `- install: install_skill_or_agent({ workspacePath: "<workspace>", itemType: ${JSON.stringify(
          hit.type,
        )}, name: ${JSON.stringify(hit.name)}, sourceUrl: ${JSON.stringify(hit.downloadUrl)} })`,
      );
    } else {
      // No verified file — point the agent at the repo rather than a guessed path.
      lines.push(
        hit.type === "skill"
          ? `- no SKILL.md found here; open ${hit.htmlUrl} and locate the skill file before installing`
          : `- no MCP config file located; open ${hit.htmlUrl} and identify the server entry, then call install_skill_or_agent with an explicit mcpConfig`,
      );
    }
  }

  return { text: lines.join("\n"), result };
}

/* -------------------------------------------------------------------------- */
/* Tool 3: install_skill_or_agent                                              */
/* -------------------------------------------------------------------------- */

function toRawDownloadUrl(url: string): string {
  const parsed = parseGitHubFileUrl(url);
  if (parsed !== undefined) return toRawUrl(parsed.owner, parsed.repo, parsed.branch, parsed.filePath);

  // api.github.com/repos/:owner/:repo/contents/:path?ref=:branch
  const apiMatch = url.match(
    /^https?:\/\/api\.github\.com\/repos\/([^/]+)\/([^/]+)\/contents\/(.+?)(?:\?ref=([^&]+))?$/,
  );
  if (apiMatch?.[1] !== undefined && apiMatch[2] !== undefined && apiMatch[3] !== undefined) {
    return toRawUrl(apiMatch[1], apiMatch[2], apiMatch[4] ?? "HEAD", apiMatch[3]);
  }
  return url;
}

async function fetchRemoteText(url: string): Promise<{ content: string; finalUrl: string; contentType?: string }> {
  const rawUrl = toRawDownloadUrl(url);
  const headers = githubRequestHeaders(rawUrl);

  const response = await axios.get<string>(rawUrl, {
    headers,
    responseType: "text",
    transformResponse: [(data: unknown) => (typeof data === "string" ? data : String(data))],
    maxContentLength: MAX_REMOTE_BYTES,
    maxBodyLength: MAX_REMOTE_BYTES,
    timeout: 20_000,
    maxRedirects: 5,
    validateStatus: (status) => status >= 200 && status < 300,
  });

  const content = typeof response.data === "string" ? response.data : String(response.data ?? "");
  return {
    content,
    finalUrl: typeof response.request?.res?.responseUrl === "string" ? response.request.res.responseUrl : rawUrl,
    contentType: String(response.headers?.["content-type"] ?? ""),
  };
}

function assertLooksLikeSkillMarkdown(content: string, source: string): void {
  if (content.trim().length === 0) {
    throw new Error(`Downloaded content from ${source} was empty.`);
  }
  if (/^\s*<(!doctype|html)[\s>]/i.test(content) || content.includes("<title>")) {
    throw new Error(`Downloaded content from ${source} looks like an HTML page, not a SKILL.md file.`);
  }
  if (/^\s*404:?\s*Not Found\s*$/m.test(content)) {
    throw new Error(`GitHub returned "404: Not Found" for ${source} — the file or branch does not exist.`);
  }
}

function buildSkillBoilerplate(name: string, sourceUrl?: string): string {
  const displayName = titleCase(name);
  return `---
name: ${displayName}
description: TODO — describe precisely when an agent should load this skill (what it does and when to use it).
---

# ${displayName}

## Purpose

TODO — explain what this skill covers and which part of the codebase it applies to.

## When to use

TODO — list the concrete situations that should trigger this skill. Keep it specific;
the description above is what the agent matches against.

## Instructions

1. TODO — first step.
2. TODO — second step.
3. TODO — third step.

## Conventions

- TODO — code style rules this skill enforces.
- TODO — naming, file layout, or API rules.
- TODO — anti-patterns to avoid.

## Validation

- TODO — how to verify the work is correct (commands, checks, review steps).

## References

${
  sourceUrl === undefined
    ? "- TODO — link the upstream docs, RFC, or design doc."
    : `- Source: ${sourceUrl}`
}
`;
}

interface InstallResult {
  action: "skill" | "mcp-server";
  name: string;
  workspacePath: string;
  targetPath?: string;
  contentSource: "remote" | "boilerplate" | "inline";
  sourceUrl?: string;
  bytesWritten: number;
  overwritten: boolean;
  opencodeConfigPath?: string;
  nextActions: string[];
}

async function installSkillOrAgent(args: Record<string, unknown>): Promise<unknown> {
  const workspace = resolveWorkspace(args.workspacePath);
  const itemType = args.itemType;
  if (itemType !== "skill" && itemType !== "mcp-server") {
    throw new Error('`itemType` must be either "skill" or "mcp-server".');
  }
  const name = assertSafeName(args.name);

  if (itemType === "skill") {
    return installSkill(workspace, name, args.sourceUrl);
  }
  return installMcpServer(workspace, name, args.mcpConfig);
}

async function installSkill(workspace: string, name: string, sourceUrlRaw: unknown): Promise<unknown> {
  if (sourceUrlRaw !== undefined && typeof sourceUrlRaw !== "string") {
    throw new Error("`sourceUrl` must be a string when provided.");
  }
  const sourceUrl = typeof sourceUrlRaw === "string" ? sourceUrlRaw.trim() : undefined;
  if (sourceUrl !== undefined && sourceUrl.length > 0 && !/^https?:\/\//i.test(sourceUrl)) {
    throw new Error(`\`sourceUrl\` must be an http(s) URL (got: ${JSON.stringify(sourceUrl)}).`);
  }

  const skillsRoot = path.join(workspace, ".opencode", "skills");
  const targetDir = path.join(skillsRoot, name);
  const targetFile = path.join(targetDir, "SKILL.md");

  // Defence in depth: the resolved path must stay inside the skills root.
  const relative = path.relative(skillsRoot, targetFile);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Refusing to write outside the skills directory: ${targetFile}`);
  }

  let content: string;
  let contentSource: InstallResult["contentSource"];

  if (sourceUrl !== undefined && sourceUrl.length > 0) {
    log(`fetching SKILL.md for "${name}" from ${sourceUrl}`);
    const fetched = await fetchRemoteText(sourceUrl);
    assertLooksLikeSkillMarkdown(fetched.content, sourceUrl);
    content = fetched.content.endsWith("\n") ? fetched.content : `${fetched.content}\n`;
    contentSource = "remote";
  } else {
    log(`no sourceUrl supplied; generating boilerplate SKILL.md for "${name}"`);
    content = buildSkillBoilerplate(name, sourceUrl);
    contentSource = "boilerplate";
  }

  const existed = fs.existsSync(targetFile);

  try {
    ensureDirSafe(targetDir);
    fs.writeFileSync(targetFile, content, "utf8");
  } catch (e) {
    throw new Error(`Failed to write ${targetFile}: ${errorMessage(e)}`);
  }

  const result: InstallResult = {
    action: "skill",
    name,
    workspacePath: workspace,
    targetPath: targetFile,
    contentSource,
    sourceUrl,
    bytesWritten: Buffer.byteLength(content, "utf8"),
    overwritten: existed,
    nextActions: [
      `Edit the frontmatter \`description\` in ${targetFile} so agents know when to load it.`,
      "Restart/reload your OpenCode session so the new skill is discovered.",
    ],
  };

  const text = [
    `Installed skill "${name}".`,
    `  path:     ${targetFile}`,
    `  source:   ${contentSource}${sourceUrl === undefined ? "" : ` (${sourceUrl})`}`,
    `  bytes:    ${result.bytesWritten}`,
    `  existing: ${existed ? "yes — file was overwritten" : "no — newly created"}`,
    "",
    ...result.nextActions.map((a) => `- ${a}`),
  ].join("\n");

  return { text, result };
}

function buildDefaultMcpConfig(name: string): Record<string, unknown> {
  return {
    type: "local",
    command: ["npx", "-y", name],
    enabled: true,
  };
}

async function installMcpServer(workspace: string, name: string, mcpConfigRaw: unknown): Promise<unknown> {
  let mcpConfig: Record<string, unknown>;
  if (mcpConfigRaw === undefined || mcpConfigRaw === null) {
    log(`no mcpConfig supplied for "${name}"; using a placeholder local command`);
    mcpConfig = buildDefaultMcpConfig(name);
  } else if (typeof mcpConfigRaw === "object" && !Array.isArray(mcpConfigRaw)) {
    mcpConfig = mcpConfigRaw as Record<string, unknown>;
  } else {
    throw new Error("`mcpConfig` must be an object when provided.");
  }

  if (mcpConfig.command !== undefined && !Array.isArray(mcpConfig.command)) {
    throw new Error('`mcpConfig.command` must be an array of strings for a local MCP server.');
  }
  if (Array.isArray(mcpConfig.command) && mcpConfig.command.some((part) => typeof part !== "string")) {
    throw new Error('`mcpConfig.command` must contain only strings.');
  }
  if (mcpConfig.command === undefined && mcpConfig.url === undefined) {
    log(`mcpConfig for "${name}" has neither "command" nor "url"; adding a placeholder local command`);
    mcpConfig = { ...mcpConfig, ...buildDefaultMcpConfig(name) };
  }

  const configPath = path.join(workspace, "opencode.json");
  const created = !fs.existsSync(configPath);

  let config: Record<string, unknown> = {};
  if (!created) {
    const raw = fs.readFileSync(configPath, "utf8");
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error("top-level value is not a JSON object");
      }
      config = parsed as Record<string, unknown>;
    } catch (e) {
      throw new Error(
        `${configPath} is not valid JSON (${errorMessage(e)}). Fix or remove it and retry — refusing to overwrite your configuration.`,
      );
    }
  } else {
    config.$schema = "https://opencode.ai/config.json";
  }

  const existingMcp =
    typeof config.mcp === "object" && config.mcp !== null && !Array.isArray(config.mcp)
      ? (config.mcp as Record<string, unknown>)
      : {};
  if (config.mcp !== undefined && (typeof config.mcp !== "object" || config.mcp === null || Array.isArray(config.mcp))) {
    throw new Error(`The existing "mcp" key in ${configPath} is not an object; refusing to overwrite it.`);
  }

  const overwrittenEntry = Object.prototype.hasOwnProperty.call(existingMcp, name);
  existingMcp[name] = mcpConfig;
  config.mcp = existingMcp;

  const serialized = `${JSON.stringify(config, null, 2)}\n`;

  try {
    ensureDirSafe(workspace);
    fs.writeFileSync(configPath, serialized, "utf8");
  } catch (e) {
    throw new Error(`Failed to write ${configPath}: ${errorMessage(e)}`);
  }

  const result: InstallResult = {
    action: "mcp-server",
    name,
    workspacePath: workspace,
    opencodeConfigPath: configPath,
    contentSource: "inline",
    bytesWritten: Buffer.byteLength(serialized, "utf8"),
    overwritten: overwrittenEntry,
    nextActions: [
      `Verify the "${name}" entry in ${configPath} (command, env vars and args).`,
      "Restart OpenCode so the new MCP server is connected.",
    ],
  };

  const text = [
    `Registered MCP server "${name}".`,
    `  config:   ${configPath}${created ? " (created)" : " (updated)"}`,
    `  entry:    mcp.${name}`,
    `  existing: ${overwrittenEntry ? "yes — previous entry was replaced" : "no — new entry"}`,
    "",
    "Registered configuration:",
    JSON.stringify({ mcp: { [name]: mcpConfig } }, null, 2),
    "",
    ...result.nextActions.map((a) => `- ${a}`),
  ].join("\n");

  return { text, result };
}

/* -------------------------------------------------------------------------- */
/* Tool wiring                                                                 */
/* -------------------------------------------------------------------------- */

const TOOL_DEFINITIONS = [
  {
    name: "analyze_project_needs",
    description:
      "Scan a workspace's dependency manifests (package.json, Cargo.toml, pyproject.toml, go.mod, requirements.txt) and configuration files, then report the detected stacks, frameworks and dependencies along with the specialised skills and agents the project is likely to need. Call this first, before searching or installing anything.",
    inputSchema: {
      type: "object",
      properties: {
        workspacePath: {
          type: "string",
          description: "Absolute path (or path relative to the home directory) of the project to analyze.",
        },
      },
      required: ["workspacePath"],
      additionalProperties: false,
    },
  },
  {
    name: "search_skills_and_agents",
    description:
      "Search GitHub for reusable OpenCode/Claude skills (SKILL.md files) and MCP server configurations matching a query. Returns repository, file path and a raw download URL for each match. Set GITHUB_TOKEN in the server environment to enable code search (required for finding actual SKILL.md files).",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: 'Free-text search query, e.g. "prisma migrations" or "playwright e2e".',
        },
        searchType: {
          type: "string",
          enum: ["skill", "mcp-server", "all"],
          default: "all",
          description: "Restrict the search to skills, MCP servers, or both.",
        },
        limit: {
          type: "number",
          minimum: 1,
          maximum: 30,
          default: 10,
          description: "Maximum number of results to return.",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "install_skill_or_agent",
    description:
      "Install a skill or register an MCP server into an OpenCode workspace. For itemType='skill' this writes ${workspacePath}/.opencode/skills/<name>/SKILL.md, downloading it from sourceUrl or generating a documented boilerplate when sourceUrl is omitted. For itemType='mcp-server' this merges mcpConfig into ${workspacePath}/opencode.json under mcp.<name>, creating the file when needed.",
    inputSchema: {
      type: "object",
      properties: {
        workspacePath: {
          type: "string",
          description: "Absolute path (or path relative to the home directory) of the target project.",
        },
        itemType: {
          type: "string",
          enum: ["skill", "mcp-server"],
          description: "What to install.",
        },
        name: {
          type: "string",
          description:
            "Identifier for the skill directory or the mcp config key. Letters, digits, dots, underscores and dashes only.",
        },
        sourceUrl: {
          type: "string",
          description:
            "Optional http(s) URL of a SKILL.md to download. GitHub blob/API URLs are automatically converted to raw URLs. Omit to generate a boilerplate skill.",
        },
        mcpConfig: {
          type: "object",
          description:
            "MCP server entry to merge into opencode.json, e.g. {\"type\":\"local\",\"command\":[\"npx\",\"-y\",\"my-server\"],\"enabled\":true}. Omit to receive a placeholder entry.",
          additionalProperties: true,
        },
      },
      required: ["workspacePath", "itemType", "name"],
      additionalProperties: false,
    },
  },
] as const;

type ToolName = (typeof TOOL_DEFINITIONS)[number]["name"];

function success(text: string, structured?: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text }],
    ...(structured === undefined ? {} : { structuredContent: structured }),
  };
}

function failure(text: string, structured?: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text }],
    isError: true,
    ...(structured === undefined ? {} : { structuredContent: structured }),
  };
}

async function dispatch(name: string, args: Record<string, unknown>) {
  try {
    switch (name) {
      case "analyze_project_needs": {
        const { text, analysis } = (await analyzeProjectNeeds(args)) as { text: string; analysis: Record<string, unknown> };
        return success(text, analysis);
      }
      case "search_skills_and_agents": {
        const { text, result } = (await searchSkillsAndAgents(args)) as { text: string; result: Record<string, unknown> };
        return success(text, result);
      }
      case "install_skill_or_agent": {
        const { text, result } = (await installSkillOrAgent(args)) as { text: string; result: Record<string, unknown> };
        return success(text, result);
      }
      default:
        return failure(`Unknown tool: ${name}`);
    }
  } catch (e) {
    const message = errorMessage(e);
    log(`tool "${name}" failed: ${message}`);
    if (e instanceof Error && e.stack !== undefined) log(e.stack);
    return failure(`Tool "${name}" failed: ${message}`);
  }
}

function createServer(): Server {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFINITIONS.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name as ToolName | string;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    return dispatch(name, args);
  });

  return server;
}

async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();

  const shutdown = (signal: string) => {
    log(`received ${signal}, shutting down`);
    void server.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  try {
    await server.connect(transport);
    log(`v${SERVER_VERSION} ready on stdio (GITHUB_TOKEN ${githubToken() === undefined ? "not set" : "loaded"})`);
  } catch (e) {
    log(`fatal: failed to start stdio transport: ${errorMessage(e)}`);
    process.exit(1);
  }
}

void main();
