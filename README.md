# opencode-skill-hub

An [MCP](https://modelcontextprotocol.io) server (stdio transport) that acts as an automated skill and agent manager for OpenCode projects.

It answers three questions, in order:

1. **What does this project need?** — `analyze_project_needs` inspects dependency manifests and config files, then proposes the specialised skills/agents the project is missing.
2. **Does it already exist?** — `search_skills_and_agents` searches GitHub for real `SKILL.md` files and MCP server configurations.
3. **Put it in place** — `install_skill_or_agent` writes the skill to `.opencode/skills/<name>/SKILL.md` or registers the MCP server in `opencode.json`.

## Install

```bash
npm install
npm run build     # tsc -> dist/
```

## Register with OpenCode

Add the server to your project's `opencode.json` (see the bundled sample):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "opencode-skill-hub": {
      "type": "local",
      "command": ["npx", "-y", "tsx", "src/index.ts"],
      "enabled": true
    }
  }
}
```

For a global install, register the compiled entrypoint instead:

```json
"command": ["node", "/absolute/path/to/opencode-skill-hub/dist/index.js"]
```

### `GITHUB_TOKEN`

GitHub's **code search** API requires authentication, and it is the only way to find actual `SKILL.md` paths. Without a token the server still works — it falls back to repository search and says so in the tool output.

| Variable | Purpose |
| --- | --- |
| `GITHUB_TOKEN` | PAT with `public_repo` (classic) or no scopes (fine-grained). Raises rate limits and enables code search. |
| `GH_TOKEN` | Used as a fallback if `GITHUB_TOKEN` is unset. |

## Tools

### `analyze_project_needs`

```jsonc
// input
{ "workspacePath": "C:/dev/my-app" }
```

Scans `package.json`, `Cargo.toml`, `pyproject.toml`, `go.mod`, `requirements.txt` plus cross-cutting signals (Dockerfiles, `tsconfig.json`, `prisma/schema.prisma`, `.github/workflows`, monorepo manifests). Returns detected stacks, frameworks, dependency summaries, existing OpenCode assets, and a priority-ranked list of needs — each with a `searchQuery` you can feed straight into the next tool.

### `search_skills_and_agents`

```jsonc
// input
{ "query": "prisma migrations", "searchType": "all", "limit": 10 }
// searchType: "skill" | "mcp-server" | "all"
```

Each result carries `fullName`, `path`, `htmlUrl` and a `downloadUrl` on `raw.githubusercontent.com`, so it can be piped straight into `install_skill_or_agent`.

### `install_skill_or_agent`

```jsonc
// install a skill
{ "workspacePath": "C:/dev/my-app", "itemType": "skill", "name": "prisma-migrations",
  "sourceUrl": "https://raw.githubusercontent.com/owner/repo/main/.claude/skills/prisma-migrations/SKILL.md" }

// scaffold a skill locally (no download)
{ "workspacePath": "C:/dev/my-app", "itemType": "skill", "name": "my-convention" }

// register an MCP server
{ "workspacePath": "C:/dev/my-app", "itemType": "mcp-server", "name": "context7",
  "mcpConfig": { "type": "local", "command": ["npx", "-y", "@upstash/context7-mcp"], "enabled": true } }
```

- **skill** → writes `${workspacePath}/.opencode/skills/${name}/SKILL.md`. Omit `sourceUrl` to get a documented boilerplate with YAML frontmatter to fill in.
- **mcp-server** → merges `mcpConfig` into `${workspacePath}/opencode.json` under `mcp.${name}`, creating the file (with `$schema`) if needed and preserving every other key.

## Safety behaviour

- All logging goes to **stderr**; stdout is reserved for JSON-RPC.
- `name` must match `^[a-zA-Z0-9][a-zA-Z0-9._-]*$`, and the resolved skill path is re-checked against the skills root to block traversal.
- Remote downloads are capped at 2 MiB, time out after 20 s, and are rejected if they look like an HTML error page or GitHub's `404: Not Found` body.
- A malformed `opencode.json` is **never** overwritten — the parse error is returned instead.
- Every tool returns `isError: true` with a readable message rather than throwing across the transport.

## Development

```bash
npm run dev        # tsx watch-free run of src/index.ts
npm run typecheck  # tsc --noEmit
npm run build      # emit dist/
```
