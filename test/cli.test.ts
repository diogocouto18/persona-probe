import { execFile, execFileSync } from "node:child_process";
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
