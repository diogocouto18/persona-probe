import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Finding, RunStore, Severity } from "./store.js";

export type MergedFinding = Finding & { personas: string[]; occurrences: number };

export interface ReportMeta {
  target: string;
  runId: string;
  personas: string[];
}

const SEVERITY_ORDER: Record<Severity, number> = { critical: 0, major: 1, minor: 2, info: 3 };

function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizePath(url: string): string {
  try {
    return new URL(url).pathname.replace(/\/+$/, "") || "/";
  } catch {
    return url;
  }
}

/** Merges findings that describe the same problem on the same page. */
export function dedupe(findings: Finding[]): MergedFinding[] {
  const groups = new Map<string, MergedFinding>();
  for (const f of findings) {
    const key = `${f.category}|${normalizePath(f.url)}|${normalizeTitle(f.title)}`;
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, { ...f, personas: [f.persona], occurrences: 1 });
      continue;
    }
    existing.occurrences += 1;
    if (!existing.personas.includes(f.persona)) existing.personas.push(f.persona);
    if (SEVERITY_ORDER[f.severity] < SEVERITY_ORDER[existing.severity]) {
      const { personas, occurrences } = existing;
      groups.set(key, { ...f, personas, occurrences });
    }
  }
  return [...groups.values()];
}

/** Orders merged findings: severity, then how often they were seen, then category. */
export function rank(items: MergedFinding[]): MergedFinding[] {
  return [...items].sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      b.occurrences - a.occurrences ||
      a.category.localeCompare(b.category),
  );
}

/** Escapes untrusted text for safe inclusion in Markdown (including table cells). */
export function escapeMd(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/[`|[\]()!*_#~]/g, "\\$&")
    .replace(/\r?\n/g, " ");
}

export function renderMarkdown(items: MergedFinding[], meta: ReportMeta): string {
  const ranked = rank(items);
  const lines = [
    `# persona-probe report`,
    "",
    `- **Target:** ${escapeMd(meta.target)}`,
    `- **Run:** ${escapeMd(meta.runId)}`,
    `- **Personas:** ${meta.personas.map(escapeMd).join(", ") || "none"}`,
    `- **Findings:** ${ranked.length}`,
    "",
  ];
  if (ranked.length === 0) {
    lines.push("No findings were reported in this run.");
    return lines.join("\n") + "\n";
  }
  lines.push("| # | Severity | Category | Finding | Personas |", "|---|---|---|---|---|");
  ranked.forEach((f, i) => {
    lines.push(
      `| ${i + 1} | ${f.severity} | ${f.category} | ${escapeMd(f.title)} | ${f.personas.map(escapeMd).join(", ")} |`,
    );
  });
  ranked.forEach((f, i) => {
    lines.push(
      "",
      `## ${i + 1}. ${escapeMd(f.title)}`,
      "",
      `- **Severity:** ${f.severity} · **Category:** ${f.category} · **Seen:** ${f.occurrences}×`,
      `- **Page:** ${escapeMd(f.url)}`,
      `- **Expected:** ${escapeMd(f.expected)}`,
      `- **Actual:** ${escapeMd(f.actual)}`,
      "",
      "**Steps to reproduce**",
      "",
      ...f.steps.map((s, j) => `${j + 1}. ${escapeMd(s)}`),
    );
    if (f.screenshot) lines.push("", `![screenshot](${encodeURI(f.screenshot)})`);
  });
  return lines.join("\n") + "\n";
}

/** Builds report.md and report.json from the run's findings. */
export async function buildReport(
  store: RunStore,
  meta: ReportMeta,
): Promise<{ markdownPath: string; jsonPath: string; count: number }> {
  const merged = rank(dedupe(await store.readFindings()));
  await mkdir(store.dir, { recursive: true });
  const markdownPath = path.join(store.dir, "report.md");
  const jsonPath = path.join(store.dir, "report.json");
  await writeFile(markdownPath, renderMarkdown(merged, meta), "utf8");
  await writeFile(jsonPath, JSON.stringify({ ...meta, findings: merged }, null, 2) + "\n", "utf8");
  return { markdownPath, jsonPath, count: merged.length };
}
