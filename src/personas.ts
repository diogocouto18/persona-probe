import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

export type InputMode = "keyboard" | "mouse" | "touch";
export type ActionTool = "click" | "tap" | "fill" | "press" | "goto" | "back";

export interface Persona {
  name: string;
  title: string;
  goal: string;
  input: InputMode[];
  viewport: { width: number; height: number };
  touch: boolean;
  reducedMotion: boolean;
  stepBudget: number;
  brief: string;
}

const frontMatterSchema = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, "lowercase letters, digits and dashes"),
  title: z.string().min(1),
  goal: z.string().min(1),
  input: z.array(z.enum(["keyboard", "mouse", "touch"])).min(1),
  viewport: z
    .object({ width: z.number().int().min(240), height: z.number().int().min(240) })
    .default({ width: 1280, height: 800 }),
  touch: z.boolean().default(false),
  reducedMotion: z.boolean().default(false),
  stepBudget: z.number().int().positive().max(500).default(40),
});

const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/** Directory holding the personas shipped with the package. */
export function builtInPersonaDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "personas");
}

async function parsePersonaFile(file: string): Promise<Persona> {
  const raw = await readFile(file, "utf8");
  const match = FRONT_MATTER.exec(raw);
  if (!match) throw new Error(`Invalid persona file ${file}: missing YAML front-matter`);
  let data: unknown;
  try {
    data = parseYaml(match[1] ?? "");
  } catch (err) {
    throw new Error(`Invalid persona file ${file}: ${(err as Error).message}`, { cause: err });
  }
  const result = frontMatterSchema.safeParse(data);
  if (!result.success) {
    const issue = result.error.issues[0];
    const where = issue?.path.join(".") || "front-matter";
    throw new Error(`Invalid persona file ${file}: ${where}: ${issue?.message ?? "invalid"}`);
  }
  return { ...result.data, brief: (match[2] ?? "").trim() };
}

/** Loads persona files from each directory in order; later directories override by name. */
export async function loadPersonas(dirs: string[]): Promise<Map<string, Persona>> {
  const personas = new Map<string, Persona>();
  for (const dir of dirs) {
    const entries = (await readdir(dir)).filter((f) => f.endsWith(".md")).sort();
    for (const entry of entries) {
      const persona = await parsePersonaFile(path.join(dir, entry));
      personas.set(persona.name, persona);
    }
  }
  return personas;
}

/** Whether a persona's declared input modes permit an action tool. */
export function isToolAllowed(p: Persona, tool: ActionTool): boolean {
  switch (tool) {
    case "click":
      return p.input.includes("mouse");
    case "tap":
      return p.input.includes("touch");
    case "press":
      return p.input.includes("keyboard");
    default:
      return true;
  }
}
