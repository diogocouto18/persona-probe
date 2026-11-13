# persona-probe — Design

Date: 2026-11-13 · Status: approved, v1 implemented

## 1. Intent

`persona-probe` lets an AI agent explore a **web app** while playing a distinct
**persona** (first-time visitor, keyboard-only user, impatient mobile user,
form breaker), through a locked-down headless browser, and turns what it finds
into one prioritized report (Markdown + JSON, screenshots, reproduction steps).

It ships as a **stdio MCP server**. The AI that plays the personas is whatever
agent the user already has (Claude Code, Codex CLI, Gemini CLI, Cursor, any MCP
client), running on the user's own subscription. persona-probe itself never
calls an LLM, so it costs the maintainer and the user nothing beyond the
subscription they already pay for.

Why: a public portfolio project, validated on a real app rather than a toy. It
was designed after reviewing existing open-source persona-playtesting tools,
with a security-first take on the same idea: no network listeners, a fixed
target, writes blocked by default.

Key lesson from prior art: **persona variety matters more than agent
cleverness** (one tool reported bug recall going from 0.38 to 1.0 just by
rotating personas). So persona constraints are enforced in code, not just
described in a prompt.

## 2. Goals (v1)

1. `persona-probe mcp --url <origin> [--out <dir>]` starts a stdio MCP server
   bound to one target origin. Any MCP client can add it, e.g.
   `claude mcp add persona-probe -- node <clone>/dist/cli.js mcp --url http://localhost:3000`.
2. The agent picks a persona (`start_persona`), explores through the browser
   tools, records problems with `report_finding`, and ends with
   `finish_persona`. `build_report` merges all personas of the run.
3. Perception through Playwright's ARIA snapshot (structured text, model
   friendly, cheap in tokens), with the focused element marked; screenshots
   saved as evidence and returned as images to clients that support them.
4. Personas are plain files (Markdown + YAML front-matter): goal, behaviour,
   device profile (viewport, touch, reduced motion), allowed input modes, step
   budget. Four built in; users can add their own with `--personas <dir>`.
5. Findings are structured (severity, category, title, steps, expected vs
   actual, URL, screenshot), de-duplicated across personas and ranked.
6. First real validation: three personas (first-timer, keyboard-only,
   impatient-mobile) against a **local** dev-hub (`http://localhost:3000`),
   **public pages only**, driven by Claude Code, producing findings a human
   reviewer judges useful.

## 3. Non-goals (v1)

- Calling any LLM API directly; API keys of any kind.
- Logged-in areas / credentials (planned for v2 with `fill_secret`).
- Orchestrating several personas in parallel (v1.x runner, see §6 B).
- Games, `<canvas>`-only UIs, native apps; load, performance or security testing.
- npm publishing (planned once proven on dev-hub; v1 runs from a clone).

## 4. Anti-goals (failure even if it "works")

- Driving a **production** site by accident (analytics pollution, rate limits,
  real emails or form submissions).
- Costing the maintainer or the user money beyond their existing subscription.
- Becoming the kind of local-security liability found in the audit:
  network-listening servers, serving whole directories, executing code from the
  target project, broad agent permissions committed to the repo.
- Letting the page under test steer the agent outside the target (prompt
  injection with real effect).

## 5. Constraints

### Security (first-class)

- **stdio only.** No HTTP/TCP listener anywhere in the product.
- **Target fixed at launch, not by the agent.** `--url` sets the origin when the
  server starts; no tool can change it. `goto` accepts same-origin paths only.
- **Origin allowlist enforced in the browser context** (request routing):
  top-level navigation and requests to other origins are blocked; third-party
  assets only via explicit `--allow-origin`. Downloads disabled; popups/new tabs
  closed.
- **Production guard:** non-loopback targets require `--i-own-this-site`, else
  the server refuses to start.
- **Write guard, off by default everywhere (loopback included):** with writes
  off, form-submission navigations and same-origin non-GET `fetch`/XHR
  (including server actions and beacons) are answered with a synthetic blocked
  response, and the next tool result tells the agent "write blocked by guard".
  `--allow-writes` lifts it; `--allow-write-path <glob>` allows specific paths.
- **Page content is untrusted data.** Tool results label page text as such;
  tools can do nothing outside the sandboxed browser context; finding text is
  escaped when rendered.
- **Fresh, non-persistent browser context per persona.**
- **Output confined** to `--out` (default `./persona-probe-runs/`); file names
  sanitized; nothing written elsewhere.
- Minimal runtime dependencies (`@modelcontextprotocol/sdk`, `playwright`,
  `zod`, a YAML parser), pinned by lockfile; no install scripts. The browser is
  installed explicitly with `npx playwright install chromium`.
- The README recommends restricting the driving agent to persona-probe's tools
  for a run (e.g. Claude Code `--allowedTools "mcp__persona-probe__*"`).

### Persona enforcement in code

- Each persona declares `input: [keyboard | mouse | touch]`. Tools outside the
  persona's modes return "not available for this persona" (keyboard-only gets
  no `click`/`tap`; mobile gets `tap`, not `click`).
- Server-side step budget per persona; after it, action tools return "budget
  exhausted, call finish_persona".

### Scalability / token use

- One active persona per MCP connection in v1; browser context closed on
  `finish_persona` or disconnect.
- Snapshots trimmed (interactive subtree first, length cap) to keep the agent's
  token use on the user's subscription reasonable.
- Findings appended to disk as they arrive; reports built from disk.

### Repository

MIT license; default branch `master`; English only. Node ≥ 22.12 (Node 20 is
end-of-life), TypeScript, ESM.

## 6. Approaches considered

| Approach                                                                                                                         | Trade-off                                                                                                             |
| -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Standalone CLI calling an LLM API                                                                                                | Considered first, then **dropped**: every run costs API money; the goal is zero cost, using the user's own AI.        |
| **A. Stdio MCP server, agent-agnostic** — **chosen for v1**                                                                      | Zero cost, works with any MCP client, no network listener. Multi-persona orchestration left to the agent or the user. |
| B. A + `persona-probe run` spawning the agent CLI headless (`claude -p` first) per persona, in parallel, restricted to our tools | One command, parallel personas, still zero cost. More work and per-CLI flags. **Planned right after v1**, built on A. |
| Claude Code skill only                                                                                                           | Locks users into one agent; rejected as the core, may come as a thin wrapper later.                                   |

Decided (2026-11-13): A in v1 then B; the author's own site (dev-hub) as the
first real target, public pages only; clone-based distribution, npm later.

## 7. Design

### 7.1 Architecture

```
MCP client (user's agent, user's subscription)
        │ stdio (JSON-RPC)
        ▼
persona-probe mcp ──▶ guards (origin, write, prod) ──▶ Playwright browser context (per persona)
        │
        └──▶ run store (--out/<run-id>/): findings.jsonl, shots/, transcript.jsonl ──▶ report.md / report.json
```

Modules (small, unit-testable): `cli` (`node:util` parseArgs; commands `mcp`,
`personas`, `report`), `server` (MCP tool/prompt registration), `guards`,
`browser` (locked-down context, ref→locator mapping, focus marking), `personas`
(Zod-validated loader), `store` (run directory, append-only JSONL), `report`
(dedupe, ranking, escaped rendering).

### 7.2 MCP surface

Tools: `list_personas`, `start_persona(name)` (returns the persona brief,
opens a fresh context at the target), `snapshot`, `click(ref)`, `tap(ref)`,
`fill(ref, text)`, `press(key)`, `goto(path)`, `back`, `screenshot`,
`report_finding(...)`, `finish_persona(summary)`, `build_report`.
Prompts: one per persona (`probe-as-<persona>`), so clients with prompt support
can launch a persona in one step. No shell, filesystem, or JS-evaluation tools.

### 7.3 Built-in personas

1. **first-timer**: never seen the site; work out what it is and reach the main
   call to action. Input: mouse + keyboard.
2. **keyboard-only**: no pointer; judges focus order, visible focus, labels,
   landmarks, skip links. Input: keyboard.
3. **impatient-mobile**: 390×844 touch viewport, small step budget, gives up on
   friction. Input: touch.
4. **form-breaker**: empty, huge, unicode and injection-shaped inputs into every
   form; with writes off it reports client-side validation gaps. Input: mouse +
   keyboard.

### 7.4 Output

`--out/<run-id>/`: `report.md`, `report.json`, `shots/`, per-persona
`findings.jsonl` and `transcript.jsonl` (tool calls and results).

### 7.5 Testing

- Unit (Vitest): guards, persona loading/enforcement, budgets, dedupe/ranking,
  escaping, path sanitizing.
- Integration: a real MCP client (from the SDK) talks to the server over stdio
  with **scripted tool calls** against a fixture site served by the test process
  on an ephemeral `127.0.0.1` port (tests only, never shipped). No LLM involved,
  so CI is deterministic and free.
- Coverage gate in CI.

### 7.6 CI / repo

GitHub Actions: lint, typecheck, unit + integration (with Playwright Chromium)
with coverage gate, secret scan (gitleaks), `npm audit`. Pre-push hook blocks
pushes to `master`; changes via PRs.

### 7.7 First validation on dev-hub

Run dev-hub locally (`next dev`, `http://localhost:3000`, local Postgres), add
persona-probe to an MCP client with writes off, and run first-timer,
keyboard-only and impatient-mobile over public pages. Review the report; useful
findings become dev-hub issues after a human review.

## 8. Left to the builder

Persona prompt wording; snapshot trimming heuristics; focus-marking format;
dedupe similarity threshold; report layout; exact flag names beyond those above.
