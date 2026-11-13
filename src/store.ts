import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { sanitizeName } from "./guards.js";

export type Severity = "critical" | "major" | "minor" | "info";
export type Category = "functional" | "usability" | "accessibility" | "content" | "performance";

export interface Finding {
  id: string;
  persona: string;
  severity: Severity;
  category: Category;
  title: string;
  steps: string[];
  expected: string;
  actual: string;
  url: string;
  screenshot?: string;
  at: string;
}

function timestampId(d: Date): string {
  const pad = (v: number) => String(v).padStart(2, "0");
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

/** Append-only storage for one run: findings, transcripts and screenshots. */
export class RunStore {
  readonly dir: string;

  constructor(outDir: string, runId: string = timestampId(new Date())) {
    this.dir = path.resolve(outDir, sanitizeName(runId));
  }

  /** Resolves a path inside the run directory, refusing anything that escapes it. */
  private inside(...segments: string[]): string {
    const p = path.resolve(this.dir, ...segments);
    if (p !== this.dir && !p.startsWith(this.dir + path.sep)) {
      throw new Error(`Path escapes run directory: ${p}`);
    }
    return p;
  }

  private async append(file: string, value: unknown): Promise<void> {
    await mkdir(path.dirname(file), { recursive: true });
    await appendFile(file, JSON.stringify(value) + "\n", "utf8");
  }

  async appendFinding(f: Omit<Finding, "id" | "at">): Promise<Finding> {
    const finding: Finding = { ...f, id: randomUUID(), at: new Date().toISOString() };
    await this.append(this.inside("findings.jsonl"), finding);
    return finding;
  }

  async appendTranscript(persona: string, entry: unknown): Promise<void> {
    await this.append(this.inside(`transcript-${sanitizeName(persona)}.jsonl`), entry);
  }

  screenshotPath(persona: string, label: string): string {
    return this.inside("shots", `${sanitizeName(persona)}-${sanitizeName(label)}.png`);
  }

  async readFindings(): Promise<Finding[]> {
    let text: string;
    try {
      text = await readFile(this.inside("findings.jsonl"), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    return text
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as Finding);
  }
}
