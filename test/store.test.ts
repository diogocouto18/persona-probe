import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { RunStore } from "../src/store.js";

async function newStore(): Promise<RunStore> {
  return new RunStore(await mkdtemp(path.join(tmpdir(), "pp-store-")), "run-1");
}

const base = {
  persona: "first-timer",
  severity: "major" as const,
  category: "usability" as const,
  title: "Menu does nothing",
  steps: ["Open home", "Click Menu"],
  expected: "Menu opens",
  actual: "Nothing happens",
  url: "http://localhost:3000/",
};

describe("RunStore", () => {
  it("defaults the run id to a timestamp", async () => {
    const store = new RunStore(await mkdtemp(path.join(tmpdir(), "pp-store-")));
    expect(path.basename(store.dir)).toMatch(/^\d{8}-\d{6}$/);
  });

  it("appends findings with ids and timestamps", async () => {
    const store = await newStore();
    const a = await store.appendFinding(base);
    const b = await store.appendFinding({ ...base, title: "Other" });
    expect(a.id).not.toBe(b.id);
    expect(Date.parse(a.at)).not.toBeNaN();
    const lines = (await readFile(path.join(store.dir, "findings.jsonl"), "utf8"))
      .trim()
      .split("\n");
    expect(lines).toHaveLength(2);
    expect(await store.readFindings()).toHaveLength(2);
  });

  it("returns no findings for an empty run", async () => {
    expect(await (await newStore()).readFindings()).toEqual([]);
  });

  it("writes transcripts per persona", async () => {
    const store = await newStore();
    await store.appendTranscript("keyboard-only", { tool: "press", key: "Tab" });
    const text = await readFile(path.join(store.dir, "transcript-keyboard-only.jsonl"), "utf8");
    expect(JSON.parse(text.trim())).toEqual({ tool: "press", key: "Tab" });
  });

  it("keeps screenshot paths inside the run directory", async () => {
    const store = await newStore();
    const p = store.screenshotPath("Key Board/..", "../x");
    expect(p.startsWith(path.join(store.dir, "shots") + path.sep)).toBe(true);
    expect(p).toMatch(/key-board.*x\.png$/);
  });

  it("sanitizes persona names used in transcript file names", async () => {
    const store = await newStore();
    await store.appendTranscript("../../evil", { ok: true });
    const text = await readFile(path.join(store.dir, "transcript-evil.jsonl"), "utf8");
    expect(text).toContain('"ok":true');
  });
});
