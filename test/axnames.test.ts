import { describe, expect, it } from "vitest";
import { annotateUnnamed, unnamedInteractiveRefs } from "../src/axnames.js";

const aria = [
  "- main [ref=e1]:",
  "  - link [ref=e2] [cursor=pointer]:",
  "    - /url: /about.html",
  '    - heading "persona-probe" [level=3] [ref=e3]',
  "  - button [ref=e4]",
  '  - button "Close dialog" [ref=e5]',
  "  - textbox [ref=e6]",
].join("\n");

describe("unnamedInteractiveRefs", () => {
  it("finds interactive nodes shown without a name", () => {
    expect(unnamedInteractiveRefs(aria)).toEqual(["e2", "e4", "e6"]);
  });

  it("ignores named and non-interactive nodes", () => {
    expect(unnamedInteractiveRefs('- button "Ok" [ref=e1]\n- generic [ref=e2]')).toEqual([]);
  });
});

describe("annotateUnnamed", () => {
  it("inserts the browser-computed name and marks nodes that have none", () => {
    const out = annotateUnnamed(
      aria,
      new Map([
        ["e2", "persona-probe Card description text"],
        ["e4", ""],
      ]),
    );
    expect(out).toContain(
      '  - link "persona-probe Card description text" [ref=e2] [cursor=pointer]:',
    );
    expect(out).toContain("  - button [ref=e4] [no accessible name]");
    expect(out).toContain('  - button "Close dialog" [ref=e5]');
    // Not resolved (e.g. over the lookup cap): left as it was.
    expect(out).toContain("  - textbox [ref=e6]");
  });

  it("truncates long names and escapes quotes", () => {
    const out = annotateUnnamed(
      "- link [ref=e1]",
      new Map([["e1", `say "hi" ${"x".repeat(200)}`]]),
    );
    const name = out.match(/^- link "(.*)" \[ref=e1\]$/)?.[1] ?? "";
    expect(name.startsWith('say \\"hi\\"')).toBe(true);
    expect(name.endsWith("…")).toBe(true);
    expect(name.length).toBeLessThanOrEqual(122);
  });
});
