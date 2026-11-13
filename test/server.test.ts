import { access, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { builtInPersonaDir } from "../src/personas.js";
import { createServer } from "../src/server.js";
import { startFixtureServer, type FixtureServer } from "./helpers/fixture-server.js";

interface ToolResult {
  isError?: boolean;
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
}

let site: FixtureServer;
let server: McpServer;
let client: Client;
let outDir: string;

beforeAll(async () => {
  site = await startFixtureServer();
});
afterAll(async () => {
  await site.close();
});

beforeEach(async () => {
  outDir = await mkdtemp(path.join(tmpdir(), "pp-server-"));
  server = await createServer({
    target: new URL(site.origin),
    allowOrigins: [],
    allowWrites: false,
    allowWritePaths: [],
    outDir,
    personaDirs: [builtInPersonaDir()],
    runId: "run-1",
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
});
afterEach(async () => {
  await client.close();
  await server.close();
});

async function call(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  return (await client.callTool({ name, arguments: args })) as ToolResult;
}

function text(r: ToolResult): string {
  return r.content
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n");
}

describe("MCP server", () => {
  it("exposes exactly the persona-probe tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        "back",
        "build_report",
        "click",
        "fill",
        "finish_persona",
        "goto",
        "list_personas",
        "press",
        "report_finding",
        "screenshot",
        "snapshot",
        "start_persona",
        "tap",
      ].sort(),
    );
  });

  it("offers one prompt per persona", async () => {
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name)).toContain("probe-as-keyboard-only");
    const prompt = await client.getPrompt({ name: "probe-as-keyboard-only" });
    expect(JSON.stringify(prompt.messages)).toContain("start_persona");
  });

  it("lists personas", async () => {
    expect(text(await call("list_personas"))).toContain("impatient-mobile");
  });

  it("requires an active persona before acting", async () => {
    const r = await call("snapshot");
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/call start_persona first/);
  });

  it("rejects unknown personas", async () => {
    const r = await call("start_persona", { name: "nobody" });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("first-timer");
  });

  it("returns agent-facing errors without crashing the server", async () => {
    await call("start_persona", { name: "keyboard-only" });
    const r = await call("click", { ref: "e1" });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/not available/);
    expect((await call("snapshot")).isError).toBeFalsy();
  });

  it("runs a full persona session and builds a report", async () => {
    const start = await call("start_persona", { name: "first-timer" });
    expect(text(start)).toContain("First-time visitor");
    expect(text(start)).toContain(site.origin);
    const snap = text(await call("snapshot"));
    const ref = snap
      .split("\n")
      .find((l) => l.includes('link "About"'))
      ?.match(/\[ref=([a-z0-9]+)\]/)?.[1];
    expect(ref).toBeDefined();
    expect(text(await call("click", { ref }))).toContain("/about.html");

    const shot = await call("screenshot", { label: "about page" });
    expect(shot.content.some((c) => c.type === "image" && c.mimeType === "image/png")).toBe(true);
    const saved = text(shot).match(/shots\/[a-z0-9-]+\.png/)?.[0];
    expect(saved).toBeDefined();

    const finding = await call("report_finding", {
      severity: "minor",
      category: "content",
      title: "About page is thin",
      steps: ["Open home", "Click About"],
      expected: "Explains the site",
      actual: "One sentence",
      screenshot: saved,
    });
    expect(finding.isError).toBeFalsy();

    expect(text(await call("finish_persona", { summary: "Short visit" }))).toMatch(/finished/);
    expect((await call("snapshot")).isError).toBe(true);

    const report = text(await call("build_report"));
    expect(report).toContain("1 finding");
    await access(path.join(outDir, "run-1", "report.md"));
    await access(path.join(outDir, "run-1", "transcript-first-timer.jsonl"));
  });

  it("routes every action tool to the browser", async () => {
    await call("start_persona", { name: "first-timer" });
    const snap = text(await call("snapshot"));
    const nameRef = snap
      .split("\n")
      .find((l) => l.includes('textbox "Name"'))
      ?.match(/\[ref=([a-z0-9]+)\]/)?.[1];
    expect(text(await call("fill", { ref: nameRef, text: "Ana" }))).toContain("filled");
    expect(text(await call("press", { key: "Tab" }))).toContain("pressed Tab");
    expect(text(await call("goto", { path: "/about.html" }))).toContain("/about.html");
    expect(text(await call("back"))).toContain("went back");
    const tap = await call("tap", { ref: "e1" });
    expect(tap.isError).toBe(true);
    expect(text(tap)).toMatch(/not available/);
  });

  it("replaces the active persona when starting another", async () => {
    await call("start_persona", { name: "first-timer" });
    const second = await call("start_persona", { name: "impatient-mobile" });
    expect(text(second)).toContain("Impatient mobile user");
    expect(text(await call("tap", { ref: "e9999" }))).toMatch(/call snapshot again/);
  });

  it("refuses screenshot paths outside the shots folder in findings", async () => {
    await call("start_persona", { name: "first-timer" });
    const r = await call("report_finding", {
      severity: "info",
      category: "content",
      title: "x",
      steps: ["y"],
      expected: "a",
      actual: "b",
      screenshot: "../../etc/passwd",
    });
    expect(r.isError).toBe(true);
  });
});
