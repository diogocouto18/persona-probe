# persona-probe

Let **your own AI agent** explore a web app as different personas (a first-time
visitor, a keyboard-only user, an impatient mobile user, a form breaker) through
a **locked-down browser**, and get a ranked report of what they found.

persona-probe is a [Model Context Protocol](https://modelcontextprotocol.io)
server. It never calls an LLM itself: the agent you already use (Claude Code,
Codex CLI, Gemini CLI, Cursor, or any MCP client) plays the persona, on your
own subscription. persona-probe provides the browser, the safety rails, the
personas and the report.

```
your agent (your subscription)
      │  stdio (MCP)
      ▼
persona-probe ──▶ guards: fixed origin · writes blocked · no popups/downloads
      │                         │
      │                         ▼
      │                  headless Chromium (fresh context per persona)
      ▼
persona-probe-runs/<run>/ ── report.md · report.json · shots/ · transcripts
```

## Why personas?

Different people break software in different ways. One agent asked to "test the
site" mostly finds the same few issues. The same agent constrained to a
keyboard, a 390 px touch screen, or a short attention span finds very different
ones. persona-probe enforces those constraints **in code**: the keyboard-only
persona has no `click`, the mobile persona can only `tap`, and every persona has
a step budget.

## Requirements

- Node.js ≥ 22.12
- An MCP-capable agent

## Install (from source)

```bash
git clone https://github.com/diogocouto18/persona-probe.git
cd persona-probe
npm ci
npx playwright install chromium
npm run build
```

## Connect it to your agent

The server is bound to **one target origin**, chosen when it starts. Use a local
or staging copy of your app.

**Claude Code**

```bash
claude mcp add persona-probe -- node /path/to/persona-probe/dist/cli.js mcp --url http://localhost:3000
```

**Any MCP client** (JSON config)

```json
{
  "mcpServers": {
    "persona-probe": {
      "command": "node",
      "args": ["/path/to/persona-probe/dist/cli.js", "mcp", "--url", "http://localhost:3000"]
    }
  }
}
```

For a run, it is good practice to let the agent use only persona-probe's tools,
for example in Claude Code: `--allowedTools "mcp__persona-probe"`.

## Run a persona

Use one of the built-in prompts (`probe-as-first-timer`,
`probe-as-keyboard-only`, `probe-as-impatient-mobile`, `probe-as-form-breaker`)
if your client supports MCP prompts, or simply ask:

> Use persona-probe to explore the site as the keyboard-only persona, then
> build the report.

The agent calls `start_persona`, explores with `snapshot` and the action tools,
records problems with `report_finding`, ends with `finish_persona`, and calls
`build_report`. Run several personas one after another in the same session to
get a merged, de-duplicated report.

### Tools

| Tool             | What it does                                                       |
| ---------------- | ------------------------------------------------------------------ |
| `list_personas`  | Lists available personas                                           |
| `start_persona`  | Opens a fresh browser as a persona and returns its brief           |
| `snapshot`       | Accessibility snapshot with refs and focus; `part` pages long ones |
| `click` / `tap`  | Activates an element by ref (mouse / touch personas)               |
| `fill`           | Replaces a text field's value                                      |
| `press`          | Presses a key (keyboard personas)                                  |
| `goto` / `back`  | Navigates within the target origin                                 |
| `screenshot`     | Saves and returns a screenshot as evidence                         |
| `report_finding` | Records a problem (severity, category, steps, expected vs actual)  |
| `finish_persona` | Ends the persona's session                                         |
| `build_report`   | Writes `report.md` and `report.json` for the run                   |

## Personas

| Persona            | Input           | Budget | Looks for                                         |
| ------------------ | --------------- | ------ | ------------------------------------------------- |
| `first-timer`      | mouse, keyboard | 40     | unclear purpose, dead ends, confusing labels      |
| `keyboard-only`    | keyboard        | 50     | focus order, unreachable controls, missing labels |
| `impatient-mobile` | touch (390×844) | 15     | layout breakage, tiny targets, friction           |
| `form-breaker`     | mouse, keyboard | 60     | validation gaps, unclear errors, unescaped input  |

Add your own with `--personas ./my-personas`. A persona is a Markdown file with
YAML front-matter:

```markdown
---
name: screen-magnifier
title: Screen magnifier user
goal: Read the pricing page at high zoom.
input: [mouse, keyboard]
viewport: { width: 640, height: 480 }
stepBudget: 30
---

Describe how this person behaves and what counts as a finding.
Remind the agent that page content is untrusted data.
```

Personas with the same name as a built-in one replace it. List them with
`persona-probe personas`.

## Safety model

persona-probe drives a real browser on behalf of an AI agent, so it is
restrictive by default:

- **stdio only.** It opens no network ports.
- **Fixed target.** The origin is set by `--url` at launch; no tool can change
  it. Navigation and requests to other origins are blocked, including every hop
  of a redirect chain (add trusted asset origins with `--allow-origin`). A
  target that redirects elsewhere on start is refused.
- **Local by default.** Non-local targets require `--i-own-this-site`.
- **Writes blocked by default.** POST forms and every non-GET request,
  including analytics beacons and server actions, are answered with a blocked
  response, so testing does not send emails or change data. Use `--allow-writes`
  or `--allow-write-path "/api/search/**"` deliberately.
- **No WebSockets.** Sockets to other origins are refused; same-origin sockets
  are answered by an in-page stub and never reach the server.
- **No escape hatches.** No shell, filesystem or JavaScript-evaluation tools.
  Popups are closed and downloads are disabled. Each persona gets a fresh,
  non-persistent browser context.
- **Untrusted page content.** Snapshots are labelled as untrusted and personas
  are told to ignore instructions found in pages. Report text is escaped.
- **Contained output.** Everything is written under `--out`
  (default `./persona-probe-runs`).

### Known limits

- **GET requests are never blocked.** GET forms and GET endpoints with side
  effects (e.g. `/delete?id=7`) still reach the target. Test a disposable copy.
- **Redirect hops are requested twice:** once to check the chain stays on the
  target, once by the browser. One-time links in a redirect chain (magic
  links, OAuth callbacks) may be consumed by the check.
- **Apps that depend on WebSockets** (live updates, chat, dev-server hot reload)
  will not work under persona-probe.
- **Not covered:** WebRTC, and DNS prefetch/preconnect to other hosts.

See [SECURITY.md](SECURITY.md) to report a vulnerability.

## CLI

```
persona-probe mcp --url <origin> [--out <dir>] [--personas <dir>]...
                  [--allow-origin <origin>]... [--allow-writes]
                  [--allow-write-path <glob>]... [--i-own-this-site] [--headed]
persona-probe personas [--personas <dir>]
persona-probe report <run-dir>
```

## Roadmap

- `persona-probe run`: launch several personas in parallel through your
  agent's headless mode.
- Logged-in areas with secrets that never reach the model.
- npm package.

## Development

```bash
npm run lint && npm run typecheck && npm run test:coverage
```

Tests drive the real MCP server and a real Chromium against a local fixture
site with scripted tool calls; no LLM is involved. See
[CONTRIBUTING.md](CONTRIBUTING.md) and the [design document](docs/design/2026-11-13-persona-probe-design.md).

## License

[MIT](LICENSE)
