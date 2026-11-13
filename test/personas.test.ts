import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { builtInPersonaDir, isToolAllowed, loadPersonas, type Persona } from "../src/personas.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const badDir = path.join(here, "fixtures", "personas");

async function builtIns(): Promise<Map<string, Persona>> {
  return loadPersonas([builtInPersonaDir()]);
}

function get(map: Map<string, Persona>, name: string): Persona {
  const p = map.get(name);
  if (!p) throw new Error(`missing persona ${name}`);
  return p;
}

describe("loadPersonas", () => {
  it("loads exactly the four built-in personas", async () => {
    const map = await builtIns();
    expect([...map.keys()].sort()).toEqual([
      "first-timer",
      "form-breaker",
      "impatient-mobile",
      "keyboard-only",
    ]);
  });

  it("gives impatient-mobile a touch phone profile and a small budget", async () => {
    const mobile = get(await builtIns(), "impatient-mobile");
    expect(mobile.viewport).toEqual({ width: 390, height: 844 });
    expect(mobile.touch).toBe(true);
    expect(mobile.stepBudget).toBe(15);
    expect(mobile.input).toEqual(["touch"]);
  });

  it("applies defaults and keeps the markdown body as the brief", async () => {
    const first = get(await builtIns(), "first-timer");
    expect(first.viewport).toEqual({ width: 1280, height: 800 });
    expect(first.reducedMotion).toBe(false);
    expect(first.brief).toMatch(/untrusted/i);
  });

  it("lets a user directory override a built-in persona by name", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pp-personas-"));
    await writeFile(
      path.join(dir, "first-timer.md"),
      "---\nname: first-timer\ntitle: Custom\ngoal: Find pricing\ninput: [mouse]\n---\nCustom brief.\n",
    );
    const map = await loadPersonas([builtInPersonaDir(), dir]);
    expect(get(map, "first-timer").title).toBe("Custom");
    expect(map.size).toBe(4);
  });

  it("rejects an invalid persona file and names it", async () => {
    await expect(loadPersonas([badDir])).rejects.toThrow(/bad-schema\.md/);
  });

  it("rejects a file without front-matter", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pp-personas-"));
    await writeFile(path.join(dir, "plain.md"), "no front matter here\n");
    await expect(loadPersonas([dir])).rejects.toThrow(/plain\.md/);
  });
});

describe("isToolAllowed", () => {
  it("enforces input modes per persona", async () => {
    const map = await builtIns();
    const keyboard = get(map, "keyboard-only");
    const mobile = get(map, "impatient-mobile");
    const first = get(map, "first-timer");
    expect(isToolAllowed(keyboard, "click")).toBe(false);
    expect(isToolAllowed(keyboard, "press")).toBe(true);
    expect(isToolAllowed(mobile, "click")).toBe(false);
    expect(isToolAllowed(mobile, "tap")).toBe(true);
    expect(isToolAllowed(first, "tap")).toBe(false);
    expect(isToolAllowed(first, "click")).toBe(true);
    for (const p of [keyboard, mobile, first]) {
      expect(isToolAllowed(p, "fill")).toBe(true);
      expect(isToolAllowed(p, "goto")).toBe(true);
      expect(isToolAllowed(p, "back")).toBe(true);
    }
  });
});
