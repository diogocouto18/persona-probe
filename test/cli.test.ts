import { execFile, execFileSync, spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startFixtureServer, type FixtureServer } from "./helpers/fixture-server.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "dist", "cli.js");
const run = promisify(execFile);
let site: FixtureServer;

beforeAll(async () => {
  execFileSync(
    process.execPath,
    [path.join(root, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.build.json"],
    {
      cwd: root,
    },
  );
  site = await startFixtureServer();
}, 120_000);
afterAll(async () => {
  await site.close();
});

describe("cli", () => {
  it("prints the version", async () => {
    const { stdout } = await run(process.execPath, [cli, "--version"]);
    expect(stdout.trim()).toBe("0.1.0");
  });

  it("lists the built-in personas", async () => {
    const { stdout } = await run(process.execPath, [cli, "personas"]);
    for (const name of ["first-timer", "keyboard-only", "impatient-mobile", "form-breaker"]) {
      expect(stdout).toContain(name);
    }
  });

  it("refuses a non-local target without --i-own-this-site", async () => {
    await expect(
      run(process.execPath, [cli, "mcp", "--url", "https://example.com"]),
    ).rejects.toMatchObject({ code: 2, stderr: expect.stringContaining("--i-own-this-site") });
  });

  it("requires --url for mcp", async () => {
    await expect(run(process.execPath, [cli, "mcp"])).rejects.toMatchObject({ code: 2 });
  });

  it("rejects unknown commands", async () => {
    await expect(run(process.execPath, [cli, "nope"])).rejects.toMatchObject({ code: 2 });
  });

  it("exits and closes the browser when the client closes stdin", async () => {
    const child = spawn(process.execPath, [cli, "mcp", "--url", site.origin, "--out", tmpdir()], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const lines: string[] = [];
    let buffer = "";
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const parts = buffer.split("\n");
      buffer = parts.pop() ?? "";
      lines.push(...parts.filter(Boolean));
    });
    const send = (msg: unknown) => child.stdin.write(JSON.stringify(msg) + "\n");
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "t", version: "0" },
      },
    });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "start_persona", arguments: { name: "first-timer" } },
    });
    const deadline = Date.now() + 30_000;
    while (!lines.some((l) => l.includes('"id":2')) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(lines.some((l) => l.includes('"id":2'))).toBe(true);
    const exited = new Promise<number | null>((resolve) =>
      child.on("exit", (code) => resolve(code)),
    );
    child.stdin.end();
    const code = await Promise.race([
      exited,
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 10_000)),
    ]);
    if (code === "timeout") child.kill("SIGKILL");
    expect(code).toBe(0);
  }, 60_000);

  it("serves MCP over stdio", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [cli, "mcp", "--url", site.origin],
      stderr: "pipe",
    });
    const client = new Client({ name: "cli-test", version: "0.0.0" });
    await client.connect(transport);
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(13);
    await client.close();
  });
});
