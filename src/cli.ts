#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { GuardError, parseTarget } from "./guards.js";
import { builtInPersonaDir, loadPersonas } from "./personas.js";
import { buildReport } from "./report.js";
import { createServer } from "./server.js";
import { RunStore } from "./store.js";
import { VERSION } from "./version.js";

const USAGE = `persona-probe ${VERSION}

Usage:
  persona-probe mcp --url <origin> [options]   Start the stdio MCP server
  persona-probe personas [--personas <dir>]    List available personas
  persona-probe report <run-dir>               Rebuild report.md/report.json for a run

Options for mcp:
  --url <origin>             Target web app (loopback unless --i-own-this-site)
  --out <dir>                Output directory (default: ./persona-probe-runs)
  --personas <dir>           Extra persona directory (repeatable; overrides by name)
  --allow-origin <origin>    Extra origin the browser may load (repeatable)
  --allow-writes             Allow form submissions and non-GET requests
  --allow-write-path <glob>  Allow writes to matching paths only (repeatable)
  --i-own-this-site          Required for non-local targets
  --headed                   Show the browser window

  -h, --help                 Show this help
  -v, --version              Show the version
`;

/** Exit code 2 = usage or guard error. */
class UsageError extends Error {}

function fail(message: string): never {
  throw new UsageError(message);
}

function parseOrigins(values: string[]): string[] {
  return values.map((v) => {
    try {
      return new URL(v).origin;
    } catch {
      return fail(`Invalid --allow-origin: ${v}`);
    }
  });
}

async function main(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      url: { type: "string" },
      out: { type: "string", default: "./persona-probe-runs" },
      personas: { type: "string", multiple: true, default: [] },
      "allow-origin": { type: "string", multiple: true, default: [] },
      "allow-writes": { type: "boolean", default: false },
      "allow-write-path": { type: "string", multiple: true, default: [] },
      "i-own-this-site": { type: "boolean", default: false },
      headed: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
      version: { type: "boolean", short: "v", default: false },
    },
  });

  if (values.version) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  const [command, ...rest] = positionals;
  if (values.help || !command) {
    process.stdout.write(USAGE);
    return;
  }

  const personaDirs = [builtInPersonaDir(), ...values.personas.map((d) => path.resolve(d))];

  switch (command) {
    case "personas": {
      const personas = await loadPersonas(personaDirs);
      for (const p of personas.values()) {
        process.stdout.write(`${p.name} — ${p.title} — input: ${p.input.join(", ")}\n`);
      }
      return;
    }
    case "report": {
      const runDir = rest[0] ?? fail("Usage: persona-probe report <run-dir>");
      const resolved = path.resolve(runDir);
      const store = new RunStore(path.dirname(resolved), path.basename(resolved));
      let target = "unknown";
      let personas: string[];
      try {
        const prev = JSON.parse(await readFile(path.join(store.dir, "report.json"), "utf8"));
        target = String(prev.target ?? target);
        personas = Array.isArray(prev.personas) ? prev.personas.map(String) : [];
      } catch {
        personas = [...new Set((await store.readFindings()).map((f) => f.persona))];
      }
      const out = await buildReport(store, { target, runId: path.basename(store.dir), personas });
      process.stdout.write(`${out.count} findings → ${out.markdownPath}\n`);
      return;
    }
    case "mcp": {
      if (!values.url) fail("mcp requires --url <origin>");
      const target = parseTarget(values.url, { iOwnThisSite: values["i-own-this-site"] });
      const server = await createServer({
        target,
        allowOrigins: parseOrigins(values["allow-origin"]),
        allowWrites: values["allow-writes"],
        allowWritePaths: values["allow-write-path"],
        headless: !values.headed,
        outDir: path.resolve(values.out),
        personaDirs,
      });
      await server.connect(new StdioServerTransport());
      process.stderr.write(`persona-probe ${VERSION}: MCP server ready for ${target.origin}\n`);
      let closing = false;
      const shutdown = () => {
        if (closing) return;
        closing = true;
        void server.close().finally(() => process.exit(0));
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
      // The stdio transport does not notice a client that goes away; stdin closing does.
      process.stdin.on("end", shutdown);
      process.stdin.on("close", shutdown);
      return;
    }
    default:
      fail(`Unknown command "${command}". Run persona-probe --help.`);
  }
}

main(process.argv.slice(2)).catch((err: unknown) => {
  const usage =
    err instanceof UsageError ||
    err instanceof GuardError ||
    (err as { code?: string }).code?.startsWith("ERR_PARSE_ARGS");
  process.stderr.write(`persona-probe: ${(err as Error).message}\n`);
  process.exit(usage ? 2 : 1);
});
